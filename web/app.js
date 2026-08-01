// app.js — TFT Trait Explorer
let DB = null, W = [], ready = false;
let reqId = 0, pending = false, dirty = false;
let inbox = [];                   // shard results for the in-flight request
// One worker per core, minus one so the UI thread keeps a lane. Capped at 8:
// past that the merge cost outweighs the split on this search size.
const NW = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

const $ = id => document.getElementById(id);
const state = new Map();          // champ key -> 0 none / 1 required / 2 excluded
const costOn = new Set([1, 2, 3, 4, 5]);
const emblems = [];               // trait keys
const reqTraits = [];             // [{key, n}] — trait floors, e.g. Invoker 4
const muted = new Set();          // trait keys that still show but earn no score or waste

const { antiStack, breakpoints, comparator, isUnique, scoreFloor, scoresAt,
  scoringBreakpoints, summary, traitSignature } = SearchUtils;

function filterable(t) { return Number.isFinite(scoreFloor(t)); }

function styleAt(tr, n) {
  let s = null;
  for (const st of (tr.styles || [])) {
    if (n >= st.min && (st.max == null || n <= st.max)) s = st.style;
  }
  if (!s && (tr.styles || []).length) {
    const last = tr.styles[tr.styles.length - 1];
    if (n >= last.min) s = last.style;
  }
  return s || 'bronze';
}

// ---------- boot ----------
function loadData() {
  ready = false;
  W.forEach(w => w.terminate()); W = [];
  pending = false; dirty = false; inbox = []; reqId++;
  state.clear(); emblems.length = 0; reqTraits.length = 0; muted.clear();
  $('status').textContent = 'loading data…';
  $('list').innerHTML = '';
  return fetch('data.json', { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }).then(db => {
    DB = db;
    db.champions.forEach(c => state.set(c.key, 0));
    const build = String(db.gameBuild || '').split('+')[0];
    const nUniq = Object.values(db.traits).filter(t => !filterable(t)).length;
    const nTr = Object.keys(db.traits).length;
    $('meta').innerHTML =
      `${db.champions.length} units · ` +
      `<span title="${nTr - nUniq} you can build around, ` +
      `${nUniq} tied to a specific champion">${nTr} traits</span>` +
      (db.note ? ` <span class="tag" title="Data build ${build} — ${db.note}">PBE</span>` : '');
    $('pool').innerHTML = ''; $('costs').innerHTML = '';
    buildCosts(); buildPool(); buildEmblemGrid();
    buildTraitGrid(); updPickN();
    let up = 0;
    for (let i = 0; i < NW; i++) {
      const w = new Worker('worker.js');
      w.onmessage = e => {
        if (e.data.type === 'ready') { if (++up === NW) { ready = true; run(); } return; }
        onWorker(e);
      };
      w.postMessage({ type: 'init', db });
      W.push(w);
    }
  }).catch(e => { $('status').textContent = 'data load failed: ' + e; });
}

loadData();

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'result') return;
  if (m.id !== reqId) return;            // stale shard from a superseded search
  inbox.push(m);
  if (inbox.length < NW) return;         // still waiting on other shards

  pending = false;
  const parts = inbox; inbox = [];
  const err = parts.find(p => p.error);
  if (err) { render({ error: err.error }); if (dirty) { dirty = false; run(); } return; }

  // Each shard returns its own sorted top slice; merge, re-sort, then dedup
  // globally — a trait signature can appear in more than one shard.
  const merged = {
    rows: [].concat(...parts.map(p => p.rows)).sort(mkCmp()),
    total: parts.reduce((n, p) => n + p.total, 0),
    truncated: parts.some(p => p.truncated),
    capped: parts.some(p => p.capped),
    ms: Math.max(...parts.map(p => p.ms)),
  };
  // Boards with an identical trait signature are the same comp reached with
  // interchangeable units. Collapse them, but KEEP the alternates attached so
  // the row can offer them -- that's the real question ("I don't have Ahri").
  {
    const by = new Map();
    for (const r of merged.rows) {
      const sig = traitSignature(r);
      const hit = by.get(sig);
      if (hit) { if (hit.variants.length < 24) hit.variants.push(r); }
      else { r.variants = []; by.set(sig, r); }
    }
    merged.rows = [...by.values()];
  }
  merged.rows = merged.rows.slice(0, 100);
  render(merged);
  if (dirty) { dirty = false; run(); }
}

