// Coven cashout simulator.
//
// The question this answers is not "how much essence do I have" but "can I
// afford the cashout I want". Losses are worth 20-80x a kill, so essence is
// bought with HP, and the exchange rate moves every stage.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./coven-data.js"));
  } else {
    root.CovenSim = factory(root.CovenData);
  }
}(typeof self !== "undefined" ? self : this, function (DATA) {
  "use strict";

  // PvP rounds only. Carousels and PvE rounds cost no HP and bank no loss
  // essence, so they are absent by construction rather than filtered later.
  var ROUNDS = [];
  [[2, [1, 2, 3, 5, 6, 7]],
   [3, [1, 2, 3, 5, 6, 7]],
   [4, [1, 2, 3, 5, 6, 7]],
   [5, [1, 2, 3, 5, 6, 7]],
   [6, [1, 2, 3, 5, 6, 7]],
   [7, [1, 2, 3, 5, 6, 7]]].forEach(function (pair) {
    pair[1].forEach(function (r) { ROUNDS.push({ stage: pair[0], round: r }); });
  });

  // Khoi's standard curve: players spend gold above 50 on levels, not rolls.
  // lv4 by 2-1, lv6 by 3-2, lv7 by 3-6, lv8 by 4-2, lv9 by 5-1.
  var STANDARD_CURVE = [
    { stage: 2, round: 1, level: 4 },
    { stage: 2, round: 5, level: 5 },
    { stage: 3, round: 2, level: 6 },
    { stage: 3, round: 6, level: 7 },
    { stage: 4, round: 2, level: 8 },
    { stage: 5, round: 1, level: 9 }
  ];

  function ordinal(r) { return r.stage * 10 + r.round; }

  // Level at a given round, from a curve of "by this round I am level N".
  function levelAt(curve, round) {
    var level = curve.length ? curve[0].level : 4;
    for (var i = 0; i < curve.length; i++) {
      if (ordinal(curve[i]) <= ordinal(round)) level = curve[i].level;
    }
    return level;
  }

  // A Coven breakpoint needs that many bodies on the board, so your level is a
  // hard cap on the tier you can run. Modelling tier as a free input produces
  // fantasy numbers -- 7 Coven at level 4 does not exist.
  function maxTier(level) {
    var best = 0;
    DATA.BREAKPOINTS.forEach(function (bp) { if (bp <= level) best = bp; });
    return best;
  }

  // Damage taken for losing a PvP round: base(stage) + surviving enemy units.
  function lossDamage(stage, survivors) {
    var base = DATA.STAGE_BASE[stage];
    if (base === undefined) base = DATA.STAGE_BASE[7];
    return base + survivors;
  }


  // Walk PvP rounds forward from a starting position, banking essence and
  // spending HP, and record where each cashout threshold is crossed.
  //
  // Kill essence is deliberately NOT predicted. Whether you get kills depends
  // on whether the opponent stacked every item on one uncrackable tank, which
  // is not derivable from anything the player can type in. The caller runs
  // this across a range of killsPerRound and shows the band.
  function project(opts) {
    var curve = opts.curve || STANDARD_CURVE;
    // A curve keyed by level instead of an ordered array reads as length 0,
    // which silently pins the whole game at level 4. Fail loudly instead.
    if (!Array.isArray(curve) || !curve.length) {
      throw new TypeError("curve must be a non-empty array of {stage, round, level}");
    }
    var essence = opts.essence || 0;
    var hp = opts.hp;
    var kills = opts.killsPerRound || 0;
    var survivors = opts.survivors;
    var tierOverride = opts.tier || null;
    var start = opts.from ? ordinal(opts.from) : ordinal(ROUNDS[0]);

    var hits = {};
    var timeline = [];
    var died = false;

    for (var i = 0; i < ROUNDS.length; i++) {
      var round = ROUNDS[i];
      if (ordinal(round) < start) continue;
      // Death and running out of rounds are different failures and the player
      // needs to tell them apart: one says 'you die getting there', the other
      // says 'the game ends first'.
      if (hp <= 0) { died = true; break; }

      var level = levelAt(curve, round);
      // You cannot field more Coven bodies than you have board slots.
      var tier = Math.min(tierOverride || maxTier(level), maxTier(level));
      var rate = DATA.RATES[tier];

      // Below 3 Coven the trait is inactive: no essence, but you still bleed.
      var gained = rate ? rate.loss + rate.kill * kills : 0;
      // Survivors default to a full enemy board, the pessimistic case a player
      // deliberately losing should plan around.
      var dmg = lossDamage(round.stage,
        survivors === undefined ? level : survivors);

      essence += gained;
      hp -= dmg;

      timeline.push({
        stage: round.stage, round: round.round, level: level, tier: tier,
        gained: gained, essence: essence, damage: dmg, hp: hp
      });

      for (var t = 0; t < DATA.THRESHOLDS.length; t++) {
        if (hits[t] === undefined && essence >= DATA.THRESHOLDS[t]) {
          hits[t] = {
            level: t + 1, need: DATA.THRESHOLDS[t],
            at: round.stage + "-" + round.round,
            hpLeft: hp, essence: essence, alive: hp > 0
          };
        }
      }
    }
    return { timeline: timeline, hits: hits, endEssence: essence, endHp: hp,
             died: died };
  }

  // Run project() across a plausible range of kill rates and report the band.
  // The spread IS the answer: at shallow cashouts kills are irrelevant, and by
  // the time they matter the verdict is already "you die".
  function band(opts, killRates) {
    var rates = killRates || [0, 2, 4];
    var runs = rates.map(function (k) {
      var o = {}; for (var key in opts) o[key] = opts[key];
      o.killsPerRound = k;
      return project(o);
    });
    var out = [];
    for (var t = 0; t < DATA.THRESHOLDS.length; t++) {
      var got = runs.map(function (r) { return r.hits[t]; });
      if (got.some(function (h) { return !h; })) {
        // Unreached is not one outcome. If any run died on the way, the
        // honest report is "this kills you", not "the game ended first".
        out.push({ level: t + 1, need: DATA.THRESHOLDS[t], unreached: true,
                   fatal: runs.some(function (r) { return r.died; }) });
        continue;
      }
      var hps = got.map(function (h) { return h.hpLeft; });
      out.push({
        level: t + 1,
        need: DATA.THRESHOLDS[t],
        earliest: got[got.length - 1].at,
        latest: got[0].at,
        hpWorst: Math.min.apply(null, hps),
        hpBest: Math.max.apply(null, hps),
        alive: Math.min.apply(null, hps) > 0,
        // Surviving on 1 HP is not a plan. Anything under a single late
        // loss of headroom is reported as risky, not safe.
        risky: Math.min.apply(null, hps) > 0 && Math.min.apply(null, hps) <= 16
      });
    }
    return out;
  }
  return {
    ROUNDS: ROUNDS,
    STANDARD_CURVE: STANDARD_CURVE,
    ordinal: ordinal,
    levelAt: levelAt,
    maxTier: maxTier,
    lossDamage: lossDamage,
    project: project,
    band: band
  };
}));
