const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const BoardScore = require('../web/traits/board-score.js');
const data = require('../web/traits/data.json');
const precomputed = require('../web/traits/precomputed-default.json');

const tables = BoardScore.tables(data);
const comparable = row => ({
  active: row.active,
  dead: row.dead,
  over: row.over,
  live: row.live,
  uniqN: row.uniqN,
  waste: row.waste,
  tierSum: row.tierSum,
  gold: row.gold,
  slots: row.slots,
});

test('shared scorer matches shipped DFS rows', () => {
  for (const expected of precomputed.result.rows) {
    const keys = expected.units.map(index => data.champions[index].key);
    const validated = BoardScore.validateRoster(data, tables, keys, {
      size: 8,
      emblems: [],
      muted: [],
    });
    assert.equal(validated.error, undefined, `${keys.join(', ')} should be valid`);
    assert.deepEqual(comparable(validated.row), comparable(expected));
  }
});

test('shared roster validation rejects impossible boards', () => {
  assert.match(BoardScore.validateRoster(data, tables, ['Shen', 'Shen'], {
    size: 2,
  }).error, /duplicate/i);
  assert.match(BoardScore.validateRoster(data, tables, ['LuxBlossom', 'LuxCoven'], {
    size: 2,
  }).error, /Lux/i);
  assert.match(BoardScore.validateRoster(data, tables, ['Shen'], {
    size: 8,
  }).error, /slots/i);
  assert.match(BoardScore.validateRoster(data, tables, ['NotAChampion'], {
    size: 2,
  }).error, /unknown/i);
});

test('shared validation handles weighted slots and trait points', () => {
  const validated = BoardScore.validateRoster(data, tables, ['ElderDragon'], {
    size: 2,
    emblems: [],
    muted: [],
  });
  assert.equal(validated.error, undefined);
  assert.equal(validated.row.slots, 2);
  const riftbeast = tables.traitIndex.get('Riftbeast');
  assert.ok(validated.row.active.some(([trait, count]) =>
    trait === riftbeast && count === 3));
});