// Mirrors the worker's comparator so merged shard results order identically.
function mkCmp() {
  return comparator($('sort').value, $('sort2').value);
}

// ---------- controls ----------
function buildCosts() {
  const el = $('costs');
  for (let c = 1; c <= 5; c++) {
    const b = document.createElement('div');
    b.className = 'cbtn on'; b.textContent = c + '\u00A0★';
    b.onclick = () => {
      costOn.has(c) ? costOn.delete(c) : costOn.add(c);
      b.classList.toggle('on', costOn.has(c));
      applyFilter(); run();
    };
    el.appendChild(b);
  }
}

function buildPool() {
  const el = $('pool');
  el.innerHTML = '';
  // group by cost, cheapest first, alphabetical within a tier
  const byCost = new Map();
  for (const c of DB.champions) {
    if (!byCost.has(c.cost)) byCost.set(c.cost, []);
    byCost.get(c.cost).push(c);
  }
  const costs = [...byCost.keys()].sort((a, b) => a - b);
  for (const cost of costs) {
    const h = document.createElement('div');
    h.className = 'costhdr c' + cost;
    h.dataset.cost = cost;
    h.innerHTML = `<span>${cost} cost</span><i>${byCost.get(cost).length}</i>`;
    el.appendChild(h);
    byCost.get(cost).sort((a, b) => a.name.localeCompare(b.name)).forEach(c => addUnit(el, c));
  }
  applyFilter();
}

function addUnit(el, c) {
    const d = document.createElement('div');
    d.className = 'u b' + c.cost;
    d.dataset.cost = c.cost;
    d.dataset.key = c.key;
    d.dataset.search = (c.name + ' ' + c.traits.map(t => DB.traits[t]?.name || t).join(' ')).toLowerCase();
    d.title = c.name + ' — ' + c.traits.map(t => DB.traits[t]?.name || t).join(', ');
    d.innerHTML = `<img loading="lazy" src="${c.icon}" alt="">
      <span class="cst c${c.cost}">${c.cost}</span><span class="nm">${c.name}</span>`;
    // left click toggles require, right click toggles exclude
    const set = s => {
      state.set(c.key, s);
      d.classList.toggle('req', s === 1);
      d.classList.toggle('exc', s === 2);
      updPickN(); run();
    };
    d.onclick = () => set(state.get(c.key) === 1 ? 0 : 1);
    d.oncontextmenu = e => { e.preventDefault(); set(state.get(c.key) === 2 ? 0 : 2); };
    el.appendChild(d);
    state.set(c.key, state.get(c.key) || 0);
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  const shown = new Map();   // cost -> visible unit count
  for (const d of $('pool').children) {
    if (d.classList.contains('costhdr')) continue;
    const c = DB.champions.find(x => x.key === d.dataset.key);
    const hide = (!costOn.has(c.cost) && state.get(c.key) !== 1) ||
                 (q && !d.dataset.search.includes(q));
    d.classList.toggle('hide', hide);
    if (!hide) shown.set(c.cost, (shown.get(c.cost) || 0) + 1);
  }
  // drop a tier header when nothing under it survived the filter
  for (const d of $('pool').children) {
    if (!d.classList.contains('costhdr')) continue;
    const n = shown.get(+d.dataset.cost) || 0;
    d.classList.toggle('hide', n === 0);
    d.querySelector('i').textContent = n;
  }
}

function updPickN() {
  let r = 0, x = 0;
  for (const v of state.values()) { if (v === 1) r++; else if (v === 2) x++; }
  $('pickN').textContent = `${r} required · ${x} excluded`;
  renderSel();
}

