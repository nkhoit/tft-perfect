// Shop odds and pool maths for Teamfight Tactics Set 18.
//
// Everything here is exact combinatorics over a finite pool -- no simulation,
// no sampling. The shop deals 5 independent slots; each slot first picks a cost
// tier by the level's odds row, then picks a champion uniformly at random from
// the *remaining copies* of that tier across the whole lobby.
//
// Sources (verified 2026-08-05):
//   - Shop odds per level: tftips.app Set 18 table, cross-checked against
//     tft.ninja ("level 8 with 22% four-cost odds").
//   - Pool copies per champion: tftips.app Set 18 (29/22/18/10/9).
//   - Distinct champions per cost: derived from our own data.json roster,
//     collapsing Lux's 9 Origin forms into one champion. Yields 14/13/14/14/10
//     = 65, matching tftsense.gg's published Set 18 list exactly.

'use strict';

// Percent chance a single shop slot rolls each cost tier, indexed by level.
const SHOP_ODDS = {
  1:  [100, 0, 0, 0, 0],
  2:  [100, 0, 0, 0, 0],
  3:  [75, 25, 0, 0, 0],
  4:  [55, 30, 15, 0, 0],
  5:  [45, 33, 20, 2, 0],
  6:  [30, 40, 25, 5, 0],
  7:  [19, 30, 35, 15, 1],
  8:  [17, 24, 32, 24, 3],
  9:  [15, 18, 25, 30, 12],
  10: [5, 10, 20, 40, 25],
  11: [1, 2, 12, 50, 35],
};

// Copies of each individual champion in the shared lobby pool, by cost.
const POOL_COPIES = { 1: 29, 2: 22, 3: 18, 4: 10, 5: 9 };

// Distinct champions at each cost in Set 18.
const POOL_TYPES = { 1: 14, 2: 13, 3: 14, 4: 14, 5: 10 };

const SLOTS = 5;
const MIN_LEVEL = 1;
const MAX_LEVEL = 11;

function levelOdds(level) {
  const row = SHOP_ODDS[level];
  if (!row) throw new RangeError(`no shop odds for level ${level}`);
  return row;
}

// Chance one slot shows a *specific* champion.
//
// Two independent things must happen: the slot rolls this champion's cost
// tier, and then picks this champion out of the tier's remaining pool.
//
//   taken    -- copies of the target already owned by anyone (you or rivals)
//   contested -- copies of *other* champions at this cost removed from the pool
//
// Both shrink the denominator; only `taken` shrinks the numerator. That
// asymmetry is why a contested tier still helps you once rivals hold units you
// don't want -- the tier is smaller, so your target is a bigger slice of it.
function slotChance(cost, level, { taken = 0, contested = 0 } = {}) {
  const tierPct = levelOdds(level)[cost - 1] / 100;
  if (tierPct === 0) return 0;

  const copies = POOL_COPIES[cost];
  const types = POOL_TYPES[cost];
  const remainingTarget = Math.max(0, copies - taken);
  const remainingTier = Math.max(0, copies * types - taken - contested);
  if (remainingTier === 0 || remainingTarget === 0) return 0;

  return tierPct * (remainingTarget / remainingTier);
}

// Chance of seeing at least one copy across a full 5-slot shop.
function shopChance(cost, level, opts) {
  const p = slotChance(cost, level, opts);
  return 1 - Math.pow(1 - p, SLOTS);
}

// How many copies a champion needs to reach a star level. A 1-cost 3-star is
// nine copies, which is why hitting one is a whole gameplan rather than a
// rolldown.
const COPIES_FOR_STAR = { 1: 1, 2: 3, 3: 9 };

// Chance of seeing AT LEAST `need` copies across `rolls` shop refreshes.
//
// Each reroll re-deals all 5 slots, and within this model every slot is an
// independent draw at probability p. So the copies seen over N shops is just
// Binomial(5N, p), and "did I hit 2-star" is its upper tail at need = 3.
//
// The one-copy case reduces to 1 - (1-p)^(5N), which is what the old
// closed form computed -- this is a strict generalisation, not a rewrite.
//
// Caveat unchanged from before: copies you buy mid-rolldown shrink the pool,
// but modelling that needs to know what you buy and when. Every roll
// calculator makes the same independence approximation.
function binomialAtLeast(n, p, need) {
  if (need <= 0) return 1;
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n >= need ? 1 : 0;
  if (need > n) return 0;

  // Sum the lower tail P(X < need) term by term, then complement. `need` is
  // at most 9, so this is a handful of iterations regardless of n.
  const q = 1 - p;
  let term = Math.pow(q, n);          // i = 0
  let lower = term;
  for (let i = 0; i < need - 1; i++) {
    term *= ((n - i) / (i + 1)) * (p / q);
    lower += term;
  }
  return Math.max(0, Math.min(1, 1 - lower));
}

function rollChance(cost, level, rolls, opts) {
  const { need = 1 } = opts || {};
  const p = slotChance(cost, level, opts);
  return binomialAtLeast(SLOTS * Math.max(0, rolls), p, need);
}

// Expected number of copies seen over `rolls` shops.
function expectedCopies(cost, level, rolls, opts) {
  return slotChance(cost, level, opts) * SLOTS * Math.max(0, rolls);
}

// Gold needed for a given confidence of hitting at least one copy.
//
// Inverts rollChance: solve (1 - perShop)^rolls <= 1 - target for rolls.
// Returns null when the odds are zero, since no amount of gold suffices.
function goldFor(cost, level, confidence, opts) {
  const { need = 1 } = opts || {};
  const p = slotChance(cost, level, opts);
  if (p <= 0) return null;

  // For need = 1 the closed form inverts directly. For more copies the
  // binomial tail has no clean inverse, so walk rolls upward -- the answer is
  // bounded by the cap below and each step is a few multiplications.
  if (need === 1) {
    const perShop = shopChance(cost, level, opts);
    if (perShop >= 1) return { rolls: 1, gold: 2 };
    const rolls = Math.ceil(Math.log(1 - confidence) / Math.log(1 - perShop));
    return { rolls, gold: rolls * 2 };
  }

  // A hard ceiling keeps this terminating even for absurd asks (99% on a
  // 3-star 5-cost). Beyond it the honest answer is "not happening".
  const MAX_ROLLS = 100000;
  for (let r = 1; r <= MAX_ROLLS; r++) {
    if (binomialAtLeast(SLOTS * r, p, need) >= confidence) {
      return { rolls: r, gold: r * 2 };
    }
  }
  return null;
}

// Full curve of cumulative hit chance per roll, for charting.
function curve(cost, level, rolls, opts) {
  const { need = 1 } = opts || {};
  const p = slotChance(cost, level, opts);
  const out = [];
  for (let i = 1; i <= rolls; i++) {
    out.push({ roll: i, gold: i * 2, chance: binomialAtLeast(SLOTS * i, p, need) });
  }
  return out;
}

const api = {
  SHOP_ODDS, POOL_COPIES, POOL_TYPES, SLOTS, MIN_LEVEL, MAX_LEVEL,
  COPIES_FOR_STAR,
  levelOdds, slotChance, shopChance, rollChance, expectedCopies, goldFor,
  curve, binomialAtLeast,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.RollOdds = api;
