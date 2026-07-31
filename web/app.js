// app.js — TFT Perfect Traits Explorer
let DB = null, W = null, ready = false;
let reqId = 0, pending = false, dirty = false;

const $ = id => document.getElementById(id);
const state = new Map();          // champ key -> 0 none / 1 required / 2 excluded
const costOn = new Set([1, 2, 3, 4, 5]);
const emblems = [];               // trait keys
const reqTraits = [];             // [{key, n}] — trait floors, e.g. Invoker 4

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
  if (W) { W.terminate(); W = null; }
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
    W = new Worker('worker.js');
    W.onmessage = onWorker;
    W.postMessage({ type: 'init', db });
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
  if (m.type === 'ready') { ready = true; run(); return; }
  if (m.type === 'result') {
    pending = false;
    if (m.id !== reqId) { if (dirty) { dirty = false; run(); } return; }
    render(m);
    if (dirty) { dirty = false; run(); }
  }
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
  for (const c of DB.champions) {
    const d = document.createElement('div');
    d.className = 'u b' + c.cost;
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
  }
  applyFilter();
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  for (const d of $('pool').children) {
    const c = DB.champions.find(x => x.key === d.dataset.key);
    const hide = (!costOn.has(c.cost) && state.get(c.key) !== 1) ||
                 (q && !d.dataset.search.includes(q));
    d.classList.toggle('hide', hide);
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
    // start at the first breakpoint that's actually interesting (>=2 if it exists)
    const start = bp.find(n => n >= 2) ?? bp[0];
    reqTraits.push({ key, n: back ? bp[bp.length - 1] : start });
  } else {
    const i = bp.indexOf(cur.n);
    const next = back ? i - 1 : i + 1;
    if (next < 0 || next >= bp.length) reqTraits.splice(reqTraits.indexOf(cur), 1);
    else cur.n = bp[next];
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
    d.title = `${t.name} — breakpoints ${(t.bp || []).join('/')}\nclick to require · right-click to step down`;
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
    d.classList.toggle('on', !!r);
    d.querySelector('.tgv').textContent = r ? r.n : '';
  }
  $('reqTN').textContent = reqTraits.length;
  filterTraits();
}

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
  $('status').textContent = 'searching…';
  const tkeys = Object.keys(DB.traits);
  W.postMessage({
    type: 'search', id: ++reqId,
    opts: {
      size, maxWaste: +$('waste').value, reqIdx, poolIdx, emblems,
      reqTraits: reqTraits.map(r => ({ t: tkeys.indexOf(r.key), n: r.n }))
                          .filter(r => r.t >= 0),
      sortMode: $('sort').value, limit: 100, uniq: $('uniq').checked,
    }
  });
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
  $('status').textContent = `${m.ms} ms · ${(m.nodes || 0).toLocaleString()} nodes`;
  const shown = m.rows.length < m.total ? `${m.rows.length} shown of ` : '';
  cnt.innerHTML = `${shown}<b>${m.total.toLocaleString()}</b> board${m.total === 1 ? '' : 's'}` +
    (m.truncated ? ` <span class="tag" title="${m.capped ? 'Hit the result cap' : 'Hit the search budget — some boards were not explored'}">partial${m.capped ? '' : ' — narrow the search'}</span>` : '');

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
      const uq = isUnique(t) ? ' uq' : '';
      const ov = overBy[ti] ? ` <i class="ov" title="${overBy[ti]} unit(s) past the ${t.name} breakpoint">+${overBy[ti]}</i>` : '';
      const req = reqTraits.some(r => r.key === key) ? ' pin' : '';
      return `<span class="tb ${cls}${isEmb}${uq}${req}" data-tk="${key}" data-tn="${n}" title="Click to require ${n}+ ${t.name}">${t.icon ? `<img src="${t.icon}">` : ''}<b>${n}</b> ${t.name}${ov}</span>`;
    }).join('');

    const units = r.units.map(i => DB.champions[i])
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(c => `<span class="uc${state.get(c.key) === 1 ? ' req' : ''}"><img loading="lazy" src="${c.icon}">${c.name}</span>`)
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
      (r.waste ? `<span class="w">${r.waste} wasted</span> · ` : '') + `${r.gold}g</div>`;
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
