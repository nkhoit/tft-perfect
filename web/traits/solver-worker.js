// solver-worker.js — proves the optimum with HiGHS and enumerates a small frontier.

importScripts(
  'search-utils.js?v=milp-hybrid-v7',
  'solver-status.js?v=milp-hybrid-v7',
  'board-score.js?v=milp-hybrid-v7',
  'lp-model.js?v=milp-hybrid-v7',
  'vendor/highs.js');

let DB = null;
let TABLES = null;
let highsPromise = null;
let initializePromise = null;
let initialized = false;
let initializeError = null;
const queuedSearches = [];
const INITIALIZE_TIMEOUT_MS = 15000;

function loadHighs() {
  if (!highsPromise) {
    highsPromise = Module({
      locateFile: file => (file.endsWith('.wasm') ? 'vendor/' + file : file),
    });
  }
  return highsPromise;
}

function timeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function resultKey(row, opts) {
  return opts.resultMode === 'roster'
    ? SearchUtils.compSignature(row.units)
    : row.signature;
}

function validatedRow(roster, opts) {
  const keys = roster.map(index => DB.champions[index]?.key);
  if (keys.some(key => !key)) return null;
  const validated = BoardScore.validateRoster(DB, TABLES, keys, {
    size: opts.size,
    emblems: opts.emblems,
    muted: opts.muted,
  });
  if (validated.error || validated.row.waste > opts.maxWaste) return null;

  const counts = new Map();
  for (const [trait, count] of validated.row.active) counts.set(trait, count);
  for (const [trait, count] of validated.row.dead) counts.set(trait, count);
  if ((opts.reqTraits || []).some(({ t, n }) => (counts.get(t) || 0) < n)) return null;
  return validated.row;
}

async function solve(opts, onProgress) {
  const highs = await loadHighs();
  const started = performance.now();
  const budget = Number.isFinite(opts.solverBudgetMs) && opts.solverBudgetMs > 0
    ? opts.solverBudgetMs
    : 3000;
  const want = Math.max(1, opts.solverRows || 8);
  const rank = SearchUtils.comparator(opts.sortMode, opts.sortMode2);
  const bonuses = LpModel.bonusOptions(TABLES);
  const rows = [];
  const seen = new Set();
  const branches = [];
  const seeds = new Map();
  let best = null;

  const addRow = row => {
    const key = resultKey(row, opts);
    if (seen.has(key)) return false;
    seen.add(key);
    rows.push(row);
    if (!best || rank(row, best) < 0) best = row;
    return true;
  };

  // Phase one resolves every capacity profile before making an optimality claim.
  for (const bonus of bonuses) {
    if (performance.now() - started > budget) {
      branches.push('unresolved');
      continue;
    }
    let built;
    try {
      built = LpModel.buildLP(DB, { ...opts, bonus, cuts: [], tables: TABLES });
    } catch (error) {
      if (error instanceof RangeError) throw error;
      branches.push('unresolved');
      continue;
    }
    if (!built) {
      branches.push('infeasible');
      continue;
    }

    let solution;
    try {
      solution = highs.solve(built.lp, {
        output_flag: false,
        time_limit: Math.max(0.25, (budget - (performance.now() - started)) / 1000),
        mip_rel_gap: 0,
      });
    } catch {
      branches.push('unresolved');
      continue;
    }
    const status = SolverStatus.classify(solution?.Status);
    if (status !== 'optimal') {
      branches.push(status);
      continue;
    }

    const roster = LpModel.rosterOf(solution);
    const row = roster.length ? validatedRow(roster, opts) : null;
    if (!row) {
      branches.push('unresolved');
      continue;
    }
    branches.push('optimal');
    seeds.set(bonus, { roster, row });
    addRow(row);
  }

  const proof = SolverStatus.proof(branches, rows.length);
  if (proof.proved && best && onProgress) onProgress([best]);

  let rowsComplete = opts.resultMode === 'roster';
  let enumerationStopReason = null;

  // Phase two enumerates a proven top-L roster frontier with no-good cuts.
  for (let branchIndex = 0; branchIndex < bonuses.length; branchIndex++) {
    const bonus = bonuses[branchIndex];
    const seed = seeds.get(bonus);
    if (!seed) {
      if (opts.resultMode === 'roster' && branches[branchIndex] === 'unresolved') {
        rowsComplete = false;
      }
      continue;
    }
    const cuts = [seed.roster];
    let solvedRosters = 1;
    let exhausted = false;
    while (solvedRosters < want) {
      if (performance.now() - started > budget) {
        rowsComplete = false;
        enumerationStopReason ||= 'budget';
        break;
      }
      let built;
      try {
        built = LpModel.buildLP(DB, { ...opts, bonus, cuts, tables: TABLES });
      } catch (error) {
        if (error instanceof RangeError) throw error;
        rowsComplete = false;
        enumerationStopReason ||= 'model';
        break;
      }
      if (!built) {
        exhausted = true;
        break;
      }

      let solution;
      try {
        solution = highs.solve(built.lp, {
          output_flag: false,
          time_limit: Math.max(0.25, (budget - (performance.now() - started)) / 1000),
          mip_rel_gap: 0,
        });
      } catch {
        rowsComplete = false;
        enumerationStopReason ||= 'solver';
        break;
      }
      const status = SolverStatus.classify(solution?.Status);
      if (status === 'infeasible') {
        exhausted = true;
        break;
      }
      if (status !== 'optimal') {
        rowsComplete = false;
        enumerationStopReason ||= 'status';
        break;
      }

      const roster = LpModel.rosterOf(solution);
      const row = roster.length ? validatedRow(roster, opts) : null;
      if (!row) {
        rowsComplete = false;
        enumerationStopReason ||= 'validation';
        break;
      }
      cuts.push(roster);
      solvedRosters++;
      addRow(row);
    }
    if (opts.resultMode === 'roster' && !exhausted && solvedRosters < want) {
      rowsComplete = false;
    }
  }

  rows.sort(rank);
  if (opts.resultMode === 'roster') rows.length = Math.min(rows.length, want);
  return {
    rows,
    ...proof,
    ...(opts.resultMode === 'roster' ? { rowsComplete } : {}),
    ...(enumerationStopReason ? { enumerationStopReason } : {}),
  };
}

