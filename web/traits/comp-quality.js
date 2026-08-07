'use strict';
// Comp quality: judge a board the way a player does -- item economy, role
// balance, body quality -- not raw trait count.
//
// Items are the scarce resource. The PLAYER declares which units hold them,
// because intent is not in the data: Zyra and Alune are both top-tier AP
// casters, but one is a trait body and the other is the whole game plan.
// Mixing locked AD and AP among declared carries forces both Shred and
// Sunder. Adaptor units flex either way. That is why a board can be 5 AP/3 AD
// overall and still be perfectly item-coherent.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompQuality = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const GLOBAL = typeof self !== 'undefined' ? self : globalThis;

  // Roles that consume items. Casters scale off a shared AP item pool and
  // tanks take defensive items, so neither drives the Shred/Sunder choice.
  const FRONTLINE = /Tank|Fighter/i;

  // Items go to the strongest bodies you can field. A 3-cost carry on a board
  // built around 4-costs is a trait/body slot, not an item holder -- you would
  // rather hold those items on the bigger unit. So only units within one cost
  // tier of the board's top cost actually compete for items.
  const ITEM_TIER_DEPTH = 1;

  // Anything that is not a pure tank can hold items and deal damage. The role
  // label alone is not enough: Alune is an APCaster and the reason you levelled
  // to 9, while Zyra is an APCaster you field for a trait. Cost tier, not the
  // label, decides which one is your carry.
  const PURE_TANK = /Tank$/i;

  // Shred (magic resist) and Sunder (armor) are what force a split-damage board
  // to build two item packages. A unit that applies both for free removes that
  // tax, which is what makes dual-damage-type carries playable.
  function shredSunderSources(db, roster) {
    const found = [];
    for (const index of roster) {
      const champion = db.champions[index];
      const ability = champion.ability || {};
      const text = String(ability.descResolved || ability.desc || '');
      if (/shred|sunder/i.test(text)) { found.push(champion.key); continue; }
      for (const trait of champion.traits) {
        const info = (db.traits || {})[trait] || {};
        const desc = String(info.desc || info.descResolved || '');
        if (/shred|sunder/i.test(desc)) { found.push(champion.key); break; }
      }
    }
    return found;
  }

  // Adaptor units read their higher stat, so how you itemize them decides
  // whether they deal AD or AP. Their listed role is only a default -- they
  // never force a second item package, they absorb into whichever one you
  // already build. Kog'Maw is both Adaptor and Caustic, which is why he slots
  // into anything.
  const FLEX_TRAIT = 'Adaptor';

  function damageType(role, champion) {
    if (champion && champion.traits && champion.traits.includes(FLEX_TRAIT)) return 'flex';
    if (!role) return null;
    if (/^AD/i.test(role)) return 'AD';
    if (/^AP/i.test(role)) return 'AP';
    return null;
  }

  // Describe one champion in comp terms.
  function profile(champion) {
    const role = champion.role || null;
    return {
      key: champion.key,
      cost: champion.cost,
      role,
      damage: damageType(role, champion),
      itemized: !!role && !PURE_TANK.test(role),
      frontline: role ? FRONTLINE.test(role) : (champion.stats || {}).hexRange <= 2,
    };
  }

  // Item coherence: among units you would actually itemize, do the damage
  // types agree? One type means one shred/sunder package. A free shred/sunder
  // source on the board lifts the constraint entirely.
  // Coherence is an ECONOMY heuristic, not a law. Splitting AD/AP costs you a
  // second Shred/Sunder package -- painful when your carries are 3- and 4-costs
  // that need the help, and close to irrelevant when they are 5-costs whose raw
  // stats carry the fight regardless. A board stacking legendary bodies is
  // allowed to pay that price, so the penalty scales down as carry cost rises.
  function splitPenalty(carries) {
    if (!carries.length) return 0;
    const avg = carries.reduce((sum, p) => sum + p.cost, 0) / carries.length;
    if (avg >= 4.5) return 0.25;
    if (avg >= 4) return 0.6;
    return 1;
  }

  // Which units hold items? If the caller declares carries we use exactly
  // those -- intent is not derivable from the data. Zyra and Alune are both
  // top-tier AP casters; one is a carry and one is a trait body, and only the
  // player knows which. Without a declaration we fall back to a cost-tier
  // guess, which is a hint, not a verdict.
  function itemCoherence(profiles, freeShred, declared) {
    let carries, inferred = false;
    if (declared && declared.length) {
      const want = new Set(declared);
      carries = profiles.filter(p => want.has(p.key));
    } else {
      const topCost = profiles.reduce((max, p) => Math.max(max, p.cost), 0);
      carries = profiles.filter(p =>
        p.itemized && p.damage && p.cost >= topCost - ITEM_TIER_DEPTH);
      inferred = true;
    }
    // Flex (Adaptor) carries absorb into whichever package you already build,
    // so only LOCKED types can conflict.
    const locked = new Set(carries.map(p => p.damage).filter(d => d && d !== 'flex'));
    const types = new Set(carries.map(p => p.damage).filter(Boolean));
    return {
      carries,
      inferred,
      types: [...types],
      lockedTypes: [...locked],
      flexCarries: carries.filter(p => p.damage === 'flex').map(p => p.key),
      coherent: locked.size <= 1 || freeShred.length > 0,
      exempt: locked.size > 1 && freeShred.length > 0,
      carryless: carries.length === 0,
    };
  }

  // A trait only earns its slot if it lands on a unit that matters -- your
  // carries or your tanks. Fiddlesticks bringing a 2nd FloraFatalis is a good
  // trade even though his Defender/Spellweaver singletons die: the trait he
  // completes buffs the carry, and the waste sits on a body nobody itemizes.
  function traitRelevance(db, T, roster, profiles, active) {
    const keyUnits = new Set(profiles
      .filter(p => p.itemized || /Tank/i.test(p.role))
      .map(p => p.key));
    let relevant = 0, incidental = 0;
    const detail = [];
    for (const entry of active) {
      const traitIndex = entry[0];
      const key = T.traitKeys[traitIndex];
      const holders = roster
        .map(i => db.champions[i])
        .filter(c => c.traits.includes(key))
        .map(c => c.key);
      const touches = holders.filter(h => keyUnits.has(h));
      if (touches.length) { relevant++; } else { incidental++; }
      detail.push({ trait: key, holders, touches, relevant: touches.length > 0 });
    }
    return { relevant, incidental, detail };
  }

  // Score a roster of champion indices. `score` is the board's trait score
  // from BoardScore.scoreRoster -- comp quality reads it but never replaces
  // it: trait count is the constraint, playability is the ranking.
  function evaluate(db, roster, score, T, declaredCarries) {
    const profiles = roster.map(index => profile(db.champions[index]));
    const freeShred = shredSunderSources(db, roster);
    const coherence = itemCoherence(profiles, freeShred, declaredCarries);
    const frontline = profiles.filter(p => p.frontline).length;
    const backline = profiles.length - frontline;
    const avgCost = profiles.reduce((sum, p) => sum + p.cost, 0) / (profiles.length || 1);

    const relevance = (T && score && score.active)
      ? traitRelevance(db, T, roster, profiles, score.active)
      : null;

    const notes = [];
    if (coherence.carryless) notes.push('no itemized carry');
    else if (!coherence.coherent) {
      notes.push('carries split ' + coherence.lockedTypes.join('/') + ' -- needs both Shred and Sunder');
    } else if (coherence.exempt) {
      notes.push('split ' + coherence.lockedTypes.join('/') + ' carries, freed by ' + freeShred.join('/'));
    }
    if (coherence.flexCarries.length) {
      notes.push('flexible: ' + coherence.flexCarries.join('/') + ' (Adaptor) itemizes either way');
    }
    if (frontline < 3) notes.push('thin frontline (' + frontline + ')');
    if (backline === 0) notes.push('no backline damage');

    // The headline a player acts on: which package do I build?
    let itemPlan;
    if (coherence.carryless) itemPlan = 'no carry declared';
    else if (coherence.lockedTypes.length === 1) itemPlan = coherence.lockedTypes[0] + ' package';
    else if (coherence.lockedTypes.length === 0) itemPlan = 'flexible (Adaptor carries)';
    else if (freeShred.length) itemPlan = 'split, covered by ' + freeShred.join('/');
    else itemPlan = 'split -- two packages';

    return {
      profiles,
      itemPlan,
      frontline,
      backline,
      avgCost,
      carries: coherence.carries.map(p => p.key),
      carriesInferred: coherence.inferred,
      damageTypes: coherence.types,
      itemCoherent: coherence.coherent && !coherence.carryless,
      freeShred,
      relevance,
      waste: score ? score.waste : null,
      notes,
    };
  }

  // Roster from a Team Planner code. TeamCode owns the wire format; this just
  // maps planner ids onto champion indexes.
  function decodeTeamCode(db, code, TeamCode) {
    const tc = TeamCode ||
      (typeof module === 'object' && module.exports ? require('./team-code.js') : GLOBAL.TeamCode);
    const byId = new Map();
    db.champions.forEach((champion, index) => {
      if (Number.isInteger(champion.teamPlannerCode)) byId.set(champion.teamPlannerCode, index);
    });
    const roster = [], unknown = [];
    for (const id of tc.decode(code)) {
      const index = byId.get(id);
      if (index === undefined) unknown.push(id);
      else roster.push(index);
    }
    return { ok: true, roster, unknown };
  }

  return { profile, evaluate, decodeTeamCode, damageType };
}));
