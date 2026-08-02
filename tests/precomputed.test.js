const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const data = require('../web/data.json');
const precomputed = require('../web/precomputed-default.json');
const SearchUtils = require('../web/search-utils.js');

function defaultOptions() {
  return {
    size: 8,
    maxWaste: 10,
    reqIdx: [],
    poolIdx: data.champions.map((champion, index) =>
      champion.cost >= 1 && champion.cost <= 5 ? index : -1)
      .filter(index => index >= 0),
    emblems: [],
    reqTraits: [],
    muted: [],
    sortMode: 'live',
    sortMode2: 'cost',
    limit: 100,
    uniq: true,
    returnN: 100,
    shards: 8,
  };
}

test('precomputed landing result matches data and search versions', () => {
  const version = `${SearchUtils.algorithmVersion}:${data.builtAt}`;
  assert.equal(precomputed.schemaVersion, 1);
  assert.equal(precomputed.algorithmVersion, SearchUtils.algorithmVersion);
  assert.equal(precomputed.dataBuiltAt, data.builtAt);
  assert.equal(precomputed.queryKey, SearchUtils.searchCacheKey(version, defaultOptions()));
  assert.equal(precomputed.result.rows.length, 100);
  assert.ok(precomputed.result.total > 0);
  assert.equal(precomputed.result.ms, 0);
});

test('precomputed landing rows are globally deduplicated', () => {
  const signatures = precomputed.result.rows.map(SearchUtils.traitSignature);
  assert.equal(new Set(signatures).size, signatures.length);
});
