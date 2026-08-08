import assert from 'node:assert/strict';
import test from 'node:test';

import DATA from '../web/coven/coven-data.js';
import Sim from '../web/coven/coven-sim.js';

// The rates that shipped in the 8/5 patch notes. CDragon and MetaTFT both
// still reported the previous numbers, and data.json had a third answer, so
// this pins the values the whole calculator is derived from.
test('rates and thresholds match the patch notes', () => {
  assert.deepEqual(DATA.THRESHOLDS,
    [40, 85, 130, 185, 250, 365, 500, 650, 800]);
  assert.deepEqual(DATA.RATES[5], { kill: 3, loss: 30 });
  assert.deepEqual(DATA.RATES[7], { kill: 10, loss: 80 });
});

// Player damage is base(stage) + surviving units. A stage-2 loss costs 4 HP
// and a stage-5 loss costs 16: averaging them to a single number hides the
// entire strategic shape, which is why the sim never uses a constant.
test('loss damage scales with stage and survivors', () => {
  assert.equal(Sim.lossDamage(2, 4), 4, 'stage 2 vs 4 units');
  assert.equal(Sim.lossDamage(3, 6), 8, 'stage 3 vs 6 units');
  assert.equal(Sim.lossDamage(4, 8), 14, 'stage 4 vs 8 units');
  assert.equal(Sim.lossDamage(5, 9), 16, 'stage 5 vs 9 units');
  assert.ok(Sim.lossDamage(5, 9) > 3 * Sim.lossDamage(2, 4),
    'a late loss must cost far more than an early one');
});

// You need 7 Coven bodies to run 7 Coven, so level caps the tier. The first
// draft of this simulator reported 7 Coven active on 2-1 at level 4, which
// produced impossible essence totals -- this is the guard for that bug.
test('Coven tier is capped by board size', () => {
  assert.equal(Sim.maxTier(4), 4, 'level 4 cannot run 5 Coven');
  assert.equal(Sim.maxTier(6), 5, 'level 6 cannot run 7 Coven');
  assert.equal(Sim.maxTier(7), 7);
  assert.equal(Sim.maxTier(2), 0, 'below 3 bodies the trait is inactive');

  const run = Sim.project({ hp: 100, essence: 0, killsPerRound: 0 });
  const early = run.timeline.filter(r => r.stage === 2);
  assert.ok(early.length > 0, 'stage 2 rounds must be simulated');
  assert.ok(early.every(r => r.tier <= 5),
    'no stage-2 round may field more Coven than its level allows');
});

// The level curve drives everything downstream: it sets HP per loss AND the
// Coven tier you can field, so the two must move together.
test('the standard curve levels on Khoi schedule', () => {
  const c = Sim.STANDARD_CURVE;
  assert.equal(Sim.levelAt(c, { stage: 2, round: 1 }), 4);
  assert.equal(Sim.levelAt(c, { stage: 3, round: 2 }), 6);
  assert.equal(Sim.levelAt(c, { stage: 3, round: 6 }), 7);
  assert.equal(Sim.levelAt(c, { stage: 4, round: 2 }), 8);
});

// Carousel and PvE rounds cost no HP and bank no loss essence.
test('only PvP rounds are simulated', () => {
  assert.ok(Sim.ROUNDS.every(r => r.round !== 4),
    'round 4 of each stage is a carousel');
});

// Surviving a cashout on 1 HP is not the same as affording it. The band must
// distinguish 'safe' from 'you live but the next loss kills you'.
test('a cashout that leaves you on fumes is flagged risky', () => {
  const b = Sim.band({ hp: 68, essence: 186, from: { stage: 3, round: 5 }, tier: 5 },
    [0, 2, 4]);
  const l5 = b[4], l6 = b[5];
  assert.ok(l5 && l5.alive && !l5.risky, 'L5 has real headroom');
  assert.ok(l6 && l6.alive && l6.risky,
    'L6 lands in single digits and must not read as safe');
  assert.ok(l6.hpWorst < l5.hpWorst, 'greeding deeper must cost HP');
});

// The whole reason kills are a band and not a prediction: their influence is
// negligible where the decision is easy and only bites where you already die.
test('kill variance widens as you greed deeper', () => {
  const b = Sim.band({ hp: 100, essence: 0 }, [0, 2, 4, 6]);
  const spread = i => b[i] ? b[i].hpBest - b[i].hpWorst : null;
  assert.equal(spread(0), 0, 'the first cashout is unaffected by kills');
  assert.ok(spread(5) > spread(2),
    'deep cashouts must carry more kill-driven uncertainty');
});

// A curve keyed by level ({6: {...}}) instead of an ordered array reads as
// length 0 and silently pins every round at level 4 -- a whole different game,
// with no error. This shape mistake must be loud.
test('a malformed level curve is rejected, not silently ignored', () => {
  assert.throws(
    () => Sim.project({ hp: 100, curve: { 6: { stage: 3, round: 2 } } }),
    /curve must be a non-empty array/,
    'an object keyed by level is not a curve');
  assert.throws(
    () => Sim.project({ hp: 100, curve: [] }),
    /curve must be a non-empty array/);
});

// 'Unreachable' hides two different answers. Running out of rounds and dying
// on the way are opposite decisions -- one says wait, the other says stop.
test('a cashout that kills you is distinguished from one the clock beats', () => {
  const lethal = Sim.band({ hp: 100, essence: 0, from: { stage: 2, round: 5 }, tier: 5 },
    [0]);
  const deep = lethal[8];
  assert.ok(deep && deep.unreached, 'L9 is not reached from a stage-2 start');
  assert.equal(deep.fatal, true, 'you die on the way, the clock is not the reason');

  // Starting late in the game leaves too few rounds, but plenty of health.
  const late = Sim.band({ hp: 100, essence: 0, from: { stage: 7, round: 7 }, tier: 5 },
    [0]);
  const l1 = late[0];
  assert.ok(l1 && l1.unreached, 'no rounds left after 7-7 to bank 40 essence');
  assert.equal(l1.fatal, false, 'the game ending is not the same as dying');
});
