// worker.js — combinatorial board search with wasted-trait pruning.
// Runs off the main thread so the UI stays responsive while sliders move.

importScripts('search-utils.js');

let DB = null;
let TK = [];        // trait keys, indexed
let TI = null;      // trait key -> index
let BP1 = null;     // Int16Array: first breakpoint per trait
let SCORE1 = null;  // Int16Array: first breakpoint that earns score
let UNIQ = null;    // Uint8Array: 1 = unique/1-unit trait, excluded from the active count
let MUTE = null;    // Uint8Array: 1 = user muted this trait, excluded from the active count
let BPS = [];       // per-trait breakpoint arrays
let CTR = [];       // per-champion array of trait indices

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
  CTR = db.champions.map(c => c.traits.map(t => TI.get(t)).filter(x => x !== undefined));
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

// Wasted units for one trait: units carrying it that buy nothing.
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
  for (const emblem of emblems) {
    const trait = typeof emblem === 'string' ? TI.get(emblem) : emblem;
    if (trait >= 0 && trait < nT) counts[trait]++;
  }

  // seed required units
  for (const i of reqIdx) for (const t of CTR[i]) counts[t]++;

  const need = size - reqIdx.length;
  const pool = poolIdx;
  const results = [];
  let nodes = 0, truncated = false, capped = false;
  // Shards split the top-level branch round-robin across workers. Each owns a
  // slice of the node budget so total work matches the single-threaded ceiling.
  const shards = o.shards || 1, shard = o.shard || 0;
  // Budget is per shard, not a split of one global pot. Top-level branches are
  // wildly uneven in size, so dividing the budget starves whichever shard drew
  // the fat branches and silently truncates boards the serial search finds.
  const NODE_BUDGET = 40e6;
  const RESULT_CAP = Math.max(20000, Math.ceil(120000 / shards));

  // lower bound on wasted traits: any trait already started that cannot
  // possibly reach its first breakpoint with `slotsLeft` more units.
  // Lower bound on wasted units. Adding more units can only raise a trait's
  // count, so any overshoot past the highest breakpoint still reachable with
  // `slotsLeft` spare slots is already locked in.
  // wasteLB runs at every node, so the per-trait breakpoint scan is precomputed.
  // Counts and spare slots are both tiny and bounded, so the whole function
  // collapses into a flat table lookup: LBT[trait][count][slotsLeft].
  const MAXC = size + emblems.length + 1;   // a trait can't exceed board size + its emblems
  const MC1 = MAXC + 1, S1 = size + 1;
  const LBT = new Int16Array(nT * MC1 * S1);
  for (let t = 0; t < nT; t++) {
    const bp = BPS[t];
    for (let c = 0; c <= MAXC; c++) {
      for (let s = 0; s < S1; s++) {
        let v = 0;
        if (c) {
          const ceiling = c + s;
          let best = 0;
          for (let i = 0; i < bp.length; i++) if (bp[i] <= ceiling) best = bp[i];
          if (best <= c) v = c - best;   // can't reach the next tier from here
        }
        LBT[(t * MC1 + c) * S1 + s] = v;
      }
    }
  }

  function wasteLB(slotsLeft) {
    let w = 0;
    for (let t = 0; t < nT; t++) {
      if (MUTE[t]) continue;
      const c = counts[t];
      if (c) w += LBT[(t * MC1 + c) * S1 + slotsLeft];
    }
    return w;
  }

  // Suffix availability: avail[t * (P+1) + i] = how many units in pool[i..]
  // carry trait t. Lets the requirement prune know what's *still reachable*
  // from the current DFS position instead of using a whole-pool over-estimate.
  const P = poolIdx.length;
  const avail = new Int16Array(nT * (P + 1));
  for (let i = P - 1; i >= 0; i--) {
    const base = i * nT, prev = (i + 1) * nT;
    for (let t = 0; t < nT; t++) avail[base + t] = avail[prev + t];
    for (const t of CTR[poolIdx[i]]) avail[base + t]++;
  }

  // Prune when a demanded trait can no longer reach its target count from here.
  function reqUnreachable(start, slotsLeft) {
    const base = start * nT;
    for (let k = 0; k < reqTraits.length; k++) {
      const { t, n } = reqTraits[k];
      const short = n - counts[t];
      if (short > 0 && short > (slotsLeft < avail[base + t] ? slotsLeft : avail[base + t])) return true;
    }
    return false;
  }

  function reqSatisfied() {
    for (const { t, n } of reqTraits) if (counts[t] < n) return false;
    return true;
  }

  // Comparator is known up front, so instead of stopping at an arbitrary cap
  // (which biases results toward whatever DFS happened to reach first) we keep
  // the best RESULT_CAP boards seen and drop the worst half when we overflow.
  const order = SearchUtils.sortOrder(o.sortMode, o.sortMode2);
  const cmp = SearchUtils.comparator(o.sortMode, o.sortMode2);
  let trimmed = false;   // true once we've discarded boards that ranked poorly
  let found = 0;         // total matching boards, including any we trimmed
  let worst = null;      // worst board currently kept, once we've trimmed once

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

  // ---- branch-and-bound support ----
  // cheapK[start * (size+1) + k] = gold for the k cheapest units in pool[start..].
  // Used for an admissible lower bound on a board's final cost.
  const cheapK = new Int32Array((P + 1) * (size + 1));
  // Mirror of cheapK for the 'rich' sort, which maximises gold instead of
  // minimising it -- there the admissible bound is the *most* the remaining
  // slots could still add.
  const dearK = new Int32Array((P + 1) * (size + 1));
  {
    const costs = poolIdx.map(i => DB.champions[i].cost * 3);
    for (let s = P - 1; s >= 0; s--) {
      const tail = costs.slice(s).sort((a, b) => a - b);
      const desc = tail.slice().reverse();
      let acc = 0, accD = 0;
      for (let k = 1; k <= size; k++) {
        acc += (k <= tail.length ? tail[k - 1] : 0);
        cheapK[s * (size + 1) + k] = acc;
        accD += (k <= desc.length ? desc[k - 1] : 0);
        dearK[s * (size + 1) + k] = accD;
      }
    }
  }

  // Gold already locked in by the required units — constant for the whole run.
  let baseGold = 0;
  for (const u of reqIdx) baseGold += DB.champions[u].cost * 3;

  // Optimistic bounds on what the current partial board could still become.
  // Every one of these must err in the candidate's favour: overestimate the
  // maximised keys (live/tier), underestimate the minimised ones (waste/cost).
  // A bound that is ever too pessimistic silently deletes valid boards.
  function boundLive(start, slotsLeft) {
    const base = start * nT;
    let ub = 0;
    for (let t = 0; t < nT; t++) {
      if (UNIQ[t] || MUTE[t]) continue;         // never scored
      const c = counts[t];
      if (c >= SCORE1[t]) { ub++; continue; }   // already scoring
      const reach = c + (slotsLeft < avail[base + t] ? slotsLeft : avail[base + t]);
      if (reach >= SCORE1[t]) ub++;             // could still score
    }
    return ub;
  }

  function boundTier(start, slotsLeft) {
    const base = start * nT;
    let ub = 0;
    for (let t = 0; t < nT; t++) {
      if (UNIQ[t] || MUTE[t]) continue;
      const c = counts[t];
      const reach = c + (slotsLeft < avail[base + t] ? slotsLeft : avail[base + t]);
      if (reach < SCORE1[t]) continue;
      const ti = tierOf(BPS[t], reach);
      if (ti >= 0) ub += ti + 1;
    }
    return ub;
  }

  function boundGold(start, slotsLeft, depth) {
    let g = baseGold;
    for (let d = 0; d < depth; d++) g += DB.champions[pick[d]].cost * 3;
    return g + cheapK[start * (size + 1) + slotsLeft];
  }

  function boundGoldMax(start, slotsLeft, depth) {
    let g = baseGold;
    for (let d = 0; d < depth; d++) g += DB.champions[pick[d]].cost * 3;
    return g + dearK[start * (size + 1) + slotsLeft];
  }

  // Prune only on the primary sort key. Deeper keys are tie-breakers, and a
  // bound that's optimistic on key 1 says nothing about key 2, so comparing
  // past the first strict decision would not be admissible.
  const primary = order[0];
  function canBeat(start, slotsLeft, depth) {
    if (!worst) return true;                    // buffer not full: keep everything
    if (primary === 'live')  return boundLive(start, slotsLeft) >= worst.live;
    if (primary === 'tier')  return boundTier(start, slotsLeft) >= worst.tierSum;
    if (primary === 'waste') return wasteLB(slotsLeft) <= worst.waste;
    if (primary === 'cost')  return boundGold(start, slotsLeft, depth) <= worst.gold;
    if (primary === 'rich')  return boundGoldMax(start, slotsLeft, depth) >= worst.gold;
    return true;
  }

  const pick = new Int32Array(need);

  function dfs(start, depth) {
    if (truncated) return;
    if (depth === need) {
      // final evaluation
      if (!reqSatisfied()) return;
      let live = 0, uniqN = 0, waste = 0, tierSum = 0;
      const active = [], dead = [], over = [];
      for (let t = 0; t < nT; t++) {
        const c = counts[t];
        if (!c) continue;
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
      let gold = 0;
      for (const u of reqIdx) gold += DB.champions[u].cost * 3;
      for (let d = 0; d < depth; d++) gold += DB.champions[pick[d]].cost * 3;
      // Once we're at capacity, reject candidates that can't beat the worst
      // board we're keeping — avoids allocating millions of doomed results.
      if (worst && cmpScore(live, tierSum, waste, gold, worst) >= 0) return;
      const units = reqIdx.concat(Array.from(pick.subarray(0, depth)));
      // uniques last so the meaningful traits read first
      const dim = x => (UNIQ[x] || MUTE[x] || counts[x] < SCORE1[x]) ? 1 : 0;
      active.sort((a, b) => (dim(a[0]) - dim(b[0])) || b[1] - a[1]);
      results.push({ units, active, dead, over, live, uniqN, waste, tierSum, gold });
      if (results.length >= RESULT_CAP) {
        results.sort(cmp);
        results.length = RESULT_CAP >> 1;   // keep the better half, keep searching
        worst = results[results.length - 1];
        trimmed = true;
      }
      return;
    }
    const slotsLeft = need - depth;
    for (let i = start; i <= pool.length - slotsLeft; i++) {
      if (depth === 0 && shards > 1 && i % shards !== shard) continue;
      if (++nodes > NODE_BUDGET) { truncated = true; return; }
      const ci = pool[i];
      const ts = CTR[ci];
      for (const t of ts) counts[t]++;
      pick[depth] = ci;
      if (wasteLB(slotsLeft - 1) <= maxWaste && !reqUnreachable(i + 1, slotsLeft - 1)
          && canBeat(i + 1, slotsLeft - 1, depth + 1)) dfs(i + 1, depth + 1);
      for (const t of ts) counts[t]--;
      if (truncated) return;
    }
  }

  if (need < 0) return { error: 'More required units than board slots.' };
  if (need === 0 && shard > 0) {
    return { rows: [], total: 0, truncated: false, capped: false, nodes: 0 };
  }
  if (wasteLB(need) <= maxWaste && !reqUnreachable(0, need)) dfs(0, 0);

  results.sort(cmp);
  // Dedup happens at the merge step: a signature can span shards, so a worker
  // can't know whether its board is a duplicate of one another worker found.
  return {
    rows: results.slice(0, o.returnN || limit),
    total: found, truncated, capped: trimmed, nodes,
  };
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init(m.db); postMessage({ type: 'ready' }); return; }
  if (m.type === 'search') {
    const t0 = performance.now();
    let r;
    try { r = search(m.opts); } catch (err) { r = { error: String(err) }; }
    postMessage({ type: 'result', id: m.id, ms: Math.round(performance.now() - t0), ...r });
  }
};
