(function (root, factory) {
  const api = factory(root.SearchUtils || require('./search-utils.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardScore = api;
}(typeof self !== 'undefined' ? self : globalThis, function (SU) {
  'use strict';

  function tables(db) {
    const traitKeys = Object.keys(db.traits);
    const traitIndex = new Map(traitKeys.map((key, index) => [key, index]));
    const bps = traitKeys.map(key => SU.breakpoints(db.traits[key]));
    const floors = traitKeys.map(key => {
      const floor = SU.scoreFloor(db.traits[key]);
      return Number.isFinite(floor) ? floor : null;
    });
    const points = db.champions.map(champion => {
      const row = new Map();
      const weights = champion.traitPoints || {};
      for (const key of champion.traits) {
        if (!traitIndex.has(key)) continue;
        const trait = traitIndex.get(key);
        row.set(trait, (row.get(trait) || 0) + (weights[key] || 1));
      }
      return row;
    });
    const teamSize = traitKeys.map(key =>
      (db.traits[key].teamSize || []).slice().sort((a, b) => a.min - b.min));
    return {
      traitKeys,
      traitIndex,
      bps,
      floors,
      points,
      teamSize,
      slots: db.champions.map(champion => champion.slots || 1),
      cost: db.champions.map(champion => champion.cost),
      group: db.champions.map(champion => champion.group || null),
      championIndex: new Map(db.champions.map((champion, index) => [champion.key, index])),
    };
  }

  function rosterCounts(T, roster, emblems) {
    const counts = new Int32Array(T.traitKeys.length);
    const emblemCounts = new Int32Array(T.traitKeys.length);
    for (const emblem of emblems || []) {
      const trait = typeof emblem === 'string' ? T.traitIndex.get(emblem) : emblem;
      if (trait >= 0 && trait < counts.length) {
        counts[trait]++;
        emblemCounts[trait]++;
      }
    }
    for (const champion of roster) {
      for (const [trait, points] of T.points[champion]) counts[trait] += points;
    }
    return { counts, emblemCounts };
  }

  function scoreRoster(db, T, roster, emblems, muted) {
    const { counts } = rosterCounts(T, roster, emblems);
    const mutedSet = new Set(muted || []);
    let gold = 0, usedSlots = 0;
    for (const champion of roster) {
      gold += T.cost[champion] * 3;
      usedSlots += T.slots[champion];
    }

    let live = 0, uniqN = 0, waste = 0, tierSum = 0;
    const active = [], dead = [], over = [];
    let signature = '';
    for (let trait = 0; trait < counts.length; trait++) {
      const count = counts[trait];
      if (!count) continue;
      signature += (signature ? '|' : '') + `${trait}:${count}`;
      const bp = T.bps[trait];
      let reached = 0, tier = -1;
      for (let j = 0; j < bp.length; j++) {
        if (count >= bp[j]) { reached = bp[j]; tier = j; }
      }
      const wasted = count - reached;
      if (wasted) {
        if (!mutedSet.has(trait)) waste += wasted;
        if (tier >= 0) over.push([trait, wasted]);
        else dead.push([trait, count]);
      }
      if (tier >= 0) {
        active.push([trait, count, tier]);
        const floor = T.floors[trait];
        if (floor === null) uniqN++;
        else if (!mutedSet.has(trait) && count >= floor) {
          live++;
          tierSum += tier + 1;
        }
      }
    }
    const dim = trait => (T.floors[trait] === null || mutedSet.has(trait)
      || counts[trait] < T.floors[trait]) ? 1 : 0;
    active.sort((a, b) => (dim(a[0]) - dim(b[0])) || b[1] - a[1]);
    return {
      units: roster.slice(), active, dead, over,
      live, uniqN, waste, tierSum, gold, slots: usedSlots, signature,
    };
  }

  function minimumSlots(T, roster, emblemCounts, trait, target) {
    const needed = Math.max(0, target - emblemCounts[trait]);
    if (!needed) return 0;
    const best = new Int16Array(needed + 1);
    best.fill(32767);
    best[0] = 0;
    for (const champion of roster) {
      const points = T.points[champion].get(trait);
      if (!points) continue;
      for (let have = needed - 1; have >= 0; have--) {
        if (best[have] === 32767) continue;
        const next = Math.min(needed, have + points);
        best[next] = Math.min(best[next], best[have] + T.slots[champion]);
      }
    }
    return best[needed];
  }

  function unlockedBonus(T, roster, counts, emblemCounts, size) {
    const pending = [];
    for (let trait = 0; trait < T.teamSize.length; trait++) {
      let active = null;
      for (const tier of T.teamSize[trait]) if (counts[trait] >= tier.min) active = tier;
      if (active) pending.push({ trait, ...active });
    }
    let capacity = size;
    let bonus = 0;
    while (pending.length) {
      const index = pending.findIndex(rule =>
        minimumSlots(T, roster, emblemCounts, rule.trait, rule.min) <= capacity);
      if (index < 0) break;
      const [rule] = pending.splice(index, 1);
      capacity += rule.slots;
      bonus += rule.slots;
    }
    return bonus;
  }

  function validateRoster(db, T, keys, options = {}) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 12) {
      return { error: 'Roster size is invalid.' };
    }
    const indexes = [];
    const seen = new Set();
    const groups = new Set();
    for (const key of keys) {
      if (typeof key !== 'string' || !T.championIndex.has(key)) {
        return { error: 'Roster contains an unknown champion.' };
      }
      const index = T.championIndex.get(key);
      if (seen.has(index)) return { error: 'Roster contains a duplicate champion.' };
      seen.add(index);
      const group = T.group[index];
      if (group && groups.has(group)) {
        return { error: `Roster contains multiple ${group} forms.` };
      }
      if (group) groups.add(group);
      indexes.push(index);
    }

    const size = options.size;
    if (!Number.isInteger(size) || size < 2 || size > 10) {
      return { error: 'Roster level is invalid.' };
    }
    const emblems = options.emblems || [];
    const muted = options.muted || [];
    const { counts, emblemCounts } = rosterCounts(T, indexes, emblems);
    const bonus = unlockedBonus(T, indexes, counts, emblemCounts, size);
    const slots = indexes.reduce((total, index) => total + T.slots[index], 0);
    if (slots !== size + bonus) {
      return { error: 'Roster does not fill the available team slots.' };
    }
    return {
      indexes,
      row: scoreRoster(db, T, indexes, emblems, muted),
    };
  }

  return { scoreRoster, tables, validateRoster };
}));
