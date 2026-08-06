const assert = require('node:assert/strict');
const test = require('node:test');

const BoardScore = require('../web/traits/board-score.js');
const LocalSearch = require('../web/traits/local-search.js');

function options(db, overrides = {}) {
  return {
    size: 3,
    maxWaste: 10,
    reqIdx: [],
    poolIdx: db.champions.map((_, index) => index),
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    seed: 1234,
    maxIterations: 12,
    beamWidth: 6,
    ...overrides,
  };
}

test('local search is deterministic with a seed and iteration budget', () => {
  const db = {
    traits: {
      Alpha: { bp: [2], styles: [], desc: '' },
      Beta: { bp: [2], styles: [], desc: '' },
    },
    champions: Array.from({ length: 8 }, (_, index) => ({
      key: `c${index}`,
      name: `C${index}`,
      cost: index % 5 + 1,
      traits: [index % 2 ? 'Alpha' : 'Beta'],
    })),
  };
  const first = LocalSearch.search(db, options(db));
  const second = LocalSearch.search(db, options(db));

  const shape = result => result.rows.map(row => ({
    units: row.units,
    signature: row.signature,
    live: row.live,
    waste: row.waste,
    gold: row.gold,
  }));
  assert.deepEqual(shape(first), shape(second));
  assert.equal(first.seed, 1234);
  assert.equal(first.iterations, 12);
  assert.equal(first.sampled, true);
  assert.equal(first.stopReason, 'iterations');
});

test('local search preserves required units, allowed pool, traits, waste, emblems, and mute semantics', () => {
  const db = {
    traits: {
      Alpha: { bp: [2], styles: [], desc: '' },
      Beta: { bp: [2], styles: [], desc: '' },
      Noise: { bp: [3], styles: [], desc: '' },
    },
    champions: [
      { key: 'required', name: 'Required', cost: 1, traits: ['Alpha'] },
      { key: 'allowed-a', name: 'Allowed A', cost: 2, traits: ['Beta', 'Noise'] },
      { key: 'allowed-b', name: 'Allowed B', cost: 3, traits: ['Beta', 'Noise'] },
      { key: 'forbidden', name: 'Forbidden', cost: 5, traits: ['Alpha', 'Beta'] },
    ],
  };
  const result = LocalSearch.search(db, options(db, {
    reqIdx: [0],
    poolIdx: [1, 2],
    emblems: ['Alpha'],
    reqTraits: [{ t: 1, n: 2 }],
    muted: [2],
    maxWaste: 0,
  }));

  assert.ok(result.rows.length);
  for (const row of result.rows) {
    assert.ok(row.units.includes(0));
    assert.ok(row.units.every(index => [0, 1, 2].includes(index)));
    assert.equal(row.waste, 0);
    assert.equal(row.live, 2);
    assert.ok(row.active.some(([trait, count]) => trait === 0 && count === 2));
    assert.ok(row.active.some(([trait, count]) => trait === 1 && count === 2));
  }
});

test('local search emits only complete boards with forms, multi-slot units, and capacity traits enforced', () => {
  const db = {
    traits: {
      Expand: {
        bp: [2],
        styles: [],
        desc: '',
        teamSize: [{ min: 2, slots: 1 }],
      },
    },
    champions: [
      { key: 'form-a', name: 'Form A', cost: 1, traits: ['Expand'], group: 'form' },
      { key: 'form-b', name: 'Form B', cost: 1, traits: ['Expand'], group: 'form' },
      { key: 'helper', name: 'Helper', cost: 2, traits: ['Expand'] },
      { key: 'giant', name: 'Giant', cost: 5, traits: [], slots: 2 },
      { key: 'filler', name: 'Filler', cost: 1, traits: [] },
    ],
  };
  const result = LocalSearch.search(db, options(db, {
    size: 2,
    maxIterations: 30,
    reqIdx: [],
    seed: 99,
  }));
  const T = BoardScore.tables(db);
  const giantResult = LocalSearch.search(db, options(db, {
    size: 2,
    maxIterations: 2,
    reqIdx: [3],
    poolIdx: [],
  }));

  assert.ok(result.rows.length);
  assert.ok(result.rows.some(row => row.slots === 3), 'capacity-expanded board should be explored');
  assert.deepEqual(giantResult.rows[0].units, [3]);
  assert.equal(giantResult.rows[0].slots, 2);
  for (const row of result.rows) {
    assert.ok(!(row.units.includes(0) && row.units.includes(1)));
    const keys = row.units.map(index => db.champions[index].key);
    assert.equal(BoardScore.validateRoster(db, T, keys, { size: 2 }).error, undefined);
  }
});

test('invalid mutually exclusive required forms fail clearly', () => {
  const db = {
    traits: {},
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: [], group: 'form' },
      { key: 'b', name: 'B', cost: 1, traits: [], group: 'form' },
    ],
  };
  const result = LocalSearch.search(db, options(db, {
    size: 2,
    reqIdx: [0, 1],
    poolIdx: [],
  }));
  assert.match(result.error, /mutually exclusive/i);
});

test('capacity traits can expand a size-12 board beyond 12 champions', () => {
  const db = {
    traits: {
      Expand: {
        bp: [2],
        styles: [],
        desc: '',
        teamSize: [{ min: 2, slots: 2 }],
      },
    },
    champions: Array.from({ length: 14 }, (_, index) => ({
      key: `c${index}`,
      name: `C${index}`,
      cost: 1,
      traits: index < 2 ? ['Expand'] : [],
    })),
  };
  const required = db.champions.map((_, index) => index);
  const result = LocalSearch.search(db, options(db, {
    size: 12,
    reqIdx: required,
    poolIdx: [],
    maxIterations: 1,
  }));
  const T = BoardScore.tables(db);

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].units.length, 14);
  assert.equal(result.rows[0].slots, 14);
  assert.equal(BoardScore.validateRoster(
    db, T, required.map(index => db.champions[index].key), { size: 12 }).error,
  undefined);
});
