// worker.js — combinatorial board search with wasted-trait pruning.
// Runs off the main thread so the UI stays responsive while sliders move.

importScripts('search-utils.js?v=milp-hybrid-v7');

let DB = null;
let TK = [];        // trait keys, indexed
let TI = null;      // trait key -> index
let BP1 = null;     // Int16Array: first breakpoint per trait
let SCORE1 = null;  // Int16Array: first breakpoint that earns score
let UNIQ = null;    // Uint8Array: 1 = unique/1-unit trait, excluded from the active count
let MUTE = null;    // Uint8Array: 1 = user muted this trait, excluded from the active count
let BPS = [];       // per-trait breakpoint arrays
let CTP = [];       // per-champion [trait index, points] pairs
let CSLOT = null;   // Int16Array: team slots consumed per champion
let CGROUP = [];    // mutually exclusive champion-form group
let TEAM_SIZE = []; // per-trait [{min, slots}] capacity bonuses
let TEAM_TRAITS = [];
let TEAM_BONUSES = [0];
let MAX_TEAM_BONUS = 0;

// A trait is "unique" when it activates off a single unit (Avatar, Caustic,
// Thornmaiden, ...). They're free with the unit, so counting them inflates the
// active-trait score and drowns out genuinely wide boards. Still displayed.
function init(db) {
  DB = db;
  TK = Object.keys(db.traits);
  TI = new Map(TK.map((k, i) => [k, i]));
  BP1 = new Int16Array(TK.length);
  SCORE1 = new Int16Array(TK.length);
  UNIQ = new Uint8Array(TK.length);
  BPS = TK.map(k => SearchUtils.breakpoints(db.traits[k]));
  TK.forEach((k, i) => {
    BP1[i] = BPS[i][0] || 1;
    const floor = SearchUtils.scoreFloor(db.traits[k]);
    SCORE1[i] = Number.isFinite(floor) ? floor : 32767;
    UNIQ[i] = SearchUtils.isUnique(db.traits[k]) ? 1 : 0;
  });
  CTP = db.champions.map(c => c.traits
    .map(k => [TI.get(k), (c.traitPoints || {})[k] || 1])
    .filter(([t]) => t !== undefined));
  CSLOT = Int16Array.from(db.champions, c => c.slots || 1);
  CGROUP = db.champions.map(c => c.group || null);
  TEAM_SIZE = TK.map(k => (db.traits[k].teamSize || []).slice().sort((a, b) => a.min - b.min));
  TEAM_TRAITS = TEAM_SIZE.map((tiers, trait) => tiers.length ? trait : -1)
    .filter(trait => trait >= 0);
  MAX_TEAM_BONUS = TEAM_TRAITS.reduce((sum, trait) =>
    sum + TEAM_SIZE[trait].reduce((best, tier) => Math.max(best, tier.slots), 0), 0);
  let bonuses = new Set([0]);
  for (const trait of TEAM_TRAITS) {
    const options = [0, ...new Set(TEAM_SIZE[trait].map(tier => tier.slots))];
    bonuses = new Set([...bonuses].flatMap(total => options.map(slots => total + slots)));
  }
  TEAM_BONUSES = [...bonuses].sort((a, b) => b - a);
}

// tier index for a trait at a given count (-1 = inactive)
function tierOf(bp, n) {
  let t = -1;
  for (let i = 0; i < bp.length; i++) if (n >= bp[i]) t = i;
  return t;
}

// Highest breakpoint <= n (0 when the trait isn't active yet).
function bpReached(bp, n) {
  let v = 0;
  for (let i = 0; i < bp.length; i++) if (n >= bp[i]) v = bp[i];
  return v;
}

// Wasted points for one trait: contributions that buy nothing.
//   below first breakpoint -> all of them are dead weight
//   past a breakpoint      -> the overshoot (4/5 Riftbeast = 1 wasted)
function wasteOf(bp, n) {
  if (!n) return 0;
  return n - bpReached(bp, n);
}

