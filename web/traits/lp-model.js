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
  const api = factory(root.SearchUtils || require('./search-utils.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LpModel = api;
}(typeof self !== 'undefined' ? self : globalThis, function (SU) {
  'use strict';

  // Derive the per-trait / per-champion tables the model needs.
  function tables(db) {
    const traitKeys = Object.keys(db.traits);
    const traitIndex = new Map(traitKeys.map((k, i) => [k, i]));
    const bps = traitKeys.map(k => SU.breakpoints(db.traits[k]));
    const floors = traitKeys.map(k => {
      const floor = SU.scoreFloor(db.traits[k]);
      return Number.isFinite(floor) ? floor : null;
    });
    const points = db.champions.map(champion => {
      const row = new Map();
      const weights = champion.traitPoints || {};
      for (const key of champion.traits) {
        if (!traitIndex.has(key)) continue;
        const t = traitIndex.get(key);
        row.set(t, (row.get(t) || 0) + (weights[key] || 1));
      }
      return row;
    });
    const teamSize = traitKeys.map(k =>
      (db.traits[k].teamSize || []).slice().sort((a, b) => a.min - b.min));
    return {
      traitKeys, traitIndex, bps, floors, points, teamSize,
      slots: db.champions.map(c => c.slots || 1),
      cost: db.champions.map(c => c.cost),
      group: db.champions.map(c => c.group || null),
    };
  }

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
  // opts: { size, maxWaste, bonus, reqIdx, poolIdx, emblems, muted, reqTraits,
  //         sortMode, cuts }
  function buildLP(db, opts) {
    const T = opts.tables || tables(db);
    const nT = T.traitKeys.length;
    const size = opts.size;
    const bonus = opts.bonus || 0;
    const muted = new Set(opts.muted || []);
    const required = new Set(opts.reqIdx || []);
    // Pool = choosable champions. Required units are forced on, so they must be
    // present as variables even if the cost filter excluded them.
    const pool = [...new Set([...(opts.poolIdx || []), ...required])]
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

    const L = [];
    const scoringTerms = [], tierTerms = [], wasteTerms = [];
    for (const t of live) {
      const bp = T.bps[t];
      if (T.floors[t] === null || muted.has(t)) continue;
      const first = bp.findIndex(b => b >= T.floors[t]);
      if (first < 0) continue;
      scoringTerms.push(`y${t}_${first}`);
      for (let j = first; j < bp.length; j++) tierTerms.push(`y${t}_${j}`);
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
    (opts.reqTraits || []).forEach((r, i) => {
      if (live.includes(r.t)) L.push(` rt${i}: +1 n${r.t} >= ${r.n}`);
    });

    // Capacity trait must actually be active to grant its slots, and must NOT
    // be active when we're solving the zero-bonus case (otherwise the solver
    // returns a board that would really have had more slots available).
    T.teamSize.forEach((tiers, t) => {
      if (!tiers.length || !live.includes(t)) return;
      for (const tier of tiers) {
        if (bonus && tier.slots === bonus) L.push(` cap${t}: +1 n${t} >= ${tier.min}`);
        else if (!bonus) L.push(` cap${t}: +1 n${t} <= ${tier.min - 1}`);
      }
    });

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