// The pool is 73 tiles deep and your picks scatter across five cost rows, so a
// selection is easy to lose track of. Mirror them into one strip.
function renderSel() {
  const req = [], exc = [];
  for (const c of DB.champions) {
    const v = state.get(c.key);
    if (v === 1) req.push(c); else if (v === 2) exc.push(c);
  }
  const fill = (el, arr, kind) => {
    el.innerHTML = arr
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(c => `<span class="selc k${c.cost}" data-key="${c.key}" data-kind="${kind}" ` +
        `title="${c.name} — click to clear"><img loading="lazy" src="${c.icon}">` +
        `${c.name}<b class="x">\u2715</b></span>`).join('');
  };
  fill($('selReqC'), req, 'req');
  fill($('selExcC'), exc, 'exc');
  $('selReq').hidden = !req.length;
  $('selExc').hidden = !exc.length;
  $('sel').hidden = !req.length && !exc.length;
}

// Clearing from the strip has to drive the pool tile too, or the two views drift.
$('sel').addEventListener('click', e => {
  const c = e.target.closest('.selc');
  if (!c) return;
  state.set(c.dataset.key, 0);
  const tile = [...$('pool').children].find(d => d.dataset.key === c.dataset.key);
  if (tile) tile.classList.remove('req', 'exc');
  applyFilter(); updPickN(); run();
});

