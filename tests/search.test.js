const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadWorker() {
  const messages = [];
  const context = vm.createContext({
    performance,
    postMessage(message) {
      messages.push(message);
    },
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', file), 'utf8'), context);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'worker.js'), 'utf8'), context);

  return data => {
    const before = messages.length;
    context.onmessage({ data });
    assert.equal(messages.length, before + 1);
    return messages.at(-1);
  };
}

test('an emblem contributes a trait point', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: { key: 'Alpha', name: 'Alpha', bp: [2], styles: [], desc: '' },
    },
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: ['Alpha'] },
    ],
  };

  assert.equal(send({ type: 'init', db }).type, 'ready');
  const result = send({
    type: 'search',
    id: 1,
    opts: {
      size: 1,
      maxWaste: 0,
      reqIdx: [],
      poolIdx: [0],
      emblems: ['Alpha'],
      reqTraits: [],
      muted: [],
      sortMode: 'live',
      sortMode2: 'cost',
      limit: 100,
      returnN: 100,
      shards: 1,
      shard: 0,
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].live, 1);
  assert.equal(result.rows[0].waste, 0);
});

test('a muted trait contributes neither score nor waste', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: { key: 'Alpha', name: 'Alpha', bp: [2], styles: [], desc: '' },
    },
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: ['Alpha'] },
    ],
  };

  send({ type: 'init', db });
  const base = {
    size: 1,
    maxWaste: 0,
    reqIdx: [],
    poolIdx: [0],
    emblems: [],
    reqTraits: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    shards: 1,
    shard: 0,
  };
  const unmuted = send({ type: 'search', id: 1, opts: { ...base, muted: [] } });
  const muted = send({ type: 'search', id: 2, opts: { ...base, muted: [0] } });

  assert.equal(unmuted.rows.length, 0);
  assert.equal(muted.rows.length, 1);
  assert.equal(muted.rows[0].live, 0);
  assert.equal(muted.rows[0].waste, 0);
});

test('only one shard evaluates a board made entirely of required units', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: { key: 'Alpha', name: 'Alpha', bp: [1], styles: [{ style: 'unique', min: 1 }], desc: '' },
    },
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: ['Alpha'] },
    ],
  };
  const opts = {
    size: 1,
    maxWaste: 0,
    reqIdx: [0],
    poolIdx: [],
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    shards: 2,
  };

  send({ type: 'init', db });
  const first = send({ type: 'search', id: 1, opts: { ...opts, shard: 0 } });
  const second = send({ type: 'search', id: 2, opts: { ...opts, shard: 1 } });

  assert.equal(first.total, 1);
  assert.equal(second.total, 0);
  assert.equal(second.rows.length, 0);
});

test('rich ordering survives the main-thread merge', () => {
  const { comparator } = require('../web/search-utils.js');
  const rows = [
    { live: 1, tierSum: 1, waste: 0, gold: 3 },
    { live: 1, tierSum: 1, waste: 0, gold: 15 },
  ];

  rows.sort(comparator('rich', 'waste'));
  assert.deepEqual(rows.map(row => row.gold), [15, 3]);
});

test('search status never overclaims exact results', () => {
  const { summary } = require('../web/search-utils.js');
  const limited = summary({ rows: [{}], total: 12, ms: 1500, truncated: true });
  const complete = summary({ rows: [{}], total: 12, ms: 1500, truncated: false });

  assert.match(limited.statusHtml, /stopped early/);
  assert.match(limited.title, /unseen boards may rank higher/i);
  assert.doesNotMatch(limited.title, /ranking is exact/i);
  assert.match(complete.title, /completed without hitting/i);
  assert.doesNotMatch(complete.title, /ranking is exact/i);
});

test('Rival scores and cycles only at two units', () => {
  const { breakpoints, scoreFloor, scoringBreakpoints, scoresAt } = require('../web/search-utils.js');
  const rival = {
    bp: [1, 1, 2],
    styles: [],
    desc: 'Only active while fielding 1 Rival.',
  };

  assert.deepEqual(breakpoints(rival), [1, 2]);
  assert.equal(scoreFloor(rival), 2);
  assert.deepEqual(scoringBreakpoints(rival), [2]);
  assert.equal(scoresAt(rival, 1), false);
  assert.equal(scoresAt(rival, 2), true);
});

test('trait signatures include inactive trait counts', () => {
  const { traitSignature } = require('../web/search-utils.js');
  const first = { active: [[0, 2]], dead: [[1, 1]] };
  const second = { active: [[0, 2]], dead: [[2, 1]] };

  assert.notEqual(traitSignature(first), traitSignature(second));
});

