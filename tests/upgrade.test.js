const assert = require('node:assert/strict');
const test = require('node:test');

const db = require('../web/traits/data.json');
const BoardScore = require('../web/traits/board-score.js');
const LpModel = require('../web/traits/lp-model.js');
const SearchUtils = require('../web/traits/search-utils.js');

const tables = LpModel.tables(db);
const allPool = db.champions.map((_, index) => index);
let highsPromise = null;

async function highsSolver() {
  if (highsPromise) return highsPromise;
  let loader;
  try {
    loader = require('highs');
  } catch (error) {
    if (process.env.REQUIRE_SOLVER === '1') throw error;
    return null;
  }
  const path = require('node:path');
  const directory = path.dirname(require.resolve('highs'));
  highsPromise = loader({ locateFile: file => path.join(directory, file) });
  return highsPromise;
}

function solvedRow(solution, options) {
  const roster = LpModel.rosterOf(solution);
  const validated = BoardScore.validateRoster(
    db,
    tables,
    roster.map(index => db.champions[index].key),
    options);
  assert.equal(validated.error, undefined);
  return validated.row;
}

test('championDiff reports stable added, removed, and kept indexes', () => {
  const [first, second, third, fourth] = allPool;
  assert.deepEqual(
    SearchUtils.championDiff([third, first, second], [fourth, second, first]),
    {
      added: [fourth],
      removed: [third],
      kept: [first, second],
    });
});

test('championDiff handles pure additions and identical boards', () => {
  const [first, second, third] = allPool;
  assert.deepEqual(
    SearchUtils.championDiff([first, second], [third, second, first]),
    { added: [third], removed: [], kept: [first, second] });
  assert.deepEqual(
    SearchUtils.championDiff([second, first], [first, second]),
    { added: [], removed: [], kept: [first, second] });
});

test('compareTraitQuality ignores gold without letting waste rescue fewer traits', () => {
  const source = { live: 5, tierSum: 6, waste: 2, gold: 30 };
  assert.equal(
    SearchUtils.compareTraitQuality({ ...source, gold: 99 }, source),
    0);
  assert.ok(
    SearchUtils.compareTraitQuality(
      { live: 4, tierSum: 20, waste: 0, gold: 1 },
      source) > 0);
});

test('upgrade semantics use the v8 cache namespace', () => {
  assert.equal(SearchUtils.algorithmVersion, 'milp-hybrid-v8');
});

test('exact keep bounds preserve required pins and emit overlap rows', () => {
  const source = allPool.slice(0, 4);
  const required = [source[0]];
  const built = LpModel.buildLP(db, {
    size: 5,
    maxWaste: 99,
    reqIdx: required,
    keepIdx: source,
    minKeep: 3,
    maxKeep: 3,
    poolIdx: allPool.slice(4, 12),
    tables,
    sortMode: 'live',
  });

  assert.ok(built);
  assert.match(built.lp, new RegExp(` req${required[0]}: x${required[0]} = 1`));
  assert.match(built.lp, / keepMin:.* >= 3/);
  assert.match(built.lp, / keepMax:.* <= 3/);
  for (const champion of source) {
    assert.ok(built.pool.includes(champion), `source champion ${champion} is modelled`);
  }
});

test('full keep uses source-board hard pins', () => {
  const source = allPool.slice(0, 4);
  const built = LpModel.buildLP(db, {
    size: 5,
    maxWaste: 99,
    reqIdx: [source[0]],
    keepIdx: source,
    minKeep: source.length,
    maxKeep: source.length,
    poolIdx: allPool.slice(4, 12),
    tables,
    sortMode: 'live',
  });

  assert.ok(built);
  assert.doesNotMatch(built.lp, / keepMin:/);
  assert.doesNotMatch(built.lp, / keepMax:/);
  for (const champion of source.slice(1)) {
    assert.match(built.lp, new RegExp(` keep${champion}: x${champion} = 1`));
  }
});

