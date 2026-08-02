const assert = require('node:assert/strict');
const test = require('node:test');

const SavedSearches = require('../web/traits/saved-searches.js');

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('saved searches persist, deduplicate, and rename matching state', () => {
  const store = storage();
  SavedSearches.upsert(store, { name: 'First', token: 'rYWJj' }, 1);
  SavedSearches.upsert(store, { name: 'Renamed', token: 'rYWJj' }, 2);

  const entries = SavedSearches.load(store);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Renamed');
  assert.equal(entries[0].updatedAt, 2);
});

test('saved searches retain only the newest bounded set', () => {
  const store = storage();
  for (let i = 1; i <= SavedSearches.LIMIT + 3; i++) {
    SavedSearches.upsert(store, { name: `Search ${i}`, token: `r${i}` }, i);
  }

  const entries = SavedSearches.load(store);
  assert.equal(entries.length, SavedSearches.LIMIT);
  assert.equal(entries[0].name, `Search ${SavedSearches.LIMIT + 3}`);
  assert.equal(entries.at(-1).name, 'Search 4');
});

test('saved searches can be removed and reject corrupt storage', () => {
  const store = storage();
  const [entry] = SavedSearches.upsert(store, { name: 'Delete me', token: 'rYWJj' }, 1);
  assert.deepEqual(SavedSearches.remove(store, entry.id), []);

  store.setItem(SavedSearches.STORAGE_KEY, '{bad');
  assert.throws(() => SavedSearches.load(store), /corrupted/i);
});
