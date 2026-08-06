const assert = require('node:assert/strict');
const test = require('node:test');

const SearchUtils = require('../web/traits/search-utils.js');

// Every sort key is score-based. Two boards that tie on all of them used to
// compare 0, leaving their relative order to whatever the engines happened to
// emit -- and both engines are wall-clock bounded, so that order varied between
// identical runs. A canonical identity tiebreaker makes the ranking a total
// order: same candidate set in, same list out.
function row(units, extra) {
  return Object.assign({
    units,
    live: 13,
    tierSum: 40,
    waste: 2,
    gold: 30,
  }, extra || {});
}

test('boards tying on every score key are ordered by canonical identity', () => {
  const compare = SearchUtils.comparator('live', 'tier');
  const a = row([5, 2, 9]);
  const b = row([1, 7, 3]);

  assert.notEqual(compare(a, b), 0,
    'identical-scoring boards must not compare equal, or their order is arbitrary');
  // Antisymmetry: the comparator must disagree with itself when arguments swap.
  assert.equal(Math.sign(compare(a, b)), -Math.sign(compare(b, a)));

  // The winner is decided by the sorted-unit signature, not argument order.
  const expected = SearchUtils.compSignature(a.units) < SearchUtils.compSignature(b.units) ? a : b;
  assert.equal([a, b].sort(compare)[0], expected);
  assert.equal([b, a].sort(compare)[0], expected);
});

test('the identity tiebreaker never overrides a real score difference', () => {
  const compare = SearchUtils.comparator('live', 'tier');
  // `a` has the signature that would win a tie, but a strictly worse score.
  const a = row([0, 0, 0], { live: 12 });
  const b = row([9, 9, 9], { live: 13 });
  assert.ok(compare(a, b) > 0, 'more live traits must still rank first');
  assert.ok(compare(b, a) < 0);
});

test('sorting a shuffled candidate set is order-independent', () => {
  const compare = SearchUtils.comparator('live', 'tier');
  const rows = [
    row([4, 1]), row([9, 2]), row([3, 3]),
    row([8, 5], { waste: 1 }), row([7, 6], { live: 14 }),
  ];
  const key = list => list.map(r => SearchUtils.compSignature(r.units)).join('|');

  const baseline = key([...rows].sort(compare));
  // Every rotation of the same set must produce the identical ranking.
  for (let i = 1; i < rows.length; i++) {
    const rotated = [...rows.slice(i), ...rows.slice(0, i)];
    assert.equal(key(rotated.sort(compare)), baseline);
  }
  assert.equal(key([...rows].reverse().sort(compare)), baseline);
});
