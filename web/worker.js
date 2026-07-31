// worker.js — combinatorial board search with wasted-trait pruning.
// Runs off the main thread so the UI stays responsive while sliders move.

let DB = null;
let TK = [];        // trait keys, indexed
let BP1 = null;     // Int16Array: first breakpoint per trait
let UNIQ = null;    // Uint8Array: 1 = unique/1-unit trait, excluded from the active count
let MUTE = null;    // Uint8Array: 1 = user muted this trait, excluded from the active count
let BPS = [];       // per-trait breakpoint arrays
let CTR = [];       // per-champion array of trait indices

// A trait is "unique" when it activates off a single unit (Avatar, Caustic,
// Thornmaiden, ...). They're free with the unit, so counting them inflates the
// active-trait score and drowns out genuinely wide boards. Still displayed.
function isUnique(t) {
  if ((t.styles || []).some(s => s.style === 'unique')) return true;
  return (t.bp || []).length === 1 && (t.bp[0] || 1) <= 1;
}

function init(db) {
  DB = db;
  TK = Object.keys(db.traits);
  const ti = new Map(TK.map((k, i) => [k, i]));
  BP1 = new Int16Array(TK.length);
  UNIQ = new Uint8Array(TK.length);
  BPS = TK.map(k => db.traits[k].bp || [1]);
  TK.forEach((k, i) => {
    BP1[i] = db.traits[k].bp[0] || 1;
    UNIQ[i] = isUnique(db.traits[k]) ? 1 : 0;
  });
  CTR = db.champions.map(c => c.traits.map(t => ti.get(t)).filter(x => x !== undefined));
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
  const { size, maxWaste, reqIdx, poolIdx, emblems, sortMode, limit, uniq } = o;
  const reqTraits = o.reqTraits || [];   // [{t: traitIdx, n: minCount}]

  const nT = TK.length;
  // muted traits still show on the board, they just stop earning score
  MUTE = new Uint8Array(nT);
  for (const t of (o.muted || [])) if (t >= 0 && t < nT) MUTE[t] = 1;
  const counts = new Int16Array(nT);
  for (const e of emblems) counts[e]++;              // emblems are free trait points

  // seed required units
  for (const i of reqIdx) for (const t of CTR[i]) counts[t]++;

  const need = size - reqIdx.length;
  const pool = poolIdx;
  const results = [];
  let nodes = 0, truncated = false, capped = false;
  const NODE_BUDGET = 40e6;
  const RESULT_CAP = 60000;

  // lower bound on wasted traits: any trait already started that cannot
  // possibly reach its first breakpoint with `slotsLeft` more units.
  // Lower bound on wasted units. Adding more units can only raise a trait's
  // count, so any overshoot past the highest breakpoint still reachable with
  // `slotsLeft` spare slots is already locked in.
  function wasteLB(slotsLeft) {
    let w = 0;
    for (let t = 0; t < nT; t++) {
      const c = counts[t];
      if (!c) continue;
      const bp = BPS[t];
      const ceiling = c + slotsLeft;
      let best = 0;
      for (let i = 0; i < bp.length; i++) if (bp[i] <= ceiling) best = bp[i];
      if (best <= c) w += c - best;   // can't reach the next tier from here
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
        if (w) { waste += w; if (c >= BP1[t]) over.push([t, w]); else dead.push(t); }
        if (c >= BP1[t]) {
          const ti = tierOf(bp, c);
          active.push([t, c, ti]);
          if (UNIQ[t] || MUTE[t]) uniqN += UNIQ[t] ? 1 : 0;   // shown, but not scored
          else { live++; tierSum += ti + 1; }
        }
      }
      if (waste > maxWaste) return;
      if (results.length >= RESULT_CAP) { capped = true; truncated = true; return; }
      const units = reqIdx.concat(Array.from(pick.subarray(0, depth)));
      let gold = 0; for (const u of units) gold += DB.champions[u].cost;
      // unscored traits (unique or muted) last so the meaningful ones read first
      const dim = x => (UNIQ[x] || MUTE[x]) ? 1 : 0;
      active.sort((a, b) => (dim(a[0]) - dim(b[0])) || b[1] - a[1]);
      results.push({ units, active, dead, over, live, uniqN, waste, tierSum, gold });
      return;
    }
    const slotsLeft = need - depth;
    for (let i = start; i <= pool.length - slotsLeft; i++) {
      if (++nodes > NODE_BUDGET) { truncated = true; return; }
      const ci = pool[i];
      const ts = CTR[ci];
      for (const t of ts) counts[t]++;
      pick[depth] = ci;
      if (wasteLB(slotsLeft - 1) <= maxWaste && !reqUnreachable(i + 1, slotsLeft - 1)) dfs(i + 1, depth + 1);
      for (const t of ts) counts[t]--;
      if (truncated) return;
    }
  }

  if (need < 0) return { error: 'More required units than board slots.' };
  if (wasteLB(need) <= maxWaste && !reqUnreachable(0, need)) dfs(0, 0);

  const cmp = {
    live:  (a, b) => b.live - a.live || a.waste - b.waste || b.tierSum - a.tierSum || a.gold - b.gold,
    tier:  (a, b) => b.tierSum - a.tierSum || b.live - a.live || a.waste - b.waste || a.gold - b.gold,
    waste: (a, b) => a.waste - b.waste || b.live - a.live || b.tierSum - a.tierSum || a.gold - b.gold,
    cost:  (a, b) => a.gold - b.gold || b.live - a.live || a.waste - b.waste,
  }[sortMode];
  results.sort(cmp);

  let out = results;
  if (uniq) {
    const seen = new Set();
    out = [];
    for (const r of results) {
      const sig = r.active.map(x => x[0] + ':' + x[1]).join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(r);
      if (out.length >= limit) break;
    }
  } else {
    out = results.slice(0, limit);
  }

  return { rows: out, total: results.length, truncated, capped, nodes };
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
