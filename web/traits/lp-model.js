// lp-model.js — builds a CPLEX-LP formulation of the board search for HiGHS.
//
// WHY THIS EXISTS
// The DFS in worker.js is a branch-and-bound over C(73,8) ~ 1.3e10 boards. Its
// bounds are weak enough that it exhausts a 40M-node budget on every non-trivial
// query and returns suboptimal boards without saying so. A MILP solver proves the
// optimum for the same query in 70-400ms, so we use it to find the ceiling and
// let the DFS enumerate the long tail beneath it.
//
// MODEL
//   x[c] in {0,1}            champion c is fielded
//   n[t] in Z>=0             trait t's point total  = sum_c pts[c][t] * x[c]
//   y[t,j] in {0,1}          trait t reached breakpoint j
//   w[t] in Z>=0             wasted points in trait t
//
//   sum_c slots[c] * x[c] == size + bonus      exact fill; bonus enumerated
//   bp[j] * y[t,j] <= n[t]                     y can only be 1 once n reaches bp
//   y[t,j] <= y[t,j-1]                         tiers are monotone
//   w[t] == n[t] - sum_j (bp[j]-bp[j-1]) y[t,j]
//   sum_t w[t] <= maxWaste
//
// The y<=n direction is all we need: the objective pushes y up, so the solver
// sets each y as high as n permits. Waste then falls out exactly, because
// sum_j (bp[j]-bp[j-1])*y[t,j] telescopes to the highest breakpoint reached.
//
// SEMANTICS come from search-utils.js (breakpoints / isUnique / scoreFloor) so
// this model and the DFS score identically. tests/lp-model.test.js asserts that.
(function (root, factory) {
  const api = factory(
    root.SearchUtils || require('./search-utils.js'),
    root.BoardScore || require('./board-score.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LpModel = api;
}(typeof self !== 'undefined' ? self : globalThis, function (SU, BoardScore) {
  'use strict';

  const tables = BoardScore.tables;

  // Team-size bonuses are enumerated, not modelled: there is exactly one
  // capacity trait in practice and folding it in as a variable would make the
  // slot constraint non-linear. Caller solves once per candidate bonus.
  function bonusOptions(T) {
    const options = new Set([0]);
    T.teamSize.forEach(tiers => tiers.forEach(tier => options.add(tier.slots)));
    return [...options].sort((a, b) => b - a);
  }

  // Build the LP text for one (size, bonus) pair.
  //
  // opts: { size, maxWaste, bonus, reqIdx, keepIdx, minKeep, maxKeep, poolIdx,
  //         emblems, muted, reqTraits, sortMode, cuts }
  function buildLP(db, opts) {
    const T = opts.tables || tables(db);
    const nT = T.traitKeys.length;
    const size = opts.size;
    const bonus = opts.bonus || 0;
    const muted = new Set(opts.muted || []);
    const required = new Set(opts.reqIdx || []);
    const hasKeep = Object.prototype.hasOwnProperty.call(opts, 'keepIdx');
    const keepable = new Set(opts.keepIdx || []);
    if (hasKeep && (!Number.isInteger(opts.minKeep) || !Number.isInteger(opts.maxKeep)
        || opts.minKeep < 0 || opts.maxKeep < opts.minKeep
        || opts.maxKeep > keepable.size)) {
      throw new RangeError('Invalid source-board keep bounds.');
    }
    const requiredTraits = opts.reqTraits || [];
    for (const requirement of requiredTraits) {
      if (!requirement || !Number.isInteger(requirement.t)
          || requirement.t < 0 || requirement.t >= nT
          || !Number.isInteger(requirement.n) || requirement.n <= 0) {
        throw new RangeError('Invalid required trait.');
      }
    }
    // Required and source-board units remain variables even when the current
    // cost filter excludes them.
    const pool = [...new Set([...(opts.poolIdx || []), ...required, ...keepable])]
      .sort((a, b) => a - b);
    if (!pool.length) return null;

    const emblemCounts = new Array(nT).fill(0);
    for (const emblem of opts.emblems || []) {
      const t = typeof emblem === 'string' ? T.traitIndex.get(emblem) : emblem;
      if (t >= 0 && t < nT) emblemCounts[t]++;
    }

    // Which traits can appear at all given this pool? Modelling the rest just
    // feeds the solver dead columns.
    const contributors = new Map();          // trait -> [[champIdx, points]]
    for (const c of pool) {
      for (const [t, p] of T.points[c]) {
        if (!contributors.has(t)) contributors.set(t, []);
        contributors.get(t).push([c, p]);
      }
    }
    const live = [];
    for (let t = 0; t < nT; t++) {
      if (!T.bps[t].length) continue;
      if (!contributors.has(t) && !emblemCounts[t]) continue;
      live.push(t);
    }
    if (requiredTraits.some(requirement => !live.includes(requirement.t))) return null;

    const capacityRules = [];
    if (bonus) {
      for (let t = 0; t < T.teamSize.length; t++) {
        for (const tier of T.teamSize[t]) {
          if (tier.slots !== bonus) continue;
          const contributorsForTrait = contributors.get(t) || [];
          const reachable = emblemCounts[t]
            + contributorsForTrait.reduce((total, [, points]) => total + points, 0);
          if (reachable < tier.min) continue;
          capacityRules.push({ trait: t, tier, contributors: contributorsForTrait });
        }
      }
      if (!capacityRules.length) return null;
      if (capacityRules.length > 1) {
        throw new Error('Multiple capacity profiles are not supported.');
      }
    }

    const L = [];
    const scoringTerms = [], tierTerms = [], wasteTerms = [];
    for (const t of live) {
      const bp = T.bps[t];
      if (T.floors[t] === null || muted.has(t)) continue;
      const first = bp.findIndex(b => b >= T.floors[t]);
      if (first < 0) continue;
      scoringTerms.push(`y${t}_${first}`);
      for (let j = first; j < bp.length; j++) tierTerms.push(`y${t}_${j}`);
      for (let i = 0; i < first; i++) tierTerms.push(`y${t}_${first}`);
    }

    // Objective.
    //
    // The result list is sorted lexicographically by
    // primary -> secondary -> live -> tier -> waste -> cost (see comparator() in
    // search-utils.js). The objective must encode that WHOLE chain, not just the
    // primary key: if it stops at the primary, the solver is free to break ties
    // however it likes, and the board it proves optimal is then re-sorted below
    // some other equally-optimal board once the DFS rows merge in. The user sees
    // the top row change out from under them.
    //
    // Each key gets a weight strictly larger than the maximum possible total of
    // every lower-priority key combined, which makes the single linear objective
    // behave exactly like the lexicographic comparator. Weights stay well inside
    // float64's exact-integer range (~9e15).
    const sortMode = opts.sortMode || 'live';

    // Per-key: the terms that compute it, whether bigger is better, and a safe
    // upper bound on its value (used to size the weight ladder).
    const maxGold = pool.reduce((sum, c) => sum + T.cost[c] * 3, 0);
    const KEYS = {
      live: { terms: scoringTerms.map(v => [1, v]), better: 'max', bound: scoringTerms.length },
      tier: { terms: tierTerms.map(v => [1, v]), better: 'max', bound: tierTerms.length },
      waste: { terms: [[1, 'Wtot']], better: 'min', bound: Math.max(0, opts.maxWaste) },
      cost: { terms: pool.map(c => [T.cost[c] * 3, `x${c}`]), better: 'min', bound: maxGold },
      rich: { terms: pool.map(c => [T.cost[c] * 3, `x${c}`]), better: 'max', bound: maxGold },
    };

    // Mirror sortOrder(): primary, secondary, then the standard fallback chain,
    // de-duplicated, preserving first occurrence.
    const order = [sortMode, opts.sortMode2, 'live', 'tier', 'waste', 'cost']
      .filter((key, i, keys) => KEYS[key] && keys.indexOf(key) === i);

    // Build weights bottom-up so weight[i] > sum of everything beneath it.
    const weights = new Array(order.length);
    let scale = 1;
    for (let i = order.length - 1; i >= 0; i--) {
      weights[i] = scale;
      scale *= (KEYS[order[i]].bound + 1);
    }

    // Everything is folded into one Maximize; minimize-keys enter negated.
    const coefficients = new Map();
    order.forEach((key, i) => {
      const { terms, better } = KEYS[key];
      const sign = better === 'max' ? 1 : -1;
      for (const [c, name] of terms) {
        coefficients.set(name, (coefficients.get(name) || 0) + sign * weights[i] * c);
      }
    });

    const plus = terms => terms.map(s => (s.startsWith('-') ? ` ${s}` : ` +${s}`)).join('');
    const objTerms = [];
    for (const [name, c] of coefficients) {
      if (c === 0) continue;
      objTerms.push(`${c < 0 ? '-' : ''}${Math.abs(c)} ${name}`);
    }
    L.push('Maximize');
    L.push(' obj:' + (objTerms.length ? plus(objTerms) : ' 0 Wtot'));

    L.push('Subject To');
    // Exact slot fill. `bonus` is validated by the caller's activation clause.
    L.push(' slots:' + plus(pool.map(c => `${T.slots[c]} x${c}`)) + ` = ${size + bonus}`);

    for (const c of required) L.push(` req${c}: x${c} = 1`);
    if (hasKeep) {
      if (opts.minKeep === keepable.size && opts.maxKeep === keepable.size) {
        for (const champion of keepable) {
          if (!required.has(champion)) L.push(` keep${champion}: x${champion} = 1`);
        }
      } else if (keepable.size) {
        const terms = plus([...keepable].map(champion => `x${champion}`));
        L.push(' keepMin:' + terms + ` >= ${opts.minKeep}`);
        L.push(' keepMax:' + terms + ` <= ${opts.maxKeep}`);
      }
    }

    // Champion forms (Lux) are mutually exclusive.
    const groups = new Map();
    for (const c of pool) {
      if (!T.group[c]) continue;
      if (!groups.has(T.group[c])) groups.set(T.group[c], []);
      groups.get(T.group[c]).push(c);
    }
    let g = 0;
    for (const members of groups.values()) {
      if (members.length > 1) L.push(` grp${g++}:` + plus(members.map(c => `x${c}`)) + ' <= 1');
    }

    for (const t of live) {
      const bp = T.bps[t];
      const terms = (contributors.get(t) || []).map(([c, p]) => `${p} x${c}`);
      // n[t] = emblems + sum(points * x)
      L.push(` nd${t}:` + plus(terms) + ` -1 n${t} = ${-emblemCounts[t]}`);
      for (let j = 0; j < bp.length; j++) {
        L.push(` bp${t}_${j}: ${bp[j]} y${t}_${j} -1 n${t} <= 0`);
        if (j) L.push(` mo${t}_${j}: +1 y${t}_${j} -1 y${t}_${j - 1} <= 0`);
      }
      const reached = bp.map((b, j) => `-${b - (j ? bp[j - 1] : 0)} y${t}_${j}`);
      L.push(` wd${t}: +1 n${t}` + plus(reached) + ` -1 w${t} = 0`);
      if (!muted.has(t)) wasteTerms.push(`w${t}`);
    }

    L.push(' wtot:' + plus(wasteTerms) + ' -1 Wtot = 0');
    L.push(` wcap: +1 Wtot <= ${opts.maxWaste}`);

    // Required trait breakpoints ("Invoker 4").
    requiredTraits.forEach((requirement, i) => {
      L.push(` rt${i}: +1 n${requirement.t} >= ${requirement.n}`);
    });

    // Capacity trait must actually be active to grant its slots, and must NOT
    // be active when we're solving the zero-bonus case (otherwise the solver
    // returns a board that would really have had more slots available).
    if (bonus) {
      const [{ trait, tier, contributors: capacityContributors }] = capacityRules;
      L.push(` cap${trait}: +1 n${trait} >= ${tier.min}`);
      const needed = Math.max(0, tier.min - emblemCounts[trait]);
      if (needed) {
        const zTerms = capacityContributors.map(([champion, points]) =>
          `${points} z${trait}_${champion}`);
        L.push(` prePts${trait}:` + plus(zTerms) + ` >= ${needed}`);
        L.push(` preSlots${trait}:` + plus(capacityContributors.map(([champion]) =>
          `${T.slots[champion]} z${trait}_${champion}`)) + ` <= ${size}`);
        for (const [champion] of capacityContributors) {
          L.push(` preSel${trait}_${champion}: +1 z${trait}_${champion} -1 x${champion} <= 0`);
        }
      }
    } else {
      T.teamSize.forEach((tiers, trait) => {
        if (!tiers.length || !live.includes(trait)) return;
        for (const tier of tiers) {
          L.push(` cap${trait}: +1 n${trait} <= ${tier.min - 1}`);
        }
      });
    }

    // No-good cuts: ban previously returned rosters. sum(x in S) <= |S|-1.
    (opts.cuts || []).forEach((roster, i) => {
      if (!roster.length) return;
      L.push(` cut${i}:` + plus(roster.map(c => `x${c}`)) + ` <= ${roster.length - 1}`);
    });

    L.push('Bounds');
    for (const t of live) { L.push(` n${t} >= 0`); L.push(` w${t} >= 0`); }
    L.push(' Wtot >= 0');

    L.push('Binary');
    const bins = pool.map(c => `x${c}`);
    for (const t of live) T.bps[t].forEach((_, j) => bins.push(`y${t}_${j}`));
    for (const { trait, contributors: capacityContributors } of capacityRules) {
      const needed = Math.max(0, capacityRules[0].tier.min - emblemCounts[trait]);
      if (needed) {
        for (const [champion] of capacityContributors) bins.push(`z${trait}_${champion}`);
      }
    }
    L.push(' ' + bins.join(' '));

    L.push('General');
    const gens = [];
    for (const t of live) { gens.push(`n${t}`); gens.push(`w${t}`); }
    gens.push('Wtot');
    L.push(' ' + gens.join(' '));
    L.push('End');
    return { lp: L.join('\n'), pool, live, tables: T };
  }

  // Pull the chosen roster out of a HiGHS solution.
  function rosterOf(solution) {
    const picked = [];
    const columns = solution && solution.Columns;
    if (!columns) return picked;
    for (const name in columns) {
      if (!/^x\d+$/.test(name)) continue;
      const value = columns[name].Primal;
      if (value > 0.5) picked.push(+name.slice(1));
    }
    return picked.sort((a, b) => a - b);
  }

  return { tables, bonusOptions, buildLP, rosterOf };
}));
