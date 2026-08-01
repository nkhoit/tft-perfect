(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SearchUtils = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
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
      limit: options.limit,
      returnN: options.returnN,
    };
    return JSON.stringify(canonical);
  }

  function summary(result) {
    const seconds = (result.ms / 1000).toFixed(1);
    const cachedTitle = result.cached === 'memory'
      ? 'Loaded from the in-memory result cache. '
      : result.cached === 'device'
        ? 'Loaded from this device\'s persistent result cache. '
        : '';
    const statusHtml = result.cached
      ? `<span class="hit">cached</span>` +
        (result.truncated ? ' · <span class="cut">incomplete</span>' : '')
      : result.truncated
        ? `<span class="cut" title="Hit the search limit; unseen boards may rank higher. Narrow the pool or require a trait.">stopped early</span> · ${seconds}s`
        : `searched in ${seconds}s`;
    const countHtml = `best <b>${result.rows.length}</b> of ${result.total.toLocaleString()}+ scored` +
      (result.truncated ? ' <span class="tag warn">incomplete</span>' : '');
    const title = cachedTitle + (result.truncated
      ? 'Search hit its node limit. These are the best boards found, but unseen boards may rank higher.'
      : 'Search completed without hitting its node limit. The scored count is a lower bound because noncompetitive branches are skipped.');
    return { statusHtml, countHtml, title };
  }

  return {
    antiStack,
    breakpoints,
    comparator,
    isUnique,
    scoreFloor,
    scoringBreakpoints,
    scoresAt,
    searchCacheKey,
    sortOrder,
    summary,
    traitSignature,
  };
});
