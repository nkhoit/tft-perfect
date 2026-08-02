const assert = require('node:assert/strict');
const test = require('node:test');

const { compSignature, toggleSelection } = require('../web/traits/search-utils.js');

// A comp's identity is its roster, not the order the search happened to emit
// units in. If this breaks, pinned comps silently duplicate or fail to match
// their result row after a re-search.
test('comp signature is order-independent and duplicate-sensitive', () => {
  assert.equal(compSignature([3, 1, 2]), compSignature([1, 2, 3]));
  assert.equal(compSignature([10, 2]), '2,10');
  assert.notEqual(compSignature([1, 2, 3]), compSignature([1, 2, 4]));
  assert.notEqual(compSignature([1, 2, 2]), compSignature([1, 2]));
  assert.equal(compSignature([]), '');
});

test('comp signature does not mutate the caller units array', () => {
  const units = [5, 1, 3];
  compSignature(units);
  assert.deepEqual(units, [5, 1, 3]);
});

test('toggleSelection adds a row, reports the new state, and is keyed by signature', () => {
  const selected = new Map();
  const row = { units: [3, 1, 2], score: 12 };
  const sig = compSignature(row.units);

  assert.equal(toggleSelection(selected, sig, row), true);
  assert.equal(selected.size, 1);
  assert.equal(selected.get(sig), row);

  assert.equal(toggleSelection(selected, sig, row), false);
  assert.equal(selected.size, 0);
});

test('toggleSelection matches an equivalent roster emitted in a different order', () => {
  const selected = new Map();
  const first = { units: [4, 2, 7] };
  const reordered = { units: [7, 4, 2] };

  toggleSelection(selected, compSignature(first.units), first);
  // A later search returns the same roster in another order: it must be seen
  // as already selected rather than pinned a second time.
  assert.equal(selected.has(compSignature(reordered.units)), true);
  assert.equal(toggleSelection(selected, compSignature(reordered.units), reordered), false);
  assert.equal(selected.size, 0);
});

test('toggleSelection ignores a missing row instead of storing a hole', () => {
  const selected = new Map();
  assert.equal(toggleSelection(selected, '1,2', null), false);
  assert.equal(selected.size, 0);
  assert.equal(toggleSelection(selected, '1,2', undefined), false);
  assert.equal(selected.size, 0);
});

test('selections are independent across distinct comps and survive each other', () => {
  const selected = new Map();
  const a = { units: [1, 2] };
  const b = { units: [3, 4] };

  toggleSelection(selected, compSignature(a.units), a);
  toggleSelection(selected, compSignature(b.units), b);
  assert.equal(selected.size, 2);

  toggleSelection(selected, compSignature(a.units), a);
  assert.equal(selected.size, 1);
  assert.equal(selected.get(compSignature(b.units)), b);
  // Insertion order is the pin order shown in the SELECTED section.
  assert.deepEqual([...selected.keys()], ['3,4']);
});