test('shard results merge, sort, and retain roster variants', () => {
  const { mergeSearchResults } = require('../web/search-utils.js');
  const first = { units: [0], active: [[0, 2]], dead: [], live: 1, tierSum: 1, waste: 0, gold: 3 };
  const variant = { units: [1], active: [[0, 2]], dead: [], live: 1, tierSum: 1, waste: 0, gold: 6 };
  const better = { units: [2], active: [[1, 3]], dead: [], live: 2, tierSum: 2, waste: 0, gold: 9 };
  first.variants = [variant];
  const merged = mergeSearchResults([
    { rows: [first], total: 2, truncated: false, capped: false, ms: 10 },
    { rows: [better], total: 1, truncated: true, capped: true, ms: 20 },
  ], 'live', 'cost');

  assert.deepEqual(merged.rows.map(row => row.units), [[2], [0]]);
  assert.deepEqual(merged.rows[1].variants.map(row => row.units), [[1]]);
  assert.equal(merged.total, 3);
  assert.equal(merged.truncated, true);
  assert.equal(merged.capped, true);
  assert.equal(merged.ms, 20);
});

test('champions can contribute multiple points to a trait', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: { key: 'Alpha', name: 'Alpha', bp: [2], styles: [], desc: '' },
    },
    champions: [
      { key: 'avatar', name: 'Avatar', cost: 5, traits: ['Alpha'], traitPoints: { Alpha: 2 } },
    ],
  };

  send({ type: 'init', db });
  const result = send({
    type: 'search',
    id: 1,
    opts: {
      size: 1,
      maxWaste: 0,
      reqIdx: [0],
      poolIdx: [],
      emblems: [],
      reqTraits: [],
      muted: [],
      sortMode: 'live',
      sortMode2: 'cost',
      limit: 100,
      returnN: 100,
      shards: 1,
      shard: 0,
    },
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].active[0][1], 2);
  assert.equal(result.rows[0].live, 1);
  assert.equal(result.rows[0].waste, 0);
});

test('champions can consume multiple team slots', () => {
  const send = loadWorker();
  const db = {
    traits: {},
    champions: [
      { key: 'giant', name: 'Giant', cost: 5, traits: [], slots: 2 },
    ],
  };

  send({ type: 'init', db });
  const base = {
    maxWaste: 0,
    reqIdx: [0],
    poolIdx: [],
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    shards: 1,
    shard: 0,
  };
  const valid = send({ type: 'search', id: 1, opts: { ...base, size: 2 } });
  const tooSmall = send({ type: 'search', id: 2, opts: { ...base, size: 1 } });

  assert.equal(valid.error, undefined);
  assert.equal(valid.rows.length, 1);
  assert.equal(valid.rows[0].slots, 2);
  assert.match(tooSmall.error, /required unit slots/i);
});

test('mutually exclusive champion forms cannot share a board', () => {
  const send = loadWorker();
  const db = {
    traits: {},
    champions: [
      { key: 'form-a', name: 'Form A', cost: 5, traits: [], group: 'avatar' },
      { key: 'form-b', name: 'Form B', cost: 5, traits: [], group: 'avatar' },
    ],
  };

  send({ type: 'init', db });
  const base = {
    size: 2,
    maxWaste: 0,
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    shards: 1,
    shard: 0,
  };
  const optional = send({
    type: 'search',
    id: 1,
    opts: { ...base, reqIdx: [], poolIdx: [0, 1] },
  });
  const required = send({
    type: 'search',
    id: 2,
    opts: { ...base, reqIdx: [0, 1], poolIdx: [] },
  });

  assert.equal(optional.rows.length, 0);
  assert.match(required.error, /mutually exclusive/i);
});

test('trait breakpoints can increase maximum team size', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: {
        key: 'Alpha',
        name: 'Alpha',
        bp: [2],
        styles: [],
        desc: '',
        teamSize: [{ min: 2, slots: 1 }],
      },
    },
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: ['Alpha'] },
      { key: 'b', name: 'B', cost: 1, traits: ['Alpha'] },
      { key: 'c', name: 'C', cost: 1, traits: ['Alpha'] },
    ],
  };

  send({ type: 'init', db });
  const result = send({
    type: 'search',
    id: 1,
    opts: {
      size: 2,
      maxWaste: 1,
      reqIdx: [],
      poolIdx: [0, 1, 2],
      emblems: [],
      reqTraits: [],
      muted: [],
      sortMode: 'live',
      sortMode2: 'cost',
      limit: 100,
      returnN: 100,
      shards: 1,
      shard: 0,
    },
  });

  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0].units, [0, 1, 2]);
  assert.equal(result.rows[0].slots, 3);
});

