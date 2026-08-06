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

// Chance of seeing at least one copy across `rolls` shop refreshes.
//
// Treats each shop as independent, which is how the game actually deals them:
// a reroll re-deals all 5 slots from the pool. Copies you buy mid-rolldown do
// shrink the pool, but modelling that requires knowing what you buy and when --
// this is the standard approximation every roll calculator uses.
function rollChance(cost, level, rolls, opts) {
  const perShop = shopChance(cost, level, opts);
  return 1 - Math.pow(1 - perShop, Math.max(0, rolls));
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
  const perShop = shopChance(cost, level, opts);
  if (perShop <= 0) return null;
  if (perShop >= 1) return { rolls: 1, gold: 2 };
  const rolls = Math.ceil(Math.log(1 - confidence) / Math.log(1 - perShop));
  return { rolls, gold: rolls * 2 };
}

// Full curve of cumulative hit chance per roll, for charting.
function curve(cost, level, rolls, opts) {
  const perShop = shopChance(cost, level, opts);
  const out = [];
  for (let i = 1; i <= rolls; i++) {
    out.push({ roll: i, gold: i * 2, chance: 1 - Math.pow(1 - perShop, i) });
  }
  return out;
}

const api = {
  SHOP_ODDS, POOL_COPIES, POOL_TYPES, SLOTS, MIN_LEVEL, MAX_LEVEL,
  levelOdds, slotChance, shopChance, rollChance, expectedCopies, goldFor, curve,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.RollOdds = api;