test('invalid keep bounds fail explicitly', () => {
  const base = {
    size: 5,
    maxWaste: 99,
    reqIdx: [],
    keepIdx: allPool.slice(0, 4),
    poolIdx: allPool.slice(4, 12),
    tables,
  };
  for (const bounds of [
    {},
    { minKeep: 1.5, maxKeep: 2 },
    { minKeep: -1, maxKeep: 2 },
    { minKeep: 3, maxKeep: 2 },
    { minKeep: 0, maxKeep: 5 },
  ]) {
    assert.throws(
      () => LpModel.buildLP(db, { ...base, ...bounds }),
      { name: 'RangeError' });
  }
});

test('required traits cannot be malformed or silently unavailable', () => {
  const trait = tables.traitKeys.findIndex((_, index) =>
    tables.points.some(points => points.has(index)));
  const poolWithoutTrait = allPool.filter(index => !tables.points[index].has(trait));
  assert.ok(poolWithoutTrait.length);

  assert.equal(LpModel.buildLP(db, {
    size: 2,
    maxWaste: 99,
    reqIdx: [],
    poolIdx: poolWithoutTrait,
    reqTraits: [{ t: trait, n: 1 }],
    tables,
  }), null);

  for (const reqTraits of [
    [{ t: -1, n: 1 }],
    [{ t: trait + 0.5, n: 1 }],
    [{ t: trait, n: 0 }],
  ]) {
    assert.throws(() => LpModel.buildLP(db, {
      size: 2,
      maxWaste: 99,
      reqIdx: [],
      poolIdx: allPool,
      reqTraits,
      tables,
    }), { name: 'RangeError' });
  }
});

test('capacity bonus supports emblem-only unlocks but rejects insufficient reach', () => {
  const trait = tables.teamSize.findIndex(tiers => tiers.length);
  assert.ok(trait >= 0, 'generated data has a capacity trait');
  const tier = tables.teamSize[trait][0];
  const poolWithoutTrait = allPool.filter(index => !tables.points[index].has(trait));
  assert.ok(poolWithoutTrait.length);

  const base = {
    size: 8,
    maxWaste: 99,
    bonus: tier.slots,
    reqIdx: [],
    poolIdx: poolWithoutTrait,
    tables,
  };
  assert.equal(LpModel.buildLP(db, { ...base, emblems: [] }), null);

  const built = LpModel.buildLP(db, {
    ...base,
    emblems: Array(tier.min).fill(trait),
  });
  assert.ok(built);
  assert.match(built.lp, new RegExp(` cap${trait}: \\+1 n${trait} >= ${tier.min}`));
});

test('solver statuses require every bonus branch to resolve', () => {
  const SolverStatus = require('../web/traits/solver-status.js');
  assert.equal(SolverStatus.classify('Optimal'), 'optimal');
  assert.equal(SolverStatus.classify('Infeasible'), 'infeasible');
  assert.equal(
    SolverStatus.classify('Primal infeasible or unbounded'),
    'unresolved');
  assert.deepEqual(
    SolverStatus.proof(['optimal', 'infeasible'], 1),
    { proved: true, infeasible: false });
  assert.deepEqual(
    SolverStatus.proof(['infeasible', 'infeasible'], 0),
    { proved: false, infeasible: true });
  assert.deepEqual(
    SolverStatus.proof(['optimal', 'unresolved'], 1),
    { proved: false, infeasible: false });
});

test('solver scheduler runs one request and keeps only the latest queued request', () => {
  const SolverScheduler = require('../web/traits/solver-scheduler.js');
  const sent = [];
  const started = [];
  const cleared = [];
  const scheduler = SolverScheduler.create({
    send: message => sent.push(message.id),
    onStarted: id => started.push(id),
    onFinished: id => cleared.push(id),
  });

  scheduler.enqueue({ id: 1 });
  scheduler.enqueue({ id: 2 });
  scheduler.enqueue({ id: 3 });
  assert.deepEqual(sent, [1]);
  assert.equal(scheduler.inFlightId(), 1);
  assert.equal(scheduler.queuedId(), 3);

  scheduler.started(1);
  assert.deepEqual(started, [1]);
  scheduler.finished(1);
  assert.deepEqual(cleared, [1]);
  assert.deepEqual(sent, [1, 3]);
  assert.equal(scheduler.inFlightId(), 3);
  assert.deepEqual(started, [1], 'queued request waits for its own started message');
});