test('a team-size bonus cannot bootstrap its own breakpoint', () => {
  const send = loadWorker();
  const db = {
    traits: {
      Alpha: {
        key: 'Alpha',
        name: 'Alpha',
        bp: [3],
        styles: [],
        desc: '',
        teamSize: [{ min: 3, slots: 1 }],
      },
    },
    champions: [
      { key: 'a', name: 'A', cost: 1, traits: ['Alpha'] },
      { key: 'b', name: 'B', cost: 1, traits: ['Alpha'] },
      { key: 'c', name: 'C', cost: 1, traits: ['Alpha'] },
    ],
  };

  send({ type: 'init', db });
  const result = send({
    type: 'search',
    id: 1,
    opts: {
      size: 2,
      maxWaste: 3,
      reqIdx: [0, 1, 2],
      poolIdx: [],
      emblems: [],
      reqTraits: [],
      muted: [],
      sortMode: 'live',
      sortMode2: 'cost',
      limit: 100,
      returnN: 100,
      shards: 1,
      shard: 0,
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 0);
});

test('Set 18 Avatar and Apex Predator rules reach the worker', () => {
  const send = loadWorker();
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data.json'), 'utf8'));
  const champion = key => db.champions.findIndex(entry => entry.key === key);
  const traitKeys = Object.keys(db.traits);
  const base = {
    maxWaste: 10,
    poolIdx: [],
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    returnN: 100,
    shards: 1,
    shard: 0,
  };

  send({ type: 'init', db });
  const avatar = send({
    type: 'search',
    id: 1,
    opts: {
      ...base,
      size: 2,
      reqIdx: [champion('Karma'), champion('LuxBlossom')],
      reqTraits: [{ t: traitKeys.indexOf('Blossom'), n: 3 }],
    },
  });
  const apexPredator = send({
    type: 'search',
    id: 2,
    opts: { ...base, size: 2, maxWaste: 0, reqIdx: [champion('ElderDragon')] },
  });
  const conflictingAvatars = send({
    type: 'search',
    id: 3,
    opts: {
      ...base,
      size: 2,
      reqIdx: [champion('LuxBlossom'), champion('LuxCoven')],
    },
  });

  assert.equal(avatar.rows.length, 1);
  assert.ok(avatar.rows[0].active.some(([trait, count]) =>
    traitKeys[trait] === 'Blossom' && count === 3));
  assert.equal(apexPredator.rows.length, 1);
  assert.equal(apexPredator.rows[0].slots, 2);
  assert.ok(apexPredator.rows[0].active.some(([trait, count]) =>
    traitKeys[trait] === 'Riftbeast' && count === 3));
  assert.match(conflictingAvatars.error, /mutually exclusive/i);
});

test('search cache keys normalize unordered options', () => {
  const { searchCacheKey } = require('../web/search-utils.js');
  const base = {
    size: 8,
    maxWaste: 2,
    reqIdx: [5, 1],
    poolIdx: [3, 2],
    emblems: ['Beta', 'Alpha', 'Alpha'],
    reqTraits: [{ t: 4, n: 2 }, { t: 1, n: 3 }],
    muted: [7, 6],
    sortMode: 'live',
    sortMode2: 'cost',
  };
  const reordered = {
    ...base,
    reqIdx: [1, 5],
    poolIdx: [2, 3],
    emblems: ['Alpha', 'Beta', 'Alpha'],
    reqTraits: [{ t: 1, n: 3 }, { t: 4, n: 2 }],
    muted: [6, 7],
  };

  assert.equal(searchCacheKey('data-v1', base), searchCacheKey('data-v1', reordered));
  assert.notEqual(searchCacheKey('data-v1', base),
    searchCacheKey('data-v1', { ...base, sortMode: 'tier' }));
  assert.notEqual(searchCacheKey('data-v1', base), searchCacheKey('data-v2', base));
});

test('cached search status identifies its source', () => {
  const { summary } = require('../web/search-utils.js');
  const memory = summary({ rows: [{}], total: 1, ms: 1000, truncated: false, cached: 'memory' });
  const disk = summary({ rows: [{}], total: 1, ms: 1000, truncated: false, cached: 'device' });
  const precomputed = summary({
    rows: [{}], total: 1, ms: 0, truncated: false, cached: 'precomputed',
  });

  assert.match(memory.statusHtml, /cached/);
  assert.match(memory.title, /memory/i);
  assert.match(disk.title, /device/i);
  assert.match(precomputed.title, /precomputed/i);
});
