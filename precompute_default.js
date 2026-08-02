#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isMainThread, parentPort, workerData, Worker } = require('node:worker_threads');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web', 'traits');
const SHARDS = 8;

function options(db, shard) {
  return {
    size: 8,
    maxWaste: 10,
    reqIdx: [],
    poolIdx: db.champions.map((champion, index) =>
      champion.cost >= 1 && champion.cost <= 5 ? index : -1)
      .filter(index => index >= 0),
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    effort: 'deep',
    timeBudgetMs: 0,
    limit: 100,
    uniq: true,
    returnN: 100,
    shards: SHARDS,
    shard,
  };
}

function runShard(dataPath, shard) {
  const db = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const messages = [];
  const context = vm.createContext({
    performance,
    postMessage(message) {
      messages.push(message);
    },
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), context);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(WEB, 'worker.js'), 'utf8'), context);
  context.onmessage({ data: { type: 'init', db } });
  if (messages.at(-1)?.type !== 'ready') throw new Error(`Shard ${shard} failed to initialize.`);
  context.onmessage({
    // progress:false — this is a headless build step with no UI to update, and
    // streaming snapshots would just pile up in `messages`.
    data: { type: 'search', id: 1, opts: { ...options(db, shard), progress: false } },
  });
  const result = messages.at(-1);
  if (result?.type !== 'result' || result.error) {
    throw new Error(`Shard ${shard} failed: ${result?.error || 'no result'}`);
  }
  return JSON.parse(JSON.stringify(result));
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const dataPath = path.resolve(argument('--data', path.join(WEB, 'data.json')));
  const outputPath = path.resolve(argument('--out', path.join(WEB, 'precomputed-default.json')));
  const db = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const SearchUtils = require('./web/traits/search-utils.js');
  const parts = await Promise.all(Array.from({ length: SHARDS }, (_, shard) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { dataPath, shard },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => {
        if (code) reject(new Error(`Precompute shard ${shard} exited with code ${code}.`));
      });
    })));
  // The landing result must carry the same optimality proof a live search
  // gets, otherwise the default view would show "incomplete" while every
  // interactive search shows "optimal" — the exact confusion this is meant to
  // remove. Falls back to DFS-only output if the solver isn't installed.
  const baseOptions = options(db, 0);
  const solver = await solveOptimum(db, baseOptions);
  if (solver.rows.length) {
    parts.push({
      rows: solver.rows, total: 0, ms: solver.ms,
      nodes: 0, truncated: false, capped: false, stopReason: null,
    });
  }
  const result = SearchUtils.mergeSearchResults(parts, 'live', 'cost');
  result.ms = 0;
  result.effort = 'deep';
  result.proved = solver.proved;
  const version = `${SearchUtils.algorithmVersion}:${db.builtAt || db.gameBuild || db.set}`;
  const output = {
    schemaVersion: 1,
    algorithmVersion: SearchUtils.algorithmVersion,
    dataBuiltAt: db.builtAt,
    queryKey: SearchUtils.searchCacheKey(version, baseOptions),
    result,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = outputPath + '.write';
  fs.writeFileSync(temporary, JSON.stringify(output));
  fs.renameSync(temporary, outputPath);
  console.log(`wrote ${outputPath}: ${result.rows.length} comps, ${result.total}+ scored` +
    (result.proved ? ' (optimum proved)' : ' (NOT proved — solver unavailable)'));
}

// Node-side MILP solve for the landing result. Shares lp-model.js with
// solver-worker.js so the build and the browser agree by construction.
// HiGHS ships as an optional dependency: if it's missing we degrade to a
// DFS-only landing result rather than failing the build.
async function solveOptimum(db, baseOptions) {
  const empty = { rows: [], proved: false, ms: 0 };
  let highsLoader;
  try {
    highsLoader = require('highs');
  } catch (error) {
    console.warn('highs not installed — landing result will not be proved optimal.');
    return empty;
  }
  const SearchUtils = require('./web/traits/search-utils.js');
  const LpModel = require('./web/traits/lp-model.js');
  const tables = LpModel.tables(db);
  // `highs` does not export ./package.json, so resolve the main entry and take
  // its directory — that's where build/highs.wasm sits.
  const highsDir = path.dirname(require.resolve('highs'));
  const highs = await highsLoader({
    locateFile: file => path.join(highsDir, file),
  });

  const started = Date.now();
  const rows = [];
  const seen = new Set();
  let proved = false;
  const bonuses = LpModel.bonusOptions(tables);
  for (const bonus of bonuses) {
    const cuts = [];
    for (let i = 0; i < 8; i++) {
      const built = LpModel.buildLP(db, { ...baseOptions, bonus, cuts, tables });
      if (!built) break;
      let solution;
      try {
        solution = highs.solve(built.lp, { output_flag: false, time_limit: 30, mip_rel_gap: 0 });
      } catch (error) {
        console.warn('HiGHS solve failed:', error.message);
        break;
      }
      if (!solution || solution.Status !== 'Optimal') break;
      const roster = LpModel.rosterOf(solution);
      if (!roster.length) break;
      const row = scoreRosterNode(db, tables, roster, baseOptions);
      if (row.waste > baseOptions.maxWaste) break;
      if (i === 0 && bonus === bonuses[0]) proved = true;
      if (!seen.has(row.signature)) { seen.add(row.signature); rows.push(row); }
      cuts.push(roster);
    }
  }
  return { rows, proved: proved && rows.length > 0, ms: Date.now() - started };
}

// Mirrors worker.js evaluate() and solver-worker.js scoreRoster().
function scoreRosterNode(db, T, roster, opts) {
  const nT = T.traitKeys.length;
  const counts = new Array(nT).fill(0);
  for (const emblem of opts.emblems || []) {
    const t = typeof emblem === 'string' ? T.traitIndex.get(emblem) : emblem;
    if (t >= 0 && t < nT) counts[t]++;
  }
  let gold = 0, slots = 0;
  for (const c of roster) {
    gold += T.cost[c] * 3;
    slots += T.slots[c];
    for (const [t, p] of T.points[c]) counts[t] += p;
  }
  const muted = new Set(opts.muted || []);
  let live = 0, uniqN = 0, waste = 0, tierSum = 0;
  const active = [], dead = [], over = [];
  let signature = '';
  for (let t = 0; t < nT; t++) {
    const count = counts[t];
    if (!count) continue;
    signature += (signature ? '|' : '') + `${t}:${count}`;
    const bp = T.bps[t];
    let reached = 0, tier = -1;
    for (let j = 0; j < bp.length; j++) if (count >= bp[j]) { reached = bp[j]; tier = j; }
    const wasted = count - reached;
    if (wasted) {
      if (!muted.has(t)) waste += wasted;
      if (tier >= 0) over.push([t, wasted]); else dead.push([t, count]);
    }
    if (tier >= 0) {
      active.push([t, count, tier]);
      if (T.floors[t] === null) uniqN++;
      else if (!muted.has(t) && count >= T.floors[t]) { live++; tierSum += tier + 1; }
    }
  }
  const dim = t => (T.floors[t] === null || muted.has(t) || counts[t] < T.floors[t]) ? 1 : 0;
  active.sort((a, b) => (dim(a[0]) - dim(b[0])) || b[1] - a[1]);
  return { units: roster.slice(), active, dead, over, live, uniqN, waste, tierSum, gold, slots, signature };
}

if (isMainThread) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  try {
    parentPort.postMessage(runShard(workerData.dataPath, workerData.shard));
  } catch (error) {
    throw error;
  }
}