// Only traits with real breakpoints can exist as emblems -- a unique trait
// belongs to exactly one champion and has no spatula version in game.
function emblemable() {
  return Object.values(DB.traits).filter(t => filterable(t) && !antiStack(t))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildEmblemGrid() {
  const el = $('embGrid');
  el.innerHTML = '';
  emblemable().forEach(t => {
    const d = document.createElement('div');
    d.className = 'tg';
    d.dataset.key = t.key;
    d.dataset.search = t.name.toLowerCase();
    d.innerHTML = (t.icon ? `<img src="${t.icon}">` : '<span class="noimg"></span>') +
      `<span class="tgn">${t.name}</span><span class="tgv"></span>`;
    d.onclick = () => { emblems.push(t.key); renderEmblems(); run(); };
    d.oncontextmenu = (e) => {
      e.preventDefault();
      const i = emblems.lastIndexOf(t.key);
      if (i >= 0) { emblems.splice(i, 1); renderEmblems(); run(); }
    };
    el.appendChild(d);
  });
  renderEmblems();
}

function renderEmblems() {
  // No chip list -- the grid tile itself carries the count, same as the
  // require-traits panel. Right click a tile to remove one.
  $('embN').textContent = emblems.length;
  // Stacked emblems show as xN on the grid tile so three of a kind is legible.
  const n = {};
  emblems.forEach(k => n[k] = (n[k] || 0) + 1);
  for (const d of $('embGrid').children) {
    const c = n[d.dataset.key] || 0;
    d.classList.toggle('on', c > 0);
    d.querySelector('.tgv').textContent = c ? String(c) : '';
  }
}

// live-bind every control
['size', 'waste'].forEach(id => {
  $(id).addEventListener('input', () => {
    $(id + 'V').textContent = $(id).value;
    run();
  });
});
$('sort').addEventListener('change', run);
$('sort2').addEventListener('change', run);
$('search').addEventListener('input', applyFilter);
$('clear').onclick = () => {
  for (const k of state.keys()) state.set(k, 0);
  emblems.length = 0; renderEmblems();
  reqTraits.length = 0; muted.clear(); renderTraitGrid();
  for (const d of $('pool').children) d.classList.remove('req', 'exc');
  $('search').value = ''; applyFilter(); updPickN(); run();
};

// ---------- required traits ----------
// Click cycles through that trait's real breakpoints, then clears.
function cycleTrait(key, back) {
  const bp = scoringBreakpoints(DB.traits[key]);
  const cur = reqTraits.find(r => r.key === key);
  if (!cur) {
    // right-click on an unrequired trait mutes it instead of stepping down
    if (back) return toggleMute(key);
    muted.delete(key);
    const start = bp[0];
    if (start == null) return;
    reqTraits.push({ key, n: start });
  } else {
    const i = bp.indexOf(cur.n);
    const next = back ? i - 1 : i + 1;
    if (next < 0 || next >= bp.length) reqTraits.splice(reqTraits.indexOf(cur), 1);
    else cur.n = bp[next];
  }
  renderTraitGrid(); run();
}

// Muted traits still appear on boards, but contribute neither score nor waste.
function toggleMute(key) {
  if (muted.has(key)) muted.delete(key);
  else {
    muted.add(key);
    const i = reqTraits.findIndex(r => r.key === key);   // can't require what doesn't count
    if (i >= 0) reqTraits.splice(i, 1);
  }
  renderTraitGrid(); run();
}

function buildTraitGrid() {
  const el = $('traitGrid');
  el.innerHTML = '';
  // Unique traits activate off a single champion, so requiring one is just
  // requiring that unit -- the unit picker already does that better.
  Object.values(DB.traits).filter(filterable)
    .sort((a, b) => a.name.localeCompare(b.name)).forEach(t => {
    const d = document.createElement('div');
    d.className = 'tg';
    d.dataset.key = t.key;
    d.dataset.search = t.name.toLowerCase();
    d.innerHTML = (t.icon ? `<img src="${t.icon}">` : '<span class="noimg"></span>') +
      `<span class="tgn">${t.name}</span><span class="tgv"></span>`;
    d.onclick = () => cycleTrait(t.key, false);
    d.oncontextmenu = (e) => { e.preventDefault(); cycleTrait(t.key, true); };
    el.appendChild(d);
  });
  renderTraitGrid();
}

function renderTraitGrid() {
  for (const d of $('traitGrid').children) {
    const r = reqTraits.find(x => x.key === d.dataset.key);
    const m = muted.has(d.dataset.key);
    d.classList.toggle('on', !!r);
    d.classList.toggle('muted', m);
    // tier colour (bronze/silver/gold/prismatic) so the badge reads like the
    // in-game trait pip instead of a flat green count
    d.classList.remove('s-bronze', 's-silver', 's-gold', 's-chromatic', 's-prismatic', 's-unique');
    if (r && !m) d.classList.add('s-' + styleAt(DB.traits[r.key], r.n));
    d.querySelector('.tgv').textContent = m ? '—' : (r ? r.n : '');
  }
  $('reqTN').textContent = reqTraits.length + (muted.size ? ` · ${muted.size} muted` : '');
}

// ---------- hover cards ----------
// Riot ships desc as templates: "@Var@" numbers, "%i:scaleAD%" icon tokens,
// "(@MinUnits@)" separating each breakpoint's text. PBE hashes most variable
// names, so we render the shape and mark unknown numbers rather than lie.
const ICON_WORD = {
  scaleAD: 'AD', scaleAP: 'AP', scaleAS: 'Attack Speed', scaleArmor: 'Armor',
  scaleMR: 'MR', scaleHealth: 'HP', scaleManaRegen: 'Mana Regen',
  scaleDR: 'Damage Reduction', scaleCrit: 'Crit',
};

function cleanText(s) {
  if (!s) return '';
  return s
    // Riot's string table carries literal backslash-n (and \r\n) escapes, not
    // real newlines — left alone they render as visible "\n" in the card.
    .replace(/\\+[rn]/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')                                  // strip markup
    .replace(/%i:(\w+)%/g, (_, k) => ICON_WORD[k] ? ' ' + ICON_WORD[k] : '')
    .replace(/@[^@]+@/g, '<span class="ph" title="value not in PBE data yet">?</span>')
    .replace(/\s+/g, ' ')
    .replace(/\s+([%.,])/g, '$1')
    .trim();
}

function traitDesc(t) {
  // The build script now renders per-breakpoint text with the real numbers
  // substituted (Riot FNV-1a hashes most variable names, which is why these
  // used to come through as "?"). Fall back to splitting the raw template for
  // traits where the <row> count didn't match the breakpoint count.
  if (t.tiers && t.tiers.length) {
    return { lead: cleanText(t.lead || ''), tiers: t.tiers.map(cleanText) };
  }
  const parts = (t.desc || '').split(/\(@MinUnits@\)/);
  return { lead: cleanText(parts[0]), tiers: parts.slice(1).map(cleanText) };
}

function traitCard(key) {
  const t = DB.traits[key];
  if (!t) return '';
  const { lead, tiers } = traitDesc(t);
  const rows = (t.bp || []).map((n, i) => tiers[i]
    ? `<div class="crow"><span class="cbp ${styleAt(t, n)}">${n}</span><span class="ctx">${tiers[i]}</span></div>`
    : `<div class="crow"><span class="cbp ${styleAt(t, n)}">${n}</span></div>`).join('');
  return `<div class="chd">${t.icon ? `<img src="${t.icon}">` : ''}
      <div><b>${t.name}</b><span class="csub">${(t.bp || []).join(' / ')}</span></div></div>` +
    (lead ? `<p class="clead">${lead}</p>` : '') + rows;
}

function unitCard(key) {
  const c = DB.champions.find(x => x.key === key);
  if (!c) return '';
  const traits = c.traits.map(k => {
    const t = DB.traits[k];
    return `<span class="cch">${t?.icon ? `<img src="${t.icon}">` : ''}${t?.name || k}</span>`;
  }).join('');
  // Mana reads as a cost, not a transition: 0/45 means "needs 45, starts at 0".
  const mana = c.mana
    ? `<div class="cstat"><span>Mana</span><b>${c.mana.start}/${c.mana.max}</b></div>` : '';
  // Ability text is resolved from the game string table; numbers stay templated
  // until 18.1, so cleanText renders those as muted "?" like the trait cards.
  const a = c.ability;
  const ability = a
    ? `<div class="cab"><b>${a.name}</b></div><p class="clead">${cleanText(a.descResolved || a.desc)}</p>`
    : `<p class="cnote">No ability text in the PBE data for this unit.</p>`;
  // Stats come from the raw character bins. Any given unit can be missing a
  // field (Kayle has no baseDamage -- she transforms), so each row is dropped
  // rather than printed as "undefined".
  const s = c.stats || {};
  const row = (label, v) =>
    v == null ? '' : `<div class="cstat"><span>${label}</span><b>${v}</b></div>`;
  const n1 = v => (v == null ? null : Math.round(v * 100) / 100);
  const body =
    row('Health', n1(s.hp)) +
    row('Damage', n1(s.ad)) +
    row('Atk Spd', n1(s.as)) +
    row('Armor', n1(s.armor)) +
    row('MR', n1(s.mr)) +
    // attackRange is in game units; ~180 per hex. Show hexes, keep the raw
    // number on hover for anyone who wants it.
    (s.hexRange == null ? '' :
      `<div class="cstat"><span>Range</span><b title="${s.range} units">` +
      `${s.hexRange} hex</b></div>`) +
    mana;
  const stats = body ? `<div class="cstats">${body}</div>` : '';
  return `<div class="chd">${c.icon ? `<img class="sq" src="${c.icon}">` : ''}
      <div><b>${c.name}</b><span class="csub k${c.cost}">${c.cost} cost</span></div></div>
    <div class="cchs">${traits}</div>${stats}${ability}`;
}

let cardEl = null;
function hideCard() { if (cardEl) cardEl.classList.remove('show'); }

function showCard(html, ev) {
  if (!cardEl) { cardEl = document.createElement('div'); cardEl.id = 'card'; document.body.appendChild(cardEl); }
  cardEl.innerHTML = html;
  cardEl.classList.add('show');
  const r = cardEl.getBoundingClientRect();
  const pad = 12;
  let x = ev.clientX + 16, y = ev.clientY + 16;
  if (x + r.width > innerWidth - pad) x = ev.clientX - r.width - 16;
  if (y + r.height > innerHeight - pad) y = innerHeight - r.height - pad;
  cardEl.style.left = Math.max(pad, x) + 'px';
  cardEl.style.top = Math.max(pad, y) + 'px';
}

document.addEventListener('mouseover', e => {
  // "?" header affordance: same card, plain text, newlines become breaks
  const q = e.target.closest('.q[data-tip]');
  if (q) return showCard(q.dataset.tip.split('\n')
    .map(l => `<div class="qline">${l}</div>`).join(''), e);
  const tEl = e.target.closest('.tg[data-key], .tb[data-tk]');
  if (tEl) return showCard(traitCard(tEl.dataset.key || tEl.dataset.tk), e);
  const uEl = e.target.closest('.u[data-key], .uc[data-key]');
  if (uEl) return showCard(unitCard(uEl.dataset.key), e);
  hideCard();
});
document.addEventListener('mouseleave', hideCard);
document.addEventListener('scroll', hideCard, true);

// ---------- search dispatch (coalesced) ----------
function run() {
  if (!ready) return;
  if (pending) { dirty = true; return; }
  const size = +$('size').value;
  const reqIdx = [], poolIdx = [];
  DB.champions.forEach((c, i) => {
    const s = state.get(c.key);
    if (s === 1) reqIdx.push(i);
    else if (s === 2) return;
    else if (costOn.has(c.cost)) poolIdx.push(i);
  });
  if (reqIdx.length > size) {
    render({ error: `${reqIdx.length} required units won't fit on a board of ${size}.` });
    return;
  }
  pending = true;
  inbox = [];
  $('status').textContent = 'searching…';
  const tkeys = Object.keys(DB.traits);
  const id = ++reqId;
  const opts = {
    size, maxWaste: +$('waste').value, reqIdx, poolIdx, emblems,
    reqTraits: reqTraits.map(r => ({ t: tkeys.indexOf(r.key), n: r.n }))
                        .filter(r => r.t >= 0),
    muted: [...muted].map(k => tkeys.indexOf(k)).filter(t => t >= 0),
    sortMode: $('sort').value, sortMode2: $('sort2').value,
    limit: 100, uniq: true,
    // Shards over-return so the global dedup has spare rows to draw from,
    // and so collapsed rows have real alternates to offer.
    returnN: 800,
    shards: W.length,
  };
  W.forEach((w, i) => w.postMessage({ type: 'search', id, opts: { ...opts, shard: i } }));
}

// ---------- render ----------
function render(m) {
  const list = $('list'), cnt = $('count');
  if (m.error) {
    $('status').textContent = '';
    cnt.textContent = '—';
    list.innerHTML = `<div class="empty">${m.error}</div>`;
    return;
  }
  const searchSummary = summary(m);
  $('status').innerHTML = searchSummary.statusHtml;
  cnt.innerHTML = searchSummary.countHtml;
  cnt.title = searchSummary.title;

  if (!m.rows.length) {
    list.innerHTML = `<div class="empty">No boards match.<br>Raise the wasted-traits slider, widen the cost filter, or drop a required unit.</div>`;
    return;
  }

  const embCount = {};
  emblems.forEach(k => embCount[k] = (embCount[k] || 0) + 1);
  const tkeys = Object.keys(DB.traits);
  const frag = document.createDocumentFragment();

  for (const r of m.rows) {
    const overBy = {};
    (r.over || []).forEach(([ti, w]) => overBy[ti] = w);

    // Dead traits used to be a "Dead: X, Y" sentence under the board. Render
    // them as grey badges inline instead, and show n/next so the gap is
    // legible at a glance ("3/4 Riftbeast" = one unit short).
    const deadBadges = (r.dead || []).map(([ti, n]) => {
      const key = tkeys[ti], t = DB.traits[key];
      const bp = breakpoints(t);
      const nxt = bp.find(x => x > n) || bp[bp.length - 1];
      return `<span class="tb dead" data-tk="${key}" data-tn="${n}" ` +
        `title="${t.name} ${n}/${nxt} — ${nxt - n} more to activate">` +
        `${t.icon ? `<img src="${t.icon}">` : ''}<b>${n}<i>/${nxt}</i></b> ${t.name}</span>`;
    }).join('');

    const badges = r.active.map(([ti, n]) => {
      const key = tkeys[ti], t = DB.traits[key];
      const cls = styleAt(t, n);
      const isEmb = embCount[key] ? ' emb' : '';
      const unique = isUnique(t);
      const canScore = scoresAt(t, n);
      const uq = unique ? ' uq' : '';
      const ns = !unique && !canScore ? ' ns' : '';
      const mu = muted.has(key) ? ' mut' : '';
      const ov = overBy[ti] ? ` <i class="ov" title="${overBy[ti]} unit(s) past the ${t.name} breakpoint">+${overBy[ti]}</i>` : '';
      const req = reqTraits.some(r => r.key === key) ? ' pin' : '';
      const nop = filterable(t) && canScore ? '' : ' nopin';
      return `<span class="tb ${cls}${isEmb}${uq}${ns}${mu}${req}${nop}" data-tk="${key}" data-tn="${n}">${t.icon ? `<img src="${t.icon}">` : ''}<b>${n}</b> ${t.name}${ov}</span>`;
    }).join('');

    const units = r.units.map(i => DB.champions[i])
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(c => `<span class="uc k${c.cost}${state.get(c.key) === 1 ? ' req' : ''}" data-key="${c.key}"><img loading="lazy" src="${c.icon}"><b class="kc">${c.cost}</b>${c.name}</span>`)
      .join('');


    // Same trait signature, different roster. Offered per-board instead of as a
    // global toggle, because the question is "swap THIS board", not "show me
    // every permutation of everything".
    const nv = (r.variants || []).length;
    const varTag = nv ? `<span class="vtag" title="Same traits, same counts — different units. Click to show.">${nv} variant${nv > 1 ? 's' : ''}</span>` : '';
    const varRows = nv ? `<div class="vlist">` + r.variants.map(v =>
      `<div class="vrow">` + v.units.map(i => DB.champions[i])
        .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
        .map(c => `<span class="uc k${c.cost}${state.get(c.key) === 1 ? ' req' : ''}" data-key="${c.key}"><img loading="lazy" src="${c.icon}"><b class="kc">${c.cost}</b>${c.name}</span>`)
        .join('') +
      `<span class="vg" title="Assumes every unit at 2★ (3 copies)">${v.gold}g</span></div>`).join('') + `</div>` : '';

    const d = document.createElement('div');
    d.className = 'comp';
    d.innerHTML =
      `<div class="left"><div class="tline">${badges}${deadBadges}</div><div class="uline">${units}${varTag}</div>` +
      varRows + `</div>` +
      `<div class="score"><b>${r.live}</b>traits active<br>` +
      (r.uniqN ? `<span class="u">+${r.uniqN} unique</span> · ` : '') +
      (r.waste ? `<span class="w">${r.waste} wasted</span> · ` : '') +
      `<span title="Assumes every unit at 2★ (3 copies)">${r.gold}g</span></div>`;
    frag.appendChild(d);
  }
  list.innerHTML = '';
  list.appendChild(frag);
}

// Click any trait badge in the results to pin it as a requirement at that count.
$('list').addEventListener('click', (e) => {
  const vt = e.target.closest('.vtag');
  if (vt) { vt.closest('.comp').classList.toggle('vopen'); return; }
  const b = e.target.closest('.tb');
  if (!b || !b.dataset.tk) return;
  const key = b.dataset.tk, n = +b.dataset.tn;
  // Pinning a trait that has no grid tile strands the requirement: the count
  // goes up, nothing lights up, and there's no way to clear it. This is how
  // Rival produced an invisible "1 required" and an empty result set.
  if (b.classList.contains('dead') || !filterable(DB.traits[key]) || !scoresAt(DB.traits[key], n)) return;
  const cur = reqTraits.find(r => r.key === key);
  if (cur && cur.n === n) reqTraits.splice(reqTraits.indexOf(cur), 1);
  else if (cur) cur.n = n;
  else reqTraits.push({ key, n });
  renderTraitGrid(); run();
});

// Sticky sidebar offset must equal the real header height, or the panel slides
// a few px under it before locking. Measured, not hardcoded.
function syncHeaderVar() {
  const h = document.querySelector('header');
  if (h) document.documentElement.style.setProperty('--hdr', Math.round(h.getBoundingClientRect().height) + 'px');
}
syncHeaderVar();
addEventListener('resize', syncHeaderVar);
if (window.ResizeObserver) new ResizeObserver(syncHeaderVar).observe(document.querySelector('header'));
