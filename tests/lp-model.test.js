// lp-model.test.js — the MILP model must agree with the shipped DFS scoring.
//
// These are the tests that matter: if the model and worker.js ever disagree
// about what a board scores, the "optimal" badge becomes a lie.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'traits');
const SearchUtils = require('../web/traits/search-utils.js');
const LpModel = require('../web/traits/lp-model.js');
const db = JSON.parse(fs.readFileSync(path.join(WEB, 'data.json'), 'utf8'));
const T = LpModel.tables(db);
const nC = db.champions.length;
const allPool = [...Array(nC).keys()];

let highs = null;
async function solver() {
  if (highs) return highs;
  let loader;
  try { loader = require('highs'); } catch { return null; }
  const dir = path.dirname(require.resolve('highs'));
  highs = await loader({ locateFile: f => path.join(dir, f) });
  return highs;
}

// Independent scorer mirroring worker.js evaluate().
function score(roster, opts = {}) {
  const nT = T.traitKeys.length;
  const counts = new Array(nT).fill(0);
  for (const e of opts.emblems || []) {
    const t = typeof e === 'string' ? T.traitIndex.get(e) : e;
    if (t >= 0) counts[t]++;
  }
  let gold = 0, slots = 0;
  for (const c of roster) {
    gold += T.cost[c] * 3; slots += T.slots[c];
    for (const [t, p] of T.points[c]) counts[t] += p;
  }
  const muted = new Set(opts.muted || []);
  let live = 0, waste = 0, tierSum = 0;
  for (let t = 0; t < nT; t++) {
    const c = counts[t];
    if (!c) continue;
    const bp = T.bps[t];
    let reached = 0, tier = -1;
    for (let j = 0; j < bp.length; j++) if (c >= bp[j]) { reached = bp[j]; tier = j; }
    if (!muted.has(t)) waste += c - reached;
    if (tier >= 0 && T.floors[t] !== null && !muted.has(t) && c >= T.floors[t]) {
      live++; tierSum += tier + 1;
    }
  }
  return { live, waste, tierSum, gold, slots, counts };
}