function search(o) {
  const { size, maxWaste, reqIdx, poolIdx, emblems, limit } = o;
  const reqTraits = o.reqTraits || [];   // [{t: traitIdx, n: minCount}]

  const nT = TK.length;
  // Muted traits still show on the board, but earn no score or waste.
  MUTE = new Uint8Array(nT);
  for (const t of (o.muted || [])) if (t >= 0 && t < nT) MUTE[t] = 1;
  const counts = new Int16Array(nT);
  const emblemCounts = new Int16Array(nT);
  for (const emblem of emblems) {
    const trait = typeof emblem === 'string' ? TI.get(emblem) : emblem;
    if (trait >= 0 && trait < nT) {
      counts[trait]++;
      emblemCounts[trait]++;
    }
  }

  const groups = new Set();
  let requiredSlots = 0;
  let baseGold = 0;
  for (const i of reqIdx) {
    const group = CGROUP[i];
    if (group && groups.has(group)) {
      return { error: `Required ${group} forms are mutually exclusive.` };
    }
    if (group) groups.add(group);
    requiredSlots += CSLOT[i];
    baseGold += DB.champions[i].cost * 3;
    for (const [t, points] of CTP[i]) counts[t] += points;
  }

  const maxSlots = size + MAX_TEAM_BONUS;
  if (requiredSlots > maxSlots) {
    return { error: 'More required unit slots than this board size can support.' };
  }

  function championPriority(index) {
    let priority = 0;
    for (const [trait, points] of CTP[index]) {
      for (const requirement of reqTraits) {
        if (requirement.t !== trait) continue;
        const short = Math.max(0, requirement.n - counts[trait]);
        priority += Math.min(points, short) * 100;
        if (short > 0 && points >= short) priority += 200;
      }
      if (UNIQ[trait] || MUTE[trait]) continue;
      const count = counts[trait];
      const floor = SCORE1[trait];
      if (count < floor) {
        const short = floor - count;
        priority += Math.min(points, short) * 8;
        if (points >= short) priority += 40;
      } else {
        priority += points * 2;
      }
      const next = BPS[trait].find(breakpoint => breakpoint > count);
      if (next && points >= next - count) priority += 15;
    }
    return priority / CSLOT[index];
  }

  const branchOrder = SearchUtils.sortOrder(o.sortMode, o.sortMode2);
  const pool = poolIdx.slice();
  if (o.effort && o.effort !== 'deep') {
    pool.sort((a, b) => {
      const priority = championPriority(b) - championPriority(a);
      if (priority) return priority;
      for (const key of branchOrder) {
        if (key === 'cost') return DB.champions[a].cost - DB.champions[b].cost || a - b;
        if (key === 'rich') return DB.champions[b].cost - DB.champions[a].cost || a - b;
      }
      return a - b;
    });
  }
  const uniqueCap = Math.max(limit || 100, o.returnN || limit || 100);
  const kept = [];
  const bySignature = new Map();
  let nodes = 0, truncated = false, stopReason = null;
  // Shards split the top-level branch round-robin across workers.
  const shards = o.shards || 1, shard = o.shard || 0;
  // Budget is per shard, not a split of one global pot. Top-level branches are
  // wildly uneven in size, so dividing the budget starves whichever shard drew
  // the fat branches and silently truncates boards the serial search finds.
  const NODE_BUDGET = 40e6;
  const timeBudgetMs = Number.isFinite(o.timeBudgetMs) && o.timeBudgetMs > 0
    ? o.timeBudgetMs
    : Infinity;
  const deadline = performance.now() + timeBudgetMs;

  // Interim progress. The `kept` list is maintained in sorted order at all
  // times, so snapshotting it mid-search is just a slice — no extra work, and
  // the DFS keeps running. Emitting lets the UI fill results in as they are
  // found instead of staying blank until the whole shard finishes.
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const progressEveryMs = Number.isFinite(o.progressEveryMs) && o.progressEveryMs > 0
    ? o.progressEveryMs
    : 400;
  let nextProgressAt = performance.now() + progressEveryMs;

  function snapshotRows() {
    return kept.slice(0, o.returnN || limit).map(entry => ({
      ...entry.row,
      variants: entry.variants,
    }));
  }

  function consumeNode() {
    nodes++;
    if (nodes > NODE_BUDGET) {
      truncated = true;
      stopReason = 'nodes';
      return false;
    }
    if ((nodes & 4095) === 0) {
      const now = performance.now();
      if (now >= deadline) {
        truncated = true;
        stopReason = 'time';
        return false;
      }
      // Cheap: one compare per 4096 nodes, a slice only when it actually fires.
      if (onProgress && now >= nextProgressAt) {
        nextProgressAt = now + progressEveryMs;
        onProgress({ rows: snapshotRows(), total: found, nodes });
      }
    }
    return true;
  }

  // Maximum trait points reachable from each pool suffix for every remaining
  // slot capacity. This is a 0/1 knapsack because Elder Dragon consumes two
  // slots and Avatar origins contribute two points.
  const P = pool.length;
  const CAP = maxSlots + 1;
  const reach = new Int16Array((P + 1) * nT * CAP);
  const reachAt = (start, trait, capacity) => reach[(start * nT + trait) * CAP + capacity];
  for (let i = P - 1; i >= 0; i--) {
    for (let t = 0; t < nT; t++) {
      for (let capacity = 0; capacity <= maxSlots; capacity++) {
        reach[(i * nT + t) * CAP + capacity] = reachAt(i + 1, t, capacity);
      }
    }
    const champion = pool[i];
    const slots = CSLOT[champion];
    for (const [t, points] of CTP[champion]) {
      for (let capacity = slots; capacity <= maxSlots; capacity++) {
        const index = (i * nT + t) * CAP + capacity;
        reach[index] = Math.max(reach[index], points + reachAt(i + 1, t, capacity - slots));
      }
    }
  }

  // Lower bound on waste: if even the best reachable point total cannot hit a
  // higher breakpoint, the current overshoot is locked in.
  function wasteLB(start, capacity) {
    let waste = 0;
    for (let t = 0; t < nT; t++) {
      if (MUTE[t]) continue;
      const count = counts[t];
      if (!count) continue;
      const ceiling = count + reachAt(start, t, capacity);
      let best = 0;
      for (const breakpoint of BPS[t]) if (breakpoint <= ceiling) best = breakpoint;
      if (best <= count) waste += count - best;
    }
    return waste;
  }

  // Prune when a demanded trait can no longer reach its target count from here.
  function reqUnreachable(start, capacity) {
    for (const { t, n } of reqTraits) {
      const short = n - counts[t];
      if (short > 0 && short > reachAt(start, t, capacity)) return true;
    }
    return false;
  }

  function reqSatisfied() {
    for (const { t, n } of reqTraits) if (counts[t] < n) return false;
    return true;
  }

  // Retain only the best unique trait signatures this shard can contribute to
  // the global top-K. Each signature also keeps its best roster alternates.
  const order = SearchUtils.sortOrder(o.sortMode, o.sortMode2);
  const cmp = SearchUtils.comparator(o.sortMode, o.sortMode2);
  let trimmed = false;
  let found = 0;
  let worst = null;

  // Same ordering as cmp, but on raw scalars so we can reject a candidate
  // before allocating its result object.
  const cmpScore = (live, tierSum, waste, gold, b) => {
    for (const k of order) {
      let d = 0;
      if (k === 'live') d = b.live - live;
      else if (k === 'tier') d = b.tierSum - tierSum;
      else if (k === 'waste') d = waste - b.waste;
      else if (k === 'rich') d = b.gold - gold;
      else d = gold - b.gold;
      if (d) return d;
    }
    return 0;
  };

  function insertEntry(entry) {
    let low = 0, high = kept.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cmp(entry.row, kept[middle].row) < 0) high = middle;
      else low = middle + 1;
    }
    kept.splice(low, 0, entry);
  }

  function insertVariant(entry, row) {
    let index = entry.variants.findIndex(variant => cmp(row, variant) < 0);
    if (index < 0) index = entry.variants.length;
    if (index < 24) entry.variants.splice(index, 0, row);
    if (entry.variants.length > 24) entry.variants.length = 24;
  }

  function refreshWorst() {
    worst = kept.length >= uniqueCap ? kept[kept.length - 1].row : null;
  }

  function retainCandidate(signature, row) {
    const existing = bySignature.get(signature);
    if (existing) {
      if (cmp(row, existing.row) < 0) {
        const previous = existing.row;
        kept.splice(kept.indexOf(existing), 1);
        existing.row = row;
        insertEntry(existing);
        insertVariant(existing, previous);
      } else {
        insertVariant(existing, row);
      }
      refreshWorst();
      return;
    }

    const entry = { signature, row, variants: [] };
    if (kept.length < uniqueCap) {
      bySignature.set(signature, entry);
      insertEntry(entry);
      refreshWorst();
      return;
    }
    if (cmp(row, kept[kept.length - 1].row) < 0) {
      const evicted = kept.pop();
      bySignature.delete(evicted.signature);
      bySignature.set(signature, entry);
      insertEntry(entry);
    }
    trimmed = true;
    refreshWorst();
  }

  // Exact-slot suffix knapsacks provide admissible cost bounds for weighted
  // units. Group conflicts are intentionally ignored, making the bounds more
  // optimistic but never unsafe.
  const INF = 0x3fffffff;
  const cheap = new Int32Array((P + 1) * CAP);
  const dear = new Int32Array((P + 1) * CAP);
  cheap.fill(INF);
  dear.fill(-1);
  cheap[P * CAP] = 0;
  dear[P * CAP] = 0;
  for (let i = P - 1; i >= 0; i--) {
    const champion = pool[i];
    const slots = CSLOT[champion];
    const gold = DB.champions[champion].cost * 3;
    for (let capacity = 0; capacity <= maxSlots; capacity++) {
      const next = (i + 1) * CAP + capacity;
      const here = i * CAP + capacity;
      cheap[here] = cheap[next];
      dear[here] = dear[next];
      if (capacity >= slots) {
        const tail = (i + 1) * CAP + capacity - slots;
        if (cheap[tail] < INF) cheap[here] = Math.min(cheap[here], gold + cheap[tail]);
        if (dear[tail] >= 0) dear[here] = Math.max(dear[here], gold + dear[tail]);
      }
    }
  }

  function teamSizeBonus() {
    let bonus = 0;
    for (const t of TEAM_TRAITS) {
      let traitBonus = 0;
      for (const tier of TEAM_SIZE[t]) if (counts[t] >= tier.min) traitBonus = tier.slots;
      bonus += traitBonus;
    }
    return bonus;
  }

  function maxReachableTeamSizeBonus(start, capacity) {
    let bonus = 0;
    for (const t of TEAM_TRAITS) {
      const ceiling = counts[t] + reachAt(start, t, capacity);
      let traitBonus = 0;
      for (const tier of TEAM_SIZE[t]) if (ceiling >= tier.min) traitBonus = tier.slots;
      bonus += traitBonus;
    }
    return bonus;
  }

  function bonusReachable(expected, start, capacity) {
    const current = teamSizeBonus();
    if (current > expected) return false;
    if (current === expected) return true;
    return maxReachableTeamSizeBonus(start, capacity) >= expected;
  }

  function minSlotsForTrait(trait, target, depth) {
    const needed = Math.max(0, target - emblemCounts[trait]);
    if (!needed) return 0;
    const best = new Int16Array(needed + 1);
    best.fill(32767);
    best[0] = 0;

    const add = champion => {
      const pair = CTP[champion].find(([t]) => t === trait);
      if (!pair) return;
      const points = pair[1];
      const slots = CSLOT[champion];
      for (let have = needed - 1; have >= 0; have--) {
        if (best[have] === 32767) continue;
        const next = Math.min(needed, have + points);
        best[next] = Math.min(best[next], best[have] + slots);
      }
    };
    for (const champion of reqIdx) add(champion);
    for (let i = 0; i < depth; i++) add(pick[i]);
    return best[needed];
  }

  // A capacity trait must be activatable before using the slots it grants.
  // Find an unlocking order for all active capacity traits on the final board.
  function unlockedTeamSizeBonus(depth) {
    const pending = [];
    for (const trait of TEAM_TRAITS) {
      let active = null;
      for (const tier of TEAM_SIZE[trait]) if (counts[trait] >= tier.min) active = tier;
      if (active) pending.push({ trait, ...active });
    }
    let capacity = size;
    let bonus = 0;
    while (pending.length) {
      const index = pending.findIndex(rule =>
        minSlotsForTrait(rule.trait, rule.min, depth) <= capacity);
      if (index < 0) break;
      const [rule] = pending.splice(index, 1);
      capacity += rule.slots;
      bonus += rule.slots;
    }
    return bonus;
  }

  // Optimistic bounds on what the current partial board could still become.
  // Every one of these must err in the candidate's favour: overestimate the
  // maximised keys (live/tier), underestimate the minimised ones (waste/cost).
  // A bound that is ever too pessimistic silently deletes valid boards.
  function boundLive(start, capacity) {
    let ub = 0;
    for (let t = 0; t < nT; t++) {
      if (UNIQ[t] || MUTE[t]) continue;         // never scored
      const c = counts[t];
      if (c >= SCORE1[t]) { ub++; continue; }   // already scoring
      if (c + reachAt(start, t, capacity) >= SCORE1[t]) ub++;
    }
    return ub;
  }

  function boundTier(start, capacity) {
    let ub = 0;
    for (let t = 0; t < nT; t++) {
      if (UNIQ[t] || MUTE[t]) continue;
      const c = counts[t];
      const ceiling = c + reachAt(start, t, capacity);
      if (ceiling < SCORE1[t]) continue;
      const ti = tierOf(BPS[t], ceiling);
      if (ti >= 0) ub += ti + 1;
    }
    return ub;
  }

  function boundGold(start, capacity, gold) {
    const addition = cheap[start * CAP + capacity];
    return addition < INF ? gold + addition : INF;
  }

  function boundGoldMax(start, capacity, gold) {
    const addition = dear[start * CAP + capacity];
    return gold + addition;
  }

  // Compare an optimistic tuple in the same lexicographic order as completed
  // boards. Independent bounds remain safe: later keys matter only when every
  // earlier optimistic key exactly ties the retained cutoff.
  function canBeat(start, capacity, gold) {
    if (!worst) return true;
    let live, tier, waste, cheapest, richest;
    for (const key of order) {
      let difference = 0;
      if (key === 'live') {
        live ??= boundLive(start, capacity);
        difference = worst.live - live;
      } else if (key === 'tier') {
        tier ??= boundTier(start, capacity);
        difference = worst.tierSum - tier;
      } else if (key === 'waste') {
        waste ??= wasteLB(start, capacity);
        difference = waste - worst.waste;
      } else if (key === 'rich') {
        richest ??= boundGoldMax(start, capacity, gold);
        difference = worst.gold - richest;
      } else {
        cheapest ??= boundGold(start, capacity, gold);
        difference = cheapest - worst.gold;
      }
      if (difference < 0) return true;
      if (difference > 0) return false;
    }
    return true;
  }

  const pick = new Int32Array(maxSlots);

  function evaluate(depth, usedSlots, gold) {
    if (!reqSatisfied()) return;
    let live = 0, uniqN = 0, waste = 0, tierSum = 0;
    const active = [], dead = [], over = [];
    let signature = '';
    for (let t = 0; t < nT; t++) {
      const c = counts[t];
      if (!c) continue;
      signature += (signature ? '|' : '') + `${t}:${c}`;
      const bp = BPS[t];
      const w = wasteOf(bp, c);
      if (w) {
        if (!MUTE[t]) waste += w;
        if (c >= BP1[t]) over.push([t, w]); else dead.push([t, c]);
      }
      if (c >= BP1[t]) {
        const ti = tierOf(bp, c);
        active.push([t, c, ti]);
        if (UNIQ[t]) uniqN++;
        else if (!MUTE[t] && c >= SCORE1[t]) { live++; tierSum += ti + 1; }
      }
    }
    if (waste > maxWaste) return;
    found++;
    const existing = bySignature.get(signature);
    if (!existing && worst && cmpScore(live, tierSum, waste, gold, worst) >= 0) {
      trimmed = true;
      return;
    }
    if (existing && cmpScore(live, tierSum, waste, gold, existing.row) >= 0
        && existing.variants.length >= 24
        && cmpScore(live, tierSum, waste, gold, existing.variants[23]) >= 0) {
      trimmed = true;
      return;
    }
    const units = reqIdx.concat(Array.from(pick.subarray(0, depth)));
    // uniques last so the meaningful traits read first
    const dim = x => (UNIQ[x] || MUTE[x] || counts[x] < SCORE1[x]) ? 1 : 0;
    active.sort((a, b) => (dim(a[0]) - dim(b[0])) || b[1] - a[1]);
    retainCandidate(signature, {
      units, active, dead, over, live, uniqN, waste, tierSum, gold, slots: usedSlots,
    });
  }

  function dfs(start, depth, usedSlots, gold, targetSlots, expectedBonus) {
    if (truncated) return;
    if (usedSlots === targetSlots) {
      // A required-only board belongs to shard zero. Every board with optional
      // units already belongs to the shard of its first selected pool index.
      if ((depth > 0 || shard === 0) && teamSizeBonus() === expectedBonus
          && unlockedTeamSizeBonus(depth) === expectedBonus) {
        evaluate(depth, usedSlots, gold);
      }
      return;
    }
    const remainingCapacity = targetSlots - usedSlots;

    for (let i = start; i < pool.length; i++) {
      if (depth === 0 && shards > 1 && i % shards !== shard) continue;
      const ci = pool[i];
      const slots = CSLOT[ci];
      if (slots > remainingCapacity) continue;
      const group = CGROUP[ci];
      if (group && groups.has(group)) continue;
      if (!consumeNode()) return;
      if (group) groups.add(group);
      for (const [t, points] of CTP[ci]) counts[t] += points;
      pick[depth] = ci;
      const nextSlots = usedSlots + slots;
      const capacity = targetSlots - nextSlots;
      const nextGold = gold + DB.champions[ci].cost * 3;
      if (bonusReachable(expectedBonus, i + 1, capacity)
          && wasteLB(i + 1, capacity) <= maxWaste
          && !reqUnreachable(i + 1, capacity)
          && canBeat(i + 1, capacity, nextGold)) {
        dfs(i + 1, depth + 1, nextSlots, nextGold, targetSlots, expectedBonus);
      }
      for (const [t, points] of CTP[ci]) counts[t] -= points;
      if (group) groups.delete(group);
      if (truncated) return;
    }
  }

  for (const expectedBonus of TEAM_BONUSES) {
    if (truncated) break;
    const targetSlots = size + expectedBonus;
    if (requiredSlots > targetSlots) continue;
    const capacity = targetSlots - requiredSlots;
    if (bonusReachable(expectedBonus, 0, capacity)
        && wasteLB(0, capacity) <= maxWaste
        && !reqUnreachable(0, capacity)
        && canBeat(0, capacity, baseGold)) {
      dfs(0, 0, requiredSlots, baseGold, targetSlots, expectedBonus);
    }
  }

  return {
    rows: snapshotRows(),
    total: found, truncated, capped: trimmed, nodes, stopReason,
  };
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init(m.db); postMessage({ type: 'ready' }); return; }
  if (m.type === 'search') {
    const t0 = performance.now();
    let r;
    try {
      r = search({
        ...m.opts,
        // Stream partial results so the UI fills in as boards are found.
        // `partial: true` marks these as not-yet-final; the app must keep
        // waiting for the real 'result' message before completing the search.
        onProgress: m.opts && m.opts.progress === false ? null : (snap) => {
          postMessage({
            type: 'result', id: m.id, partial: true,
            ms: Math.round(performance.now() - t0),
            rows: snap.rows, total: snap.total, nodes: snap.nodes,
            truncated: false, capped: false, stopReason: null,
          });
        },
      });
    } catch (err) { r = { error: String(err) }; }
    postMessage({ type: 'result', id: m.id, ms: Math.round(performance.now() - t0), ...r });
  }
};
