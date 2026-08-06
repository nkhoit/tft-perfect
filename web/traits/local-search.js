(function (root, factory) {
  const api = factory(
    root.SearchUtils || require('./search-utils.js'),
    root.BoardScore || require('./board-score.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LocalSearch = api;
}(typeof self !== 'undefined' ? self : globalThis, function (SU, BoardScore) {
  'use strict';

  function prng(seed) {
    let state = (Number(seed) >>> 0) || 0x9e3779b9;
    return function random() {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffled(values, random) {
    const copy = values.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function search(db, options = {}) {
    const started = performance.now();
    const T = BoardScore.tables(db);
    const size = options.size;
    const maxWaste = Number.isFinite(options.maxWaste) ? options.maxWaste : Infinity;
    const required = [...new Set(options.reqIdx || [])];
    const requiredSet = new Set(required);
    const allowed = [...new Set(options.poolIdx || [])].filter(index => !requiredSet.has(index));
    const reqTraits = options.reqTraits || [];
    const compare = SU.comparator(options.sortMode, options.sortMode2);
    const random = prng((options.seed || 1) + 0x9e3779b9 * (options.shard || 0));
    const deadline = started + (options.timeBudgetMs > 0 ? options.timeBudgetMs : 4000);
    const maxIterations = Number.isInteger(options.maxIterations) && options.maxIterations >= 0
      ? options.maxIterations : Infinity;
    const beamWidth = Math.max(4, Math.min(32, options.beamWidth || 12));
    const mutationsPerBoard = Math.max(1, options.mutationsPerBoard || 3);
    const archiveLimit = Math.max(options.limit || 100, options.archiveLimit || 300);
    const maxBonus = T.teamSize.reduce((sum, tiers) =>
      sum + tiers.reduce((best, tier) => Math.max(best, tier.slots), 0), 0);
    const maxSlots = size + maxBonus;
    let evaluations = 0;
    let iterations = 0;
    let attempts = 0;
    let nextProgress = started + (options.progressEveryMs || 250);

    const validChampion = index => Number.isInteger(index)
      && index >= 0 && index < db.champions.length;
    if (!Number.isInteger(size) || size < 2 || size > 12) {
      return { error: 'Board size must be from 2 to 12.' };
    }
    if (required.length !== (options.reqIdx || []).length || required.some(index => !validChampion(index))) {
      return { error: 'Required units contain a duplicate or unknown champion.' };
    }
    if (allowed.some(index => !validChampion(index))) {
      return { error: 'Allowed pool contains an unknown champion.' };
    }
    const requiredGroups = new Set();
    let requiredSlots = 0;
    for (const index of required) {
      const group = T.group[index];
      if (group && requiredGroups.has(group)) {
        return { error: `Required ${group} forms are mutually exclusive.` };
      }
      if (group) requiredGroups.add(group);
      requiredSlots += T.slots[index];
    }
    if (requiredSlots > maxSlots || required.length > maxSlots) {
      return { error: 'More required unit slots than this board size can support.' };
    }

    const archive = new Map();
    const rosterKey = roster => roster.slice().sort((a, b) => a - b).join(',');
    const traitCounts = row => {
      const counts = new Map();
      for (const part of row.signature.split('|')) {
        if (!part) continue;
        const [trait, count] = part.split(':').map(Number);
        counts.set(trait, count);
      }
      return counts;
    };
    const queryFeasible = row => {
      if (row.waste > maxWaste) return false;
      const counts = traitCounts(row);
      return reqTraits.every(({ t, n }) => (counts.get(t) || 0) >= n);
    };
    const penalty = row => {
      const counts = traitCounts(row);
      let value = Math.max(0, row.waste - maxWaste) * 10;
      for (const { t, n } of reqTraits) value += Math.max(0, n - (counts.get(t) || 0)) * 20;
      return value;
    };
    const quality = row => {
      const order = SU.sortOrder(options.sortMode, options.sortMode2);
      let value = 0;
      let weight = 10;
      for (const key of order) {
        if (key === 'live') value += row.live * weight;
        else if (key === 'tier') value += row.tierSum / 2 * weight;
        else if (key === 'waste') value -= row.waste * weight;
        else if (key === 'rich') value += row.gold / 9 * weight;
        else value -= row.gold / 9 * weight;
        weight /= 5;
      }
      return value - penalty(row) * 100;
    };
    const score = roster => {
      evaluations++;
      return BoardScore.scoreRoster(db, T, roster, options.emblems || [], options.muted || []);
    };
    const structurallyComplete = (roster, row) => {
      const { counts, emblemCounts } = BoardScore.rosterCounts(T, roster, options.emblems || []);
      return row.slots === size + BoardScore.unlockedBonus(
        T, roster, counts, emblemCounts, size);
    };
    const retain = row => {
      if (!queryFeasible(row)) return;
      const signature = SU.traitSignature(row);
      const existing = archive.get(signature);
      if (!existing || compare(row, existing.row) < 0) {
        const variants = existing ? [existing.row, ...existing.variants] : [];
        archive.set(signature, { row, variants });
      } else if (!existing.variants.some(item => rosterKey(item.units) === rosterKey(row.units))) {
        existing.variants.push(row);
      }
      const entry = archive.get(signature);
      entry.variants.sort(compare);
      entry.variants.length = Math.min(entry.variants.length, 24);
      if (archive.size > archiveLimit) {
        const worst = [...archive.entries()].sort((a, b) => compare(a[1].row, b[1].row)).pop();
        archive.delete(worst[0]);
      }
    };
    const resultRows = () => [...archive.values()]
      .map(entry => ({ ...entry.row, variants: entry.variants }))
      .sort(compare)
      .slice(0, options.returnN || options.limit || 100);

    function construct(base, maxNodes = 180) {
      const roster = base.slice();
      const selected = new Set(roster);
      const groups = new Set(roster.map(index => T.group[index]).filter(Boolean));
      let used = roster.reduce((sum, index) => sum + T.slots[index], 0);
      let nodes = 0;

      function fill(candidates) {
        if (++nodes > maxNodes || performance.now() >= deadline) return null;
        let complete = null;
        if (roster.length && roster.length <= maxSlots) {
          const row = score(roster);
          if (structurallyComplete(roster, row)) {
            complete = { roster: roster.slice(), row };
            // Usually stop at the first complete board. Sometimes keep building
            // through the temporary over-capacity valley so a capacity trait can
            // unlock a larger complete board.
            if (!T.teamSize.some(tiers => tiers.length) || random() < 0.65) return complete;
          }
        }
        if (roster.length >= maxSlots || used >= maxSlots) return null;

        for (const index of candidates) {
          if (selected.has(index) || used + T.slots[index] > maxSlots) continue;
          const group = T.group[index];
          if (group && groups.has(group)) continue;
          selected.add(index);
          if (group) groups.add(group);
          roster.push(index);
          used += T.slots[index];
          const next = candidates.filter(candidate => candidate !== index);
          const result = fill(next);
          if (result) return result;
          used -= T.slots[index];
          roster.pop();
          if (group) groups.delete(group);
          selected.delete(index);
        }
        return complete;
      }

      const candidates = shuffled(allowed, random);
      candidates.sort((a, b) => {
        const helps = index => T.points[index].size
          + [...T.points[index]].reduce((sum, [trait, points]) =>
            sum + reqTraits.some(requirement => requirement.t === trait) * points * 4, 0);
        return helps(b) - helps(a);
      });
      return fill(candidates.slice(0, Math.min(candidates.length, 40)));
    }

    function mutate(board, temperature) {
      const optional = board.roster.filter(index => !requiredSet.has(index));
      const ruin = random() < 0.12 ? Math.min(optional.length, 3)
        : random() < 0.38 ? Math.min(optional.length, 2) : Math.min(optional.length, 1);
      const removed = new Set(shuffled(optional, random).slice(0, ruin));
      const base = board.roster.filter(index => !removed.has(index));
      const candidate = construct(base, 120);
      if (!candidate || rosterKey(candidate.roster) === rosterKey(board.roster)) return null;
      const delta = quality(candidate.row) - quality(board.row);
      if (delta >= 0 || random() < Math.exp(delta / Math.max(0.01, temperature))) return candidate;
      return random() < 0.05 ? candidate : null;
    }

    const population = [];
    const startCount = Math.max(beamWidth * 2, 24);
    for (let i = 0; i < startCount && performance.now() < deadline; i++) {
      attempts++;
      const candidate = construct(required, 240);
      if (!candidate) continue;
      retain(candidate.row);
      population.push(candidate);
    }

    let beam = population.sort((a, b) =>
      penalty(a.row) - penalty(b.row) || compare(a.row, b.row)).slice(0, beamWidth);
    while (beam.length && iterations < maxIterations && performance.now() < deadline) {
      iterations++;
      const scheduleProgress = Number.isFinite(maxIterations)
        ? iterations / Math.max(40, maxIterations)
        : (performance.now() - started) / Math.max(1, deadline - started);
      const temperature = Math.max(0.05, 4 * (1 - Math.min(1, scheduleProgress)));
      const candidates = beam.slice();
      for (const board of beam) {
        for (let move = 0; move < mutationsPerBoard; move++) {
          attempts++;
          const candidate = mutate(board, temperature);
          if (!candidate) continue;
          retain(candidate.row);
          candidates.push(candidate);
        }
      }
      if (iterations % 8 === 0) {
        attempts++;
        const restart = construct(required, 300);
        if (restart) {
          retain(restart.row);
          candidates.push(restart);
        }
      }
      const unique = new Map();
      for (const candidate of candidates) unique.set(rosterKey(candidate.roster), candidate);
      const ranked = [...unique.values()].sort((a, b) =>
        penalty(a.row) - penalty(b.row) || compare(a.row, b.row));
      const diverse = [];
      const signatures = new Set();
      for (const candidate of ranked) {
        const signature = SU.traitSignature(candidate.row);
        if (signatures.has(signature) && diverse.length < Math.floor(beamWidth * 0.75)) continue;
        signatures.add(signature);
        diverse.push(candidate);
        if (diverse.length >= beamWidth) break;
      }
      beam = diverse;
      if (typeof options.onProgress === 'function' && performance.now() >= nextProgress) {
        nextProgress = performance.now() + (options.progressEveryMs || 250);
        options.onProgress({ rows: resultRows(), total: archive.size, nodes: evaluations });
      }
    }

    return {
      rows: resultRows(),
      total: archive.size,
      truncated: true,
      capped: archive.size >= archiveLimit,
      nodes: evaluations,
      attempts,
      iterations,
      seed: Number(options.seed || 1) >>> 0,
      sampled: true,
      experimental: true,
      stopReason: iterations >= maxIterations ? 'iterations' : 'time',
      ms: Math.round(performance.now() - started),
    };
  }

  return { prng, search };
}));
