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
