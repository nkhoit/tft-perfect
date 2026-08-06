import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAITS = path.join(ROOT, 'web', 'traits');
const db = JSON.parse(fs.readFileSync(path.join(TRAITS, 'data.json'), 'utf8'));
const SearchUtils = require('../web/traits/search-utils.js');
const LocalSearch = require('../web/traits/local-search.js');
const BUDGET_MS = 500;
const CASE_SEEDS = [1801, 1818, 1842];

function dfsSearch(options) {
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
        fs.readFileSync(path.join(TRAITS, file.split('?')[0]), 'utf8'),
        context);
    }

  };
  vm.runInContext(fs.readFileSync(path.join(TRAITS, 'worker.js'), 'utf8'), context);
  context.onmessage({ data: { type: 'init', db } });
  const started = performance.now();
  context.onmessage({
    data: { type: 'search', id: 1, opts: { ...options, progress: false } },
  });
  const elapsedMs = Math.round(performance.now() - started);
  return { ...messages.at(-1), elapsedMs };
}

function localWorkerSearch(options) {
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
        fs.readFileSync(path.join(TRAITS, file.split('?')[0]), 'utf8'),
        context);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(TRAITS, 'local-worker.js'), 'utf8'), context);
  context.onmessage({ data: { type: 'init', db } });
  const started = performance.now();
  context.onmessage({
    data: { type: 'search', id: 1, opts: { ...options, progress: false } },
  });
  const elapsedMs = Math.round(performance.now() - started);
  return { ...messages.at(-1), elapsedMs };
}

function randomEmblems(seed) {
  const random = LocalSearch.prng(seed);
  const choices = Object.keys(db.traits)
    .filter(key => Number.isFinite(SearchUtils.scoreFloor(db.traits[key])));
  for (let index = choices.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [choices[index], choices[swap]] = [choices[swap], choices[index]];
  }
  return choices.slice(0, 3);
}

function baseOptions(seed, emblems) {
  return {
    size: 10,
    maxWaste: 10,
    reqIdx: [],
    poolIdx: db.champions.map((_, index) => index),
    emblems,
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'rich',
    effort: 'quick',
    timeBudgetMs: BUDGET_MS,
    limit: 100,
    returnN: 100,
    shards: 1,
    shard: 0,
    seed,
  };
}

function report(caseSeed, engine, emblems, result) {
  const best = result.rows[0];
  assert.ok(best, `${engine} seed ${caseSeed} returned no board`);
  return {
    seed: caseSeed,
    engine,
    emblems: emblems.join(','),
    live: best.live,
    gold: best.gold,
    waste: best.waste,
    units: best.units.map(index => db.champions[index].key).join(','),
    elapsedMs: result.elapsedMs ?? result.ms,
    stopReason: result.stopReason,
    evaluations: result.nodes,
  };
}

const rows = [];
for (const seed of CASE_SEEDS) {
  const emblems = randomEmblems(seed);
  const options = baseOptions(seed, emblems);
  // Use a fresh worker VM for both engines so neither side gets an accumulated
  // JIT warm-up advantage from earlier cases.
  const local = localWorkerSearch(options);
  const dfs = dfsSearch(options);
  assert.equal(local.stopReason, 'time', 'local search must use the 500ms wall-clock limit');
  assert.equal(dfs.stopReason, 'time', 'DFS must use the 500ms wall-clock limit');
  assert.ok(local.elapsedMs >= BUDGET_MS * 0.9 && local.elapsedMs < BUDGET_MS * 1.5,
    `local elapsed ${local.elapsedMs}ms is not comparable to ${BUDGET_MS}ms`);
  assert.ok(dfs.elapsedMs >= BUDGET_MS * 0.9 && dfs.elapsedMs < BUDGET_MS * 1.5,
    `DFS elapsed ${dfs.elapsedMs}ms is not comparable to ${BUDGET_MS}ms`);
  rows.push(report(seed, 'local', emblems, local));
  rows.push(report(seed, 'dfs', emblems, dfs));
}

const output = {
  algorithmVersion: SearchUtils.algorithmVersion,
  budgetMs: BUDGET_MS,
  size: 10,
  sort: ['live', 'rich'],
  cases: rows,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.table(rows);
  console.log(JSON.stringify(output));
}
