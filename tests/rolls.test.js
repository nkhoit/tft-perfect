'use strict';
const test = require('node:test');
const assert = require('node:assert');
const odds = require('../web/rolls/odds.js');

test('every level odds row sums to exactly 100%', () => {
  for (let lv = odds.MIN_LEVEL; lv <= odds.MAX_LEVEL; lv++) {
    const sum = odds.levelOdds(lv).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 100, `level ${lv} sums to ${sum}`);
  }
});

test('pool constants match the Set 18 roster in data.json', () => {
  const data = require('../web/traits/data.json');
  // The shop treats Lux's nine Origin forms as one champion, so collapse by
  // `group` before counting -- otherwise 5-costs look like 18 types, not 10.
  const seen = new Set();
  const counts = {};
  for (const c of data.champions) {
    const id = c.group || c.key;
    if (seen.has(id)) continue;
    seen.add(id);
    counts[c.cost] = (counts[c.cost] || 0) + 1;
  }
  assert.deepStrictEqual(counts, odds.POOL_TYPES);
});

test('a level with 0% odds for a cost is impossible, not merely unlikely', () => {
  // Level 5 cannot roll 5-costs at all.
  assert.strictEqual(odds.slotChance(5, 5), 0);
  assert.strictEqual(odds.shopChance(5, 5), 0);
  assert.strictEqual(odds.rollChance(5, 5, 1000), 0);
  // And no amount of gold changes that.
  assert.strictEqual(odds.goldFor(5, 5, 0.9), null);
});

test('slot chance matches a hand-computed value', () => {
  // Level 8, 4-cost: 24% tier odds, 10 copies of the target,
  // 14 types x 10 copies = 140 in the tier.
  const expected = 0.24 * (10 / 140);
  assert.ok(Math.abs(odds.slotChance(4, 8) - expected) < 1e-12);
});

test('more rolls never lowers the hit chance, and converges toward 1', () => {
  let prev = 0;
  for (const r of [1, 5, 10, 25, 50, 200]) {
    const p = odds.rollChance(4, 8, r);
    assert.ok(p >= prev, `chance dropped at ${r} rolls`);
    prev = p;
  }
  assert.ok(prev > 0.99, `200 rolls should be near-certain, got ${prev}`);
});

test('copies already taken lower your odds', () => {
  const fresh = odds.slotChance(4, 8);
  const picked = odds.slotChance(4, 8, { taken: 5 });
  assert.ok(picked < fresh);
  // All ten copies gone means the champion cannot appear.
  assert.strictEqual(odds.slotChance(4, 8, { taken: 10 }), 0);
});

test('rivals holding OTHER units at your cost improves your odds', () => {
  // This is the counter-intuitive one worth encoding: contested tiers help you
  // when the contested units are not the one you want, because the tier pool
  // shrinks while your champion's copies stay put.
  const fresh = odds.slotChance(4, 8);
  const thinned = odds.slotChance(4, 8, { contested: 40 });
  assert.ok(thinned > fresh, 'a thinner tier should raise your share');
});

test('goldFor inverts rollChance consistently', () => {
  for (const conf of [0.5, 0.75, 0.9, 0.99]) {
    const { rolls } = odds.goldFor(4, 8, conf);
    assert.ok(odds.rollChance(4, 8, rolls) >= conf, `${conf} not met at ${rolls} rolls`);
    assert.ok(odds.rollChance(4, 8, rolls - 1) < conf, `${conf} met too early`);
  }
});

test('gold is two per roll', () => {
  const { rolls, gold } = odds.goldFor(4, 8, 0.9);
  assert.strictEqual(gold, rolls * 2);
});

test('expected copies scales linearly with rolls', () => {
  const one = odds.expectedCopies(4, 8, 1);
  assert.ok(Math.abs(odds.expectedCopies(4, 8, 10) - one * 10) < 1e-12);
});

test('curve is monotonic and ends at the cumulative chance', () => {
  const c = odds.curve(4, 8, 20);
  assert.strictEqual(c.length, 20);
  for (let i = 1; i < c.length; i++) {
    assert.ok(c[i].chance >= c[i - 1].chance, 'curve dipped');
  }
  const last = c[c.length - 1];
  assert.ok(Math.abs(last.chance - odds.rollChance(4, 8, 20)) < 1e-12);
  assert.strictEqual(last.gold, 40);
});

test('closed-form odds match a Monte Carlo simulation', () => {
  // The formulas above are exact combinatorics; this deals actual random shops
  // and checks the analytic answer against observed frequency. Catches sign
  // errors and off-by-one slot counts that hand-picked cases can miss.
  const COST = 4, LEVEL = 8, ROLLS = 6, TRIALS = 200000;
  const row = odds.levelOdds(LEVEL);
  const cum = [];
  let acc = 0;
  for (const pct of row) { acc += pct; cum.push(acc); }

  // Deterministic PRNG so a bad seed can't make CI flaky. mulberry32 --
  // a plain LCG is NOT usable here: its low bits are weakly random, and this
  // test draws twice per slot, so the correlation between consecutive draws
  // skewed the result ~4 points high and looked like a formula bug.
  let seed = 12345;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const targetCopies = odds.POOL_COPIES[COST];
  const tierTotal = targetCopies * odds.POOL_TYPES[COST];
  let hits = 0;
  for (let t = 0; t < TRIALS; t++) {
    let found = false;
    for (let r = 0; r < ROLLS && !found; r++) {
      for (let s = 0; s < odds.SLOTS; s++) {
        const pick = rand() * 100;
        let cost = 1;
        while (cost <= 5 && pick > cum[cost - 1]) cost++;
        if (cost !== COST) continue;
        // Slot landed on our tier; is it our champion?
        if (rand() * tierTotal < targetCopies) { found = true; break; }
      }
    }
    if (found) hits++;
  }

  const observed = hits / TRIALS;
  const analytic = odds.rollChance(COST, LEVEL, ROLLS);
  assert.ok(Math.abs(observed - analytic) < 0.01,
    `simulation ${observed.toFixed(4)} vs analytic ${analytic.toFixed(4)}`);
});