function runDFS(opts, timeBudgetMs = 4000) {
  const ctx = {
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    console, postMessage() {},
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.importScripts = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'search-utils.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'worker.js'), 'utf8'), ctx);
  ctx.DBIN = db;
  vm.runInContext('init(DBIN)', ctx);
  ctx.OPTS = {
    size: opts.size, maxWaste: opts.maxWaste, reqIdx: opts.reqIdx || [],
    poolIdx: opts.poolIdx || allPool, emblems: opts.emblems || [],
    limit: 100, returnN: 100, sortMode: opts.sortMode || 'live',
    sortMode2: 'cost', muted: opts.muted || [], reqTraits: opts.reqTraits || [],
    effort: 'deep', shards: 1, shard: 0, timeBudgetMs,
  };
  return vm.runInContext('search(OPTS)', ctx);
}

async function solveBest(opts) {
  const h = await solver();
  if (!h) return null;
  let best = null;
  for (const bonus of LpModel.bonusOptions(T)) {
    const built = LpModel.buildLP(db, { ...opts, bonus, tables: T, poolIdx: opts.poolIdx || allPool });
    if (!built) continue;
    let s;
    try { s = h.solve(built.lp, { output_flag: false, time_limit: 25, mip_rel_gap: 0 }); }
    catch { continue; }
    if (!s || s.Status !== 'Optimal') continue;
    const roster = LpModel.rosterOf(s);
    if (!roster.length) continue;
    const sc = score(roster, opts);
    if (!best || sc.live > best.sc.live || (sc.live === best.sc.live && sc.gold < best.sc.gold)) {
      best = { roster, sc, bonus };
    }
  }
  return best;
}

test('lp-model derives the same trait semantics as search-utils', () => {
  T.traitKeys.forEach((key, t) => {
    const trait = db.traits[key];
    assert.deepEqual(T.bps[t], SearchUtils.breakpoints(trait), `breakpoints ${key}`);
    const floor = SearchUtils.scoreFloor(trait);
    const expected = Number.isFinite(floor) ? floor : null;
    assert.equal(T.floors[t], expected, `scoreFloor ${key}`);
    // A unique trait must have a null floor: it is displayed but never scored.
    assert.equal(T.floors[t] === null, SearchUtils.isUnique(trait), `isUnique ${key}`);
  });
});

test('lp-model emits a parseable model for every sort mode', () => {
  for (const sortMode of ['live', 'tier', 'waste', 'cost', 'rich']) {
    const built = LpModel.buildLP(db, {
      size: 8, maxWaste: 10, poolIdx: allPool, sortMode, tables: T,
    });
    assert.ok(built && built.lp.startsWith('Maximize') || built.lp.startsWith('Minimize'),
      `${sortMode} has an objective`);
    assert.match(built.lp, /Subject To/);
    assert.match(built.lp, /^End$/m);
    assert.match(built.lp, /Binary/);
  }
});

test('an empty pool yields no model rather than a broken one', () => {
  assert.equal(LpModel.buildLP(db, { size: 8, maxWaste: 10, poolIdx: [], tables: T }), null);
});

test('solver never scores below the DFS on plain queries', { timeout: 300000 }, async () => {
  const h = await solver();
  if (!h) return;                                  // optional dependency absent
  for (const size of [6, 8, 9]) {
    for (const maxWaste of [0, 10]) {
      const opts = { size, maxWaste, poolIdx: allPool, sortMode: 'live' };
      const best = await solveBest(opts);
      const dfs = runDFS(opts, 4000);
      if (!best) continue;
      assert.ok(best.sc.waste <= maxWaste,
        `size=${size} waste=${maxWaste}: solver respected the waste cap`);
      assert.equal(best.sc.slots, size + best.bonus,
        `size=${size}: slots match the level plus its capacity bonus`);
      if (dfs.rows.length) {
        assert.ok(best.sc.live >= dfs.rows[0].live,
          `size=${size} waste=${maxWaste}: solver ${best.sc.live} >= dfs ${dfs.rows[0].live}`);
      }
    }
  }
});

test('solver honours required units, traits, pool and emblems', { timeout: 300000 }, async () => {
  const h = await solver();
  if (!h) return;
  const invoker = T.traitKeys.indexOf('Invoker');

  const withReq = await solveBest({ size: 8, maxWaste: 10, poolIdx: allPool, reqIdx: [0, 5] });
  assert.ok(withReq, 'required-unit query is feasible');
  assert.ok([0, 5].every(i => withReq.roster.includes(i)), 'required units are fielded');

  if (invoker >= 0) {
    const withTrait = await solveBest({
      size: 8, maxWaste: 10, poolIdx: allPool, reqTraits: [{ t: invoker, n: 4 }],
    });
    assert.ok(withTrait, 'required-trait query is feasible');
    assert.ok(withTrait.sc.counts[invoker] >= 4, 'required trait reaches its floor');
  }

  const cheap = allPool.filter(i => T.cost[i] <= 2);
  const pooled = await solveBest({ size: 8, maxWaste: 10, poolIdx: cheap });
  assert.ok(pooled, 'restricted pool is feasible');
  assert.ok(pooled.roster.every(i => cheap.includes(i)), 'never fields a unit outside the pool');

  const emblemTrait = T.traitKeys.findIndex((k, t) => T.floors[t] !== null);
  const withEmblem = await solveBest({
    size: 8, maxWaste: 10, poolIdx: allPool, emblems: [emblemTrait, emblemTrait],
  });
  assert.ok(withEmblem, 'emblem query is feasible');
  assert.ok(withEmblem.sc.counts[emblemTrait] >= 2, 'emblems contribute trait points');
});

test('mutually exclusive champion forms are never fielded together', { timeout: 120000 }, async () => {
  const h = await solver();
  if (!h) return;
  const best = await solveBest({ size: 9, maxWaste: 10, poolIdx: allPool });
  assert.ok(best, 'query is feasible');
  const groups = best.roster.map(i => T.group[i]).filter(Boolean);
  assert.equal(groups.length, new Set(groups).size, 'at most one form per group');
});

test('muted traits are excluded from score and waste', { timeout: 120000 }, async () => {
  const h = await solver();
  if (!h) return;
  const t = T.traitKeys.findIndex((k, i) => T.floors[i] !== null);
  const best = await solveBest({ size: 8, maxWaste: 10, poolIdx: allPool, muted: [t] });
  assert.ok(best, 'muted query is feasible');
  const scored = score(best.roster, { muted: [t] });
  assert.equal(scored.live, best.sc.live, 'muted trait does not inflate the live count');
});

test('summary reports optimal only when the solver proved it', () => {
  const base = { ms: 120, rows: [{}], total: 5, truncated: false, stopReason: null };
  const proved = SearchUtils.summary({ ...base, proved: true });
  assert.match(proved.statusHtml, /optimal/);
  assert.match(proved.countHtml, /optimal/);

  const unproved = SearchUtils.summary({ ...base, proved: false, truncated: true, stopReason: 'nodes' });
  assert.doesNotMatch(unproved.statusHtml, /optimal/);
  assert.match(unproved.statusHtml, /stopped early/);
  assert.match(unproved.countHtml, /incomplete/);

  // An incomplete search that WAS proved optimal must not also claim to be
  // incomplete: the proof is about the top row, and it outranks the warning.
  const both = SearchUtils.summary({ ...base, proved: true, truncated: true, stopReason: 'nodes' });
  assert.match(both.statusHtml, /optimal/);
  assert.doesNotMatch(both.statusHtml, /stopped early/);
});

test('a partial solver render says it is still filling in', () => {
  const partial = SearchUtils.summary({
    ms: 300, rows: [{}, {}], total: 0, truncated: false, stopReason: null,
    proved: true, partial: true,
  });
  assert.match(partial.statusHtml, /optimal/);
  assert.match(partial.statusHtml, /finding more/);
  assert.match(partial.countHtml, /so far/);
  // It must NOT claim a scored total it hasn't got.
  assert.doesNotMatch(partial.countHtml, /scored/);

  // A partial that HAS scored boards (the DFS streaming its own rows in) may
  // report the running total, but must not imply the search is done.
  const filling = SearchUtils.summary({
    ms: 900, rows: [{}, {}, {}], total: 4210, truncated: false, stopReason: null,
    proved: true, partial: true,
  });
  assert.match(filling.countHtml, /4,210\+ scored/);
  assert.match(filling.statusHtml, /finding more/);
  assert.doesNotMatch(filling.statusHtml, /stopped early/);
});

// Regression: the interim "proved" board shown while the DFS is still running
// must be the same board that stays on top after every row merges in.
//
// The objective used to encode only the PRIMARY sort key, leaving the solver
// free to break ties arbitrarily. With sort=live, then=waste that surfaced a
// max-live board with high waste, which then dropped down the list the moment
// the DFS rows arrived and the real secondary key applied. The preview visibly
// reordered under the user.
//
// Ground truth here is brute force over a small pool: enumerate every feasible
// board, rank with the shipped comparator, and require the LP to agree.
test('LP objective matches the result-list comparator, not just the primary key',
  { timeout: 300000 }, async () => {
    const highsInstance = await solver();
    if (!highsInstance) return; // highs is optional; nothing to check without it

    const bonuses = LpModel.bonusOptions(T);
    const maxBonus = Math.max(...bonuses);

    // Every board of exactly `size` (+ an activated bonus) slots from `pool`.
    function bruteForce(pool, size, maxWaste) {
      const found = [];
      const pick = [];
      const usedGroups = new Set();
      const recurse = (i, slots) => {
        if (slots > size + maxBonus) return;
        if (i === pool.length) {
          const sc = score(pick);
          if (sc.waste > maxWaste) return;
          // The slot total must match a bonus the board actually activates.
          let granted = 0;
          T.teamSize.forEach((tiers, t) => {
            for (const tier of tiers) {
              if (sc.counts[t] >= tier.min) granted = Math.max(granted, tier.slots);
            }
          });
          if (sc.slots !== size + granted) return;
          found.push(sc);
          return;
        }
        recurse(i + 1, slots);
        const c = pool[i], group = T.group[c];
        if (group && usedGroups.has(group)) return;
        if (group) usedGroups.add(group);
        pick.push(c);
        recurse(i + 1, slots + T.slots[c]);
        pick.pop();
        if (group) usedGroups.delete(group);
      };
      recurse(0, 0);
      return found;
    }

    async function lpBest(opts) {
      const rank = SearchUtils.comparator(opts.sortMode, opts.sortMode2);
      let best = null;
      for (const bonus of bonuses) {
        const built = LpModel.buildLP(db, { ...opts, bonus, tables: T });
        if (!built) continue;
        const solution = highsInstance.solve(built.lp,
          { output_flag: false, time_limit: 30, mip_rel_gap: 0 });
        if (!solution || solution.Status !== 'Optimal') continue;
        const roster = LpModel.rosterOf(solution);
        if (!roster.length) continue;
        const sc = score(roster);
        if (sc.waste > opts.maxWaste) continue;
        if (!best || rank(sc, best) < 0) best = sc;
      }
      return best;
    }

    // Deterministic pseudo-random pools: small enough to brute force, varied
    // enough to produce ties across every sort mode.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const modes = ['live', 'tier', 'waste', 'cost', 'rich'];

    let checked = 0;
    for (let trial = 0; trial < 10; trial++) {
      const poolSize = 13 + Math.floor(rnd() * 4);
      const pool = [];
      while (pool.length < poolSize) {
        const c = Math.floor(rnd() * nC);
        if (!pool.includes(c)) pool.push(c);
      }
      pool.sort((a, b) => a - b);

      const size = 5 + Math.floor(rnd() * 2);
      const maxWaste = [0, 1, 2, 10][Math.floor(rnd() * 4)];
      const sortMode = modes[trial % modes.length];
      const sortMode2 = modes[(trial + 2) % modes.length];
      const opts = {
        size, maxWaste, poolIdx: pool, reqIdx: [], emblems: [], muted: [],
        reqTraits: [], sortMode, sortMode2,
      };

      const feasible = bruteForce(pool, size, maxWaste);
      if (!feasible.length) continue;

      const rank = SearchUtils.comparator(sortMode, sortMode2);
      feasible.sort(rank);
      const truth = feasible[0];
      const lp = await lpBest(opts);
      checked++;

      assert.ok(lp, `LP found a board for ${sortMode}>${sortMode2}`);
      // Compare on rank, not roster identity - several boards can tie exactly.
      assert.equal(rank(lp, truth), 0,
        `${sortMode}>${sortMode2} pool=${poolSize} size=${size} waste<=${maxWaste}: ` +
        `LP chose live=${lp.live} tier=${lp.tierSum} waste=${lp.waste} gold=${lp.gold}, ` +
        `comparator prefers live=${truth.live} tier=${truth.tierSum} waste=${truth.waste} gold=${truth.gold}`);
    }
    assert.ok(checked >= 5, `exercised ${checked} tie-break comparisons`);
  });
