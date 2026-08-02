#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isMainThread, parentPort, workerData, Worker } = require('node:worker_threads');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
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
    data: { type: 'search', id: 1, opts: options(db, shard) },
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
  const SearchUtils = require('./web/search-utils.js');
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
  const result = SearchUtils.mergeSearchResults(parts, 'live', 'cost');
  result.ms = 0;
  result.effort = 'deep';
  const baseOptions = options(db, 0);
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
  console.log(`wrote ${outputPath}: ${result.rows.length} comps, ${result.total}+ scored`);
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
