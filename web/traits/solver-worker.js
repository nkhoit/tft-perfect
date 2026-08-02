// solver-worker.js — proves the optimum with a MILP solver (HiGHS via WASM).
//
// Runs alongside the DFS shards in worker.js. The DFS is good at enumerating
// many boards but its bounds are too loose to prove optimality inside a user's
// patience; HiGHS proves the ceiling in ~100-400ms. We emit rows in the exact
// shape worker.js emits so mergeSearchResults() can combine them blindly.
//
// The WASM payload is ~1.1MB gzipped and is fetched only when a search actually
// runs, so the landing path is unaffected.

importScripts('search-utils.js', 'board-score.js', 'lp-model.js', 'vendor/highs.js');

let DB = null;
let TABLES = null;
let highsPromise = null;

// Module is the Emscripten factory from vendor/highs.js.
function loadHighs() {
  if (!highsPromise) {
    highsPromise = Module({
      // The worker's base URL is /traits/, so the wasm sits under vendor/.
      locateFile: file => (file.endsWith('.wasm') ? 'vendor/' + file : file),
    });
  }
  return highsPromise;
}

async function solve(opts, onProgress) {
  const highs = await loadHighs();
  const started = performance.now();
  const budget = Number.isFinite(opts.solverBudgetMs) && opts.solverBudgetMs > 0
    ? opts.solverBudgetMs
    : 3000;
  const want = Math.max(1, opts.solverRows || 8);

  const rows = [];
  const seenSignature = new Set();
  let proved = false;          // did we prove the top row optimal?
  let infeasible = true;

  // Phase 1 — prove the ceiling. Solve the i=0 model for EVERY team-size bonus
  // before showing anything. Each of those solves is fast (~100-400ms) and the
  // best of them is the true optimum, so the board we publish here is the one
  // that will still be on top after the DFS rows merge in.
  //
  // Announcing earlier (after the first bonus) is not safe: a later bonus can
  // beat it, and the user watches the top row change out from under them.
  const rank = SearchUtils.comparator(opts.sortMode, opts.sortMode2);
  const bonuses = LpModel.bonusOptions(TABLES);
  const seeds = new Map();     // bonus -> roster proving that bonus's optimum
  let best = null;

  for (const bonus of bonuses) {
    if (performance.now() - started > budget) break;
    const built = LpModel.buildLP(DB, { ...opts, bonus, cuts: [], tables: TABLES });
    if (!built) continue;
    let solution;
    try {
      solution = highs.solve(built.lp, {
        output_flag: false,
        time_limit: Math.max(0.25, (budget - (performance.now() - started)) / 1000),
        mip_rel_gap: 0,
      });
    } catch (err) {
      // A malformed model or an OOM must not kill the DFS results.
      return { rows: [], proved: false, error: String(err && err.message || err) };
    }
    if (!solution || solution.Status !== 'Optimal') continue;
    const roster = LpModel.rosterOf(solution);
    if (!roster.length) continue;
    const row = BoardScore.scoreRoster(DB, TABLES, roster, opts.emblems, opts.muted);
    // The model enforces the waste cap, but re-check with the shipped scoring
    // rules: if these ever disagree the DFS answer must win, not ours.
    if (row.waste > opts.maxWaste) continue;
    infeasible = false;
    proved = true;
    seeds.set(bonus, roster);
    if (!seenSignature.has(row.signature)) {
      seenSignature.add(row.signature);
      rows.push(row);
    }
    if (!best || rank(row, best) < 0) best = row;
  }

  // Publish the proven optimum now. Enumerating the runners-up costs seconds
  // (each no-good cut makes the next solve harder) and none of them can beat
  // this board, so making the user wait for them is pure latency.
  if (proved && best && onProgress) onProgress([best]);

  // Phase 2 — enumerate runners-up with no-good cuts, per bonus.
  for (const bonus of bonuses) {
    if (performance.now() - started > budget) break;
    if (!seeds.has(bonus)) continue;
    const cuts = [seeds.get(bonus)];
    for (let i = 1; i < want; i++) {
      if (performance.now() - started > budget) break;
      const built = LpModel.buildLP(DB, { ...opts, bonus, cuts, tables: TABLES });
      if (!built) break;
      let solution;
      try {
        solution = highs.solve(built.lp, {
          output_flag: false,
          time_limit: Math.max(0.25, (budget - (performance.now() - started)) / 1000),
          mip_rel_gap: 0,
        });
      } catch (err) {
        break;                 // keep the proven rows we already have
      }
      if (!solution || solution.Status !== 'Optimal') break;
      const roster = LpModel.rosterOf(solution);
      if (!roster.length) break;
      const row = BoardScore.scoreRoster(DB, TABLES, roster, opts.emblems, opts.muted);
      if (row.waste > opts.maxWaste) break;
      if (!seenSignature.has(row.signature)) {
        seenSignature.add(row.signature);
        rows.push(row);
      }
      cuts.push(roster);
    }
  }

  rows.sort(rank);
  return { rows, proved: proved && rows.length > 0, infeasible: infeasible && !rows.length };
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    DB = m.db;
    TABLES = LpModel.tables(DB);
    postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'search') {
    const t0 = performance.now();
    let result;
    try {
      result = await solve(m.opts, rows => {
        // Interim proof — the app can render this while we keep enumerating.
        postMessage({
          type: 'solver', id: m.id, partial: true, proved: true, rows,
          ms: Math.round(performance.now() - t0),
        });
      });
    } catch (err) {
      result = { rows: [], proved: false, error: String(err && err.message || err) };
    }
    postMessage({
      type: 'solver',
      id: m.id,
      ms: Math.round(performance.now() - t0),
      ...result,
    });
  }
};