async function runSearch(message) {
  const started = performance.now();
  postMessage({ type: 'started', id: message.id });
  let result;
  try {
    result = await solve(message.opts, rows => {
      postMessage({
        type: 'solver',
        id: message.id,
        partial: true,
        proved: true,
        rows,
        ms: Math.round(performance.now() - started),
      });
    });
  } catch (error) {
    result = {
      rows: [],
      proved: false,
      infeasible: false,
      error: String(error && error.message || error),
    };
  }
  postMessage({
    type: 'solver',
    id: message.id,
    ms: Math.round(performance.now() - started),
    ...result,
  });
}

async function drainQueuedSearches() {
  while (queuedSearches.length && initialized) {
    const message = queuedSearches.shift();
    await runSearch(message);
  }
}

function failQueuedSearches(error) {
  while (queuedSearches.length) {
    const message = queuedSearches.shift();
    postMessage({
      type: 'solver',
      id: message.id,
      ms: 0,
      rows: [],
      proved: false,
      infeasible: false,
      error,
    });
  }
}

async function initialize(db) {
  DB = db;
  TABLES = LpModel.tables(DB);
  try {
    await timeout(loadHighs(), INITIALIZE_TIMEOUT_MS, 'Solver initialization timed out.');
    initialized = true;
    postMessage({
      type: 'ready',
      algorithmVersion: SearchUtils.algorithmVersion,
    });
    await drainQueuedSearches();
  } catch (error) {
    initializeError = String(error && error.message || error);
    postMessage({ type: 'init-error', error: initializeError });
    failQueuedSearches(initializeError);
  }
}

onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    if (!initializePromise) initializePromise = initialize(message.db);
    return;
  }
  if (message.type !== 'search') return;
  if (initializeError) {
    queuedSearches.push(message);
    failQueuedSearches(initializeError);
    return;
  }
  if (!initialized) {
    queuedSearches.push(message);
    return;
  }
  void runSearch(message);
};
