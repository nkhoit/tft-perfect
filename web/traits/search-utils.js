(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SearchUtils = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  // Bumped for the MILP hybrid: cached rows from the DFS-only era lack the
  // optimality proof, so they must not satisfy a new-format query.
  const ALGORITHM_VERSION = 'milp-hybrid-v5';
  const KEY = {
    live: (a, b) => b.live - a.live,
    tier: (a, b) => b.tierSum - a.tierSum,
    waste: (a, b) => a.waste - b.waste,
    cost: (a, b) => a.gold - b.gold,
    rich: (a, b) => b.gold - a.gold,
  };

  function sortOrder(primary, secondary) {
    return [primary, secondary, 'live', 'tier', 'waste', 'cost']
      .filter((key, i, keys) => KEY[key] && keys.indexOf(key) === i);
  }

  function comparator(primary, secondary) {
    const order = sortOrder(primary, secondary);
    return (a, b) => {
      for (const key of order) {
        const difference = KEY[key](a, b);
        if (difference) return difference;
      }
      return 0;
    };
  }

  function breakpoints(trait) {
    return [...new Set((trait.bp || [1]).filter(Number.isFinite))].sort((a, b) => a - b);
  }

  function antiStack(trait) {
    return /only active while fielding\s+1\b/i.test(trait.desc || '');
  }

  function isUnique(trait) {
    if ((trait.styles || []).some(style => style.style === 'unique')) return true;
    return breakpoints(trait).every(breakpoint => breakpoint <= 1);
  }

  function scoreFloor(trait) {
    if (isUnique(trait)) return Infinity;
    const bp = breakpoints(trait);
    if (antiStack(trait)) return bp.find(breakpoint => breakpoint > 1) ?? Infinity;
    return bp[0] ?? Infinity;
  }

  function scoresAt(trait, count) {
    return count >= scoreFloor(trait);
  }

  function scoringBreakpoints(trait) {
    const floor = scoreFloor(trait);
    return breakpoints(trait).filter(breakpoint => breakpoint >= floor);
  }

  function traitSignature(row) {
    return [...(row.active || []), ...(row.dead || [])]
      .map(([trait, count]) => [trait, count])
      .sort((a, b) => a[0] - b[0])
      .map(([trait, count]) => `${trait}:${count}`)
      .join('|');
  }

  function mergeSearchResults(parts, primary, secondary, limit = 100) {
    const compare = comparator(primary, secondary);
    const merged = {
      rows: [],
      total: parts.reduce((total, part) => total + part.total, 0),
      truncated: parts.some(part => part.truncated),
      capped: parts.some(part => part.capped),
      ms: Math.max(...parts.map(part => part.ms)),
      nodes: parts.reduce((total, part) => total + (part.nodes || 0), 0),
      stopReason: parts.some(part => part.stopReason === 'time')
        ? 'time'
        : parts.some(part => part.stopReason === 'nodes') ? 'nodes' : null,
    };
    const candidatesBySignature = new Map();
    const plain = row => {
      const copy = { ...row };
      delete copy.variants;
      return copy;
    };
    for (const part of parts) {
      for (const row of part.rows) {
        const signature = traitSignature(row);
        if (!candidatesBySignature.has(signature)) candidatesBySignature.set(signature, []);
        const candidates = candidatesBySignature.get(signature);
        candidates.push(plain(row));
        for (const variant of (row.variants || [])) candidates.push(plain(variant));
      }
    }
    for (const candidates of candidatesBySignature.values()) {
      candidates.sort(compare);
      const representative = candidates[0];
      representative.variants = candidates.slice(1, 25);
      merged.rows.push(representative);
    }
    merged.rows.sort(compare);
    merged.rows.length = Math.min(merged.rows.length, limit);
    return merged;
  }

  function searchCacheKey(version, options) {
    const numbers = values => [...(values || [])].sort((a, b) => a - b);
    const canonical = {
      version,
      size: options.size,
      maxWaste: options.maxWaste,
      reqIdx: numbers(options.reqIdx),
      poolIdx: numbers(options.poolIdx),
      emblems: [...(options.emblems || [])].sort(),
      reqTraits: [...(options.reqTraits || [])]
        .map(({ t, n }) => ({ t, n }))
        .sort((a, b) => a.t - b.t || a.n - b.n),
      muted: numbers(options.muted),
      sortMode: options.sortMode,
      sortMode2: options.sortMode2,
      effort: options.effort,
      timeBudgetMs: options.timeBudgetMs,
      limit: options.limit,
      returnN: options.returnN,
    };
    return JSON.stringify(canonical);
  }

  function summary(result) {
    const seconds = (result.ms / 1000).toFixed(1);
    const effort = result.effort
      ? `<span class="effort">${result.effort[0].toUpperCase() + result.effort.slice(1)}</span> · `
      : '';
    const cachedTitle = result.cached === 'memory'
      ? 'Loaded from the in-memory result cache. '
      : result.cached === 'device'
        ? 'Loaded from this device\'s persistent result cache. '
        : result.cached === 'precomputed'
          ? 'Loaded from the precomputed landing result. '
          : '';
    // `proved` is the important signal: the MILP solver ran this exact query to
    // optimality, so the top board is the best that exists. Without it the DFS
    // may simply have run out of budget, which used to look identical to
    // success — the single most misleading thing this UI could do.
    const proved = !!result.proved;
    // A partial render shows only the proven frontier while the wider search
    // still runs. Say so, or the board count looks like the search failed.
    const partial = !!result.partial;
    const provedBadge = '<span class="opt" title="A constraint solver proved this '
      + 'is the highest-scoring board for these settings — not just the best one found '
      + 'before the search ran out of budget.">optimal</span>';
    const statusHtml = effort + (result.cached
      ? `<span class="hit">cached</span>`
        + (proved ? ' · ' + provedBadge : '')
        + (!proved && result.truncated ? ' · <span class="cut">incomplete</span>' : '')
      : partial
        ? (proved ? provedBadge + ' · ' : '') + '<span class="more">finding more…</span>'
        : proved
          ? `${provedBadge} · ${seconds}s`
          : result.truncated
            ? `<span class="cut" title="Hit the search limit; unseen boards may rank higher. Narrow the pool or require a trait.">stopped early</span> · ${seconds}s`
            : `searched in ${seconds}s`);
    const countHtml = partial
      ? `best <b>${result.rows.length}</b> so far` +
        (result.total ? ` of ${result.total.toLocaleString()}+ scored` : '') +
        (proved ? ' <span class="tag ok">optimal</span>' : '')
      : `best <b>${result.rows.length}</b> of ${result.total.toLocaleString()}+ scored` +
        (proved
          ? ' <span class="tag ok">optimal</span>'
          : result.truncated ? ' <span class="tag warn">incomplete</span>' : '');
    const title = cachedTitle + (partial
      ? (proved
        ? 'The top board is already proved optimal. Lower-ranked boards are still filling in.'
        : 'Results are still filling in as the search finds them.')
      : proved
        ? 'The top board is provably the best for these settings. Lower-ranked boards come from the wider search and may be incomplete.'
        : result.truncated
          ? result.stopReason === 'time'
            ? 'Search reached its time budget. These are the best boards found, but unseen boards may rank higher.'
            : 'Search hit its node limit. These are the best boards found, but unseen boards may rank higher.'
          : 'Search completed without hitting its node limit. The scored count is a lower bound because noncompetitive branches are skipped.');
    return { statusHtml, countHtml, title };
  }

  // Identity for a board: its roster, order-independent. Two rows with the same
  // units are the same comp even if the search returned them in different orders.
  function compSignature(units) {
    return [...units].sort((a, b) => a - b).join(',');
  }

  // Flip a comp's selection in the given Map. Returns the resulting state:
  // true when it is now selected, false when it is not.
  function toggleSelection(selected, sig, row) {
    if (selected.has(sig)) {
      selected.delete(sig);
      return false;
    }
    if (!row) return false;
    selected.set(sig, row);
    return true;
  }

  return {
    algorithmVersion: ALGORITHM_VERSION,
    antiStack,
    breakpoints,
    compSignature,
    comparator,
    toggleSelection,
    isUnique,
    mergeSearchResults,
    scoreFloor,
    scoringBreakpoints,
    scoresAt,
    searchCacheKey,
    sortOrder,
    summary,
    traitSignature,
  };
});
