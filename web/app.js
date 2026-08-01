// app.js — TFT Perfect Traits Explorer
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
const muted = new Set();          // trait keys that still show but earn no score

const STYLE_ORDER = ['bronze', 'silver', 'gold', 'chromatic', 'prismatic', 'unique'];

// Mirrors worker.js: traits that come free with a single unit.
function isUnique(t) {
  if ((t.styles || []).some(s => s.style === 'unique')) return true;
  return (t.bp || []).length === 1 && (t.bp[0] || 1) <= 1;
}

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
const SET_KEY = 'tftPerfectSet';

function loadSet(file) {
  ready = false;
  W.forEach(w => w.terminate()); W = [];
  state.clear(); emblems.length = 0; reqTraits.length = 0;
  $('status').textContent = 'loading data…';
  $('list').innerHTML = '';
  return fetch(file + '?v=' + Date.now()).then(r => r.json()).then(db => {
    DB = db;
    db.champions.forEach(c => state.set(c.key, 0));
    const build = String(db.gameBuild || '').split('+')[0];
    $('meta').innerHTML = `${db.setName || db.set} · ${build} · ${db.champions.length} units · ` +
      `${Object.keys(db.traits).length} traits` +
      (db.note ? ` <span class="tag" title="${db.note}">PBE</span>` : '');
    $('pool').innerHTML = ''; $('costs').innerHTML = '';
    buildCosts(); buildPool(); buildEmblemSelect(); renderEmblems();
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

$('setSel').value = localStorage.getItem(SET_KEY) || 'data-set18.json';
$('setSel').onchange = () => {
  localStorage.setItem(SET_KEY, $('setSel').value);
  loadSet($('setSel').value);
};
loadSet($('setSel').value);

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
  if ($('uniq').checked) {
    const seen = new Set();
    merged.rows = merged.rows.filter(r => {
      const sig = r.active.map(x => x[0] + ':' + x[1]).join('|');
      return seen.has(sig) ? false : (seen.add(sig), true);
    });
  }
  merged.rows = merged.rows.slice(0, 100);
  render(merged);
  if (dirty) { dirty = false; run(); }
}

// Mirrors the worker's comparator so merged shard results order identically.
function mkCmp() {
  const KEY = {
    live: (a, b) => b.live - a.live,
    tier: (a, b) => b.tierSum - a.tierSum,
    waste: (a, b) => a.waste - b.waste,
    cost: (a, b) => a.gold - b.gold,
  };
  const order = [$('sort').value, $('sort2').value, 'live', 'tier', 'waste', 'cost']
    .filter((k, i, arr) => KEY[k] && arr.indexOf(k) === i);
  return (a, b) => {
    for (const k of order) { const d = KEY[k](a, b); if (d) return d; }
    return 0;
  };
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
}

function buildEmblemSelect() {
  const s = $('embSel');
  s.innerHTML = '<option value="">+ add emblem…</option>';
  Object.values(DB.traits).sort((a, b) => a.name.localeCompare(b.name))
    .forEach(t => s.insertAdjacentHTML('beforeend', `<option value="${t.key}">${t.name}</option>`));
  s.onchange = () => { if (s.value) { emblems.push(s.value); s.value = ''; renderEmblems(); run(); } };
}

function renderEmblems() {
  const el = $('embList'); el.innerHTML = '';
  emblems.forEach((k, i) => {
    const t = DB.traits[k];
    const d = document.createElement('span');
    d.className = 'emb';
    d.innerHTML = (t.icon ? `<img src="${t.icon}">` : '') + t.name + ' ✕';
    d.onclick = () => { emblems.splice(i, 1); renderEmblems(); run(); };
    el.appendChild(d);
  });
  $('embN').textContent = emblems.length;
}

// live-bind every control
['size', 'waste'].forEach(id => {
  $(id).addEventListener('input', () => { $(id + 'V').textContent = $(id).value; run(); });
});
$('sort').addEventListener('change', run);
$('sort2').addEventListener('change', run);
$('uniq').addEventListener('change', run);
$('search').addEventListener('input', applyFilter);
$('clear').onclick = () => {
  for (const k of state.keys()) state.set(k, 0);
  emblems.length = 0; renderEmblems();
  reqTraits.length = 0; renderTraitGrid();
  $('traitSearch').value = '';
  for (const d of $('pool').children) d.classList.remove('req', 'exc');
  $('search').value = ''; applyFilter(); updPickN(); run();
};

// ---------- required traits ----------
// Click cycles through that trait's real breakpoints, then clears.
function cycleTrait(key, back) {
  const bp = DB.traits[key].bp || [1];
  const cur = reqTraits.find(r => r.key === key);
  if (!cur) {
    // right-click on an unrequired trait mutes it instead of stepping down
    if (back) return toggleMute(key);
    muted.delete(key);
    // start at the first breakpoint that's actually interesting (>=2 if it exists)
    const start = bp.find(n => n >= 2) ?? bp[0];
    reqTraits.push({ key, n: start });
  } else {
    const i = bp.indexOf(cur.n);
    const next = back ? i - 1 : i + 1;
    if (next < 0 || next >= bp.length) reqTraits.splice(reqTraits.indexOf(cur), 1);
    else cur.n = bp[next];
  }
  renderTraitGrid(); run();
}

// Muted traits still appear on boards, they just stop counting toward the score.
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
  Object.values(DB.traits).sort((a, b) => a.name.localeCompare(b.name)).forEach(t => {
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
  $('traitSearch').oninput = filterTraits;
  renderTraitGrid();
}

function filterTraits() {
  const q = $('traitSearch').value.trim().toLowerCase();
  for (const d of $('traitGrid').children) {
    const on = reqTraits.some(r => r.key === d.dataset.key);
    d.classList.toggle('hide', !!q && !on && !d.dataset.search.includes(q));
  }
}

function renderTraitGrid() {
  for (const d of $('traitGrid').children) {
    const r = reqTraits.find(x => x.key === d.dataset.key);
    const m = muted.has(d.dataset.key);
    d.classList.toggle('on', !!r);
    d.classList.toggle('muted', m);
    d.querySelector('.tgv').textContent = m ? '—' : (r ? r.n : '');
  }
  $('reqTN').textContent = reqTraits.length + (muted.size ? ` · ${muted.size} muted` : '');
  filterTraits();
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
    ? `<div class="cab"><b>${a.name}</b></div><p class="clead">${cleanText(a.desc)}</p>`
    : `<p class="cnote">No ability text in the PBE data for this unit.</p>`;
  const s = c.stats;
  const stats = s ? `<div class="cstats">
      <div class="cstat"><span>Health</span><b>${s.hp}</b></div>
      <div class="cstat"><span>Damage</span><b>${s.ad}</b></div>
      <div class="cstat"><span>Atk Spd</span><b>${s.as}</b></div>
      <div class="cstat"><span>Armor</span><b>${s.armor}</b></div>
      <div class="cstat"><span>MR</span><b>${s.mr}</b></div>
      <div class="cstat"><span>Range</span><b>${s.range} hex</b></div>
      ${mana}</div>` : mana;
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
    limit: 100, uniq: $('uniq').checked,
    // Shards over-return so the global dedup has spare rows to draw from.
    returnN: $('uniq').checked ? 800 : 100,
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
  const secs = (m.ms / 1000).toFixed(1);
  $('status').innerHTML = m.truncated && !m.capped
    ? `<span class="cut" title="Hit the search limit — some boards were never checked. Narrow the pool, or require a trait.">stopped early</span> · ${secs}s`
    : `searched in ${secs}s`;
  // Branch-and-bound kills whole subtrees before they reach a leaf, so `total`
  // is no longer "boards matching your filters" — it's boards actually scored.
  // The top-100 is still exact; the count is a floor. Label it as one.
  cnt.innerHTML = `best <b>${m.rows.length}</b> of ${m.total.toLocaleString()}+ scored` +
    (m.truncated ? ' <span class="tag">pruned</span>' : '');
  cnt.title = 'Ranking is exact. The search skips branches that provably '
            + "can't beat what it's already holding, so the scored count is a "
            + 'lower bound, not every possible board.';

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

    const badges = r.active.map(([ti, n]) => {
      const key = tkeys[ti], t = DB.traits[key];
      const cls = styleAt(t, n);
      const isEmb = embCount[key] ? ' emb' : '';
      const uq = (isUnique(t) || muted.has(key)) ? ' uq' : '';
      const mu = muted.has(key) ? ' mut' : '';
      const ov = overBy[ti] ? ` <i class="ov" title="${overBy[ti]} unit(s) past the ${t.name} breakpoint">+${overBy[ti]}</i>` : '';
      const req = reqTraits.some(r => r.key === key) ? ' pin' : '';
      return `<span class="tb ${cls}${isEmb}${uq}${mu}${req}" data-tk="${key}" data-tn="${n}">${t.icon ? `<img src="${t.icon}">` : ''}<b>${n}</b> ${t.name}${ov}</span>`;
    }).join('');

    const units = r.units.map(i => DB.champions[i])
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(c => `<span class="uc k${c.cost}${state.get(c.key) === 1 ? ' req' : ''}" data-key="${c.key}"><img loading="lazy" src="${c.icon}"><b class="kc">${c.cost}</b>${c.name}</span>`)
      .join('');

    const notes = [];
    if (r.dead.length) notes.push('Dead: ' + r.dead.map(ti => DB.traits[tkeys[ti]].name).join(', '));
    if ((r.over || []).length) notes.push('Over: ' + r.over.map(([ti, w]) => `${DB.traits[tkeys[ti]].name} +${w}`).join(', '));

    const d = document.createElement('div');
    d.className = 'comp';
    d.innerHTML =
      `<div class="left"><div class="tline">${badges}</div><div class="uline">${units}</div>` +
      (notes.length ? `<div class="wasted">${notes.join(' · ')}</div>` : '') + `</div>` +
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
  const b = e.target.closest('.tb');
  if (!b || !b.dataset.tk) return;
  const key = b.dataset.tk, n = +b.dataset.tn;
  const cur = reqTraits.find(r => r.key === key);
  if (cur && cur.n === n) reqTraits.splice(reqTraits.indexOf(cur), 1);
  else if (cur) cur.n = n;
  else reqTraits.push({ key, n });
  renderTraitGrid(); run();
});