test('capacity bonus is infeasible before its trait fits in base slots',
  { timeout: 120000 }, async () => {
    const highs = await highsSolver();
    if (!highs) return;
    const bonus = Math.max(...LpModel.bonusOptions(tables));
    const built = LpModel.buildLP(db, {
      size: 8,
      maxWaste: 99,
      bonus,
      reqIdx: [],
      poolIdx: allPool,
      tables,
      sortMode: 'live',
      sortMode2: 'tier',
    });
    assert.ok(built);
    const solution = highs.solve(built.lp, {
      output_flag: false,
      time_limit: 30,
      mip_rel_gap: 0,
    });
    assert.equal(solution.Status, 'Infeasible');
  });

test('exact keep solves retain user pins and the requested overlap',
  { timeout: 120000 }, async () => {
    const highs = await highsSolver();
    if (!highs) return;
    const source = require('../web/traits/precomputed-default.json').result.rows[0].units;
    const required = [source[0]];
    const options = {
      size: 9,
      maxWaste: 99,
      reqIdx: required,
      keepIdx: source,
      minKeep: source.length - 1,
      maxKeep: source.length - 1,
      poolIdx: allPool,
      emblems: [],
      muted: [],
      reqTraits: [],
      tables,
      sortMode: 'live',
      sortMode2: 'tier',
    };
    let row = null;
    for (const bonus of LpModel.bonusOptions(tables)) {
      const built = LpModel.buildLP(db, { ...options, bonus });
      if (!built) continue;
      const solution = highs.solve(built.lp, {
        output_flag: false,
        time_limit: 30,
        mip_rel_gap: 0,
      });
      if (solution.Status !== 'Optimal') continue;
      row = solvedRow(solution, options);
      break;
    }
    assert.ok(row, 'exact keep query is feasible');
    assert.equal(
      row.units.filter(index => source.includes(index)).length,
      source.length - 1);
    assert.ok(required.every(index => row.units.includes(index)));
  });

test('Rival tier ordering matches brute force and the shared comparator',
  { timeout: 120000 }, async () => {
    const highs = await highsSolver();
    if (!highs) return;
    const names = [
      'KhaZix', 'Rengar', 'Shen', 'Azir', 'Cassiopeia', 'Taric', 'Ornn',
      'Cinderling', 'Maokai', 'KogMaw', 'Warwick', 'Krug',
      'AncientSentinel', 'Kennen', 'Draven', 'Vi',
    ];
    const pool = names.map(name => {
      const index = db.champions.findIndex(champion =>
        champion.key === name || champion.name.replace(/[^A-Za-z0-9]/g, '') === name);
      assert.ok(index >= 0, `${name} exists in generated data`);
      return index;
    });
    const options = {
      size: 6,
      maxWaste: 6,
      reqIdx: [],
      poolIdx: pool,
      emblems: [],
      muted: [],
      reqTraits: [],
      tables,
      sortMode: 'live',
      sortMode2: 'tier',
    };
    const rank = SearchUtils.comparator('live', 'tier');
    const brute = [];
    const picked = [];
    const visit = start => {
      if (picked.length === 6) {
        const validated = BoardScore.validateRoster(
          db,
          tables,
          picked.map(index => db.champions[index].key),
          options);
        if (!validated.error && validated.row.waste <= options.maxWaste) {
          brute.push(validated.row);
        }
        return;
      }
      for (let i = start; i < pool.length; i++) {
        picked.push(pool[i]);
        visit(i + 1);
        picked.pop();
      }
    };
    visit(0);
    brute.sort(rank);
    assert.ok(brute.length);

    const lpRows = [];
    for (const bonus of LpModel.bonusOptions(tables)) {
      const built = LpModel.buildLP(db, { ...options, bonus });
      if (!built) continue;
      const solution = highs.solve(built.lp, {
        output_flag: false,
        time_limit: 30,
        mip_rel_gap: 0,
      });
      if (solution.Status === 'Optimal') lpRows.push(solvedRow(solution, options));
    }
    lpRows.sort(rank);
    assert.ok(lpRows.length);
    assert.equal(rank(lpRows[0], brute[0]), 0);
  });
