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
      vm.runInContext(
        fs.readFileSync(path.join(WEB, file.split('?')[0]), 'utf8'),
        context);
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
  // The landing result carries the same all-bonus proof as an interactive
  // search. Missing or unresolved HiGHS is a build failure, not a silent
  // downgrade to an unproved landing page.
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
async function solveOptimum(db, baseOptions) {
  let highsLoader;
  try {
    highsLoader = require('highs');
  } catch (error) {
    throw new Error('highs is required to precompute a proved landing result.');
  }
  const SearchUtils = require('./web/traits/search-utils.js');
  const BoardScore = require('./web/traits/board-score.js');
  const LpModel = require('./web/traits/lp-model.js');
  const SolverStatus = require('./web/traits/solver-status.js');
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
  const branches = [];
  const seeds = new Map();
  const bonuses = LpModel.bonusOptions(tables);
  for (const bonus of bonuses) {
    const built = LpModel.buildLP(db, { ...baseOptions, bonus, cuts: [], tables });
    if (!built) {
      branches.push('infeasible');
      continue;
    }
    const solution = highs.solve(
      built.lp,
      { output_flag: false, time_limit: 30, mip_rel_gap: 0 });
    const status = SolverStatus.classify(solution?.Status);
    if (status !== 'optimal') {
      branches.push(status);
      continue;
    }
    const roster = LpModel.rosterOf(solution);
    const validated = BoardScore.validateRoster(
      db,
      tables,
      roster.map(index => db.champions[index]?.key),
      baseOptions);
    if (validated.error || validated.row.waste > baseOptions.maxWaste) {
      branches.push('unresolved');
      continue;
    }
    branches.push('optimal');
    seeds.set(bonus, roster);
    if (!seen.has(validated.row.signature)) {
      seen.add(validated.row.signature);
      rows.push(validated.row);
    }
  }
  const proof = SolverStatus.proof(branches, rows.length);
  if (!proof.proved) {
    throw new Error('Could not prove the landing result across every capacity profile.');
  }

  for (const [bonus, seed] of seeds) {
    const cuts = [seed];
    for (let i = 1; i < 8; i++) {
      let built;
      try {
        built = LpModel.buildLP(db, { ...baseOptions, bonus, cuts, tables });
      } catch (error) {
        console.warn('Runner-up model failed:', error.message);
        break;
      }
      if (!built) break;
      let solution;
      try {
        solution = highs.solve(
          built.lp,
          { output_flag: false, time_limit: 30, mip_rel_gap: 0 });
      } catch (error) {
        console.warn('Runner-up solve failed:', error.message);
        break;
      }
      if (SolverStatus.classify(solution?.Status) !== 'optimal') break;
      const roster = LpModel.rosterOf(solution);
      const validated = BoardScore.validateRoster(
        db,
        tables,
        roster.map(index => db.champions[index]?.key),
        baseOptions);
      if (validated.error || validated.row.waste > baseOptions.maxWaste) break;
      cuts.push(roster);
      if (!seen.has(validated.row.signature)) {
        seen.add(validated.row.signature);
        rows.push(validated.row);
      }
    }
  }
  return { rows, proved: true, ms: Date.now() - started };
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
