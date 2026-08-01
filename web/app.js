// app.js — TFT Trait Explorer
let DB = null, W = [], dataReady = false, workersReady = false;
let reqId = 0, pending = false, workerEpoch = 0, searchGeneration = 0;
let inbox = [];                   // shard results for the in-flight request
let debounceTimer = null, queuedDispatch = null, activeSearch = null;
// One worker per core, minus one so the UI thread keeps a lane. Capped at 8:
// past that the merge cost outweighs the split on this search size.
const NW = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const DEBOUNCE_MS = 200;
const SEARCH_ALGORITHM_VERSION = 'weighted-v2';
const MEMORY_CACHE_LIMIT = 24;
const DEVICE_CACHE_LIMIT = 50;
const DEVICE_CACHE_DB = 'tft-trait-search-cache';
const DEVICE_CACHE_STORE = 'results';
const METRICS_KEY = 'tft-search-metrics-v1';

const $ = id => document.getElementById(id);
const state = new Map();          // champ key -> 0 none / 1 required / 2 excluded
const costOn = new Set([1, 2, 3, 4, 5]);
const emblems = [];               // trait keys
const reqTraits = [];             // [{key, n}] — trait floors, e.g. Invoker 4
const muted = new Set();          // trait keys that still show but earn no score or waste

const { antiStack, breakpoints, comparator, isUnique, scoreFloor, scoresAt,
  scoringBreakpoints, searchCacheKey, summary, traitSignature } = SearchUtils;

const memoryCache = new Map();
let cacheDbPromise = null, metricsStorageWarned = false;

function loadMetrics() {
  const empty = {
    requests: 0, memoryHits: 0, deviceHits: 0, workerRuns: 0,
    cancellations: 0, truncated: 0, workerMs: 0, cacheErrors: 0,
  };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(METRICS_KEY) || '{}') };
  } catch (error) {
    console.warn('Could not load local search metrics.', error);
    return empty;
  }
}

const searchMetrics = loadMetrics();
window.TFTSearchMetrics = searchMetrics;

function recordMetric(name, amount = 1) {
  searchMetrics[name] = (searchMetrics[name] || 0) + amount;
  try {
    localStorage.setItem(METRICS_KEY, JSON.stringify(searchMetrics));
  } catch (error) {
    if (!metricsStorageWarned) {
      metricsStorageWarned = true;
      console.warn('Could not persist local search metrics.', error);
    }
  }
}

function cacheFailure(action, error) {
  recordMetric('cacheErrors');
  console.warn(`Search cache ${action} failed.`, error);
}

function memoryCacheGet(key) {
  const result = memoryCache.get(key);
  if (!result) return null;
  memoryCache.delete(key);
  memoryCache.set(key, result);
  return result;
}

function memoryCacheSet(key, result) {
  const value = { ...result };
  delete value.cached;
  memoryCache.delete(key);
  memoryCache.set(key, value);
  while (memoryCache.size > MEMORY_CACHE_LIMIT) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function openCacheDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (cacheDbPromise) return cacheDbPromise;
  cacheDbPromise = new Promise(resolve => {
    const request = indexedDB.open(DEVICE_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(DEVICE_CACHE_STORE, { keyPath: 'key' });
      store.createIndex('storedAt', 'storedAt');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      cacheFailure('open', request.error);
      resolve(null);
    };
    request.onblocked = () => {
      cacheFailure('upgrade', new Error('IndexedDB upgrade was blocked.'));
      resolve(null);
    };
  });
  return cacheDbPromise;
}

async function deviceCacheGet(key) {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(DEVICE_CACHE_STORE, 'readonly');
    const request = tx.objectStore(DEVICE_CACHE_STORE).get(key);
    request.onsuccess = () => resolve(request.result?.result || null);
    request.onerror = () => {
      cacheFailure('read', request.error);
      resolve(null);
    };
  });
}

async function pruneDeviceCache(db) {
  return new Promise(resolve => {
    const tx = db.transaction(DEVICE_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(DEVICE_CACHE_STORE);
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - DEVICE_CACHE_LIMIT;
      if (excess <= 0) return;
      const cursor = store.index('storedAt').openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result || excess-- <= 0) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    };
    tx.oncomplete = resolve;
    tx.onerror = () => {
      cacheFailure('prune', tx.error);
      resolve();
    };
  });
}

async function deviceCacheSet(key, result) {
  if (result.truncated) return;
  const db = await openCacheDb();
  if (!db) return;
  const value = { ...result };
  delete value.cached;
  await new Promise(resolve => {
    const tx = db.transaction(DEVICE_CACHE_STORE, 'readwrite');
    tx.objectStore(DEVICE_CACHE_STORE).put({
      key, result: value, storedAt: Date.now(),
    });
    tx.oncomplete = resolve;
    tx.onerror = () => {
      cacheFailure('write', tx.error);
      resolve();
    };
  });
  await pruneDeviceCache(db);
}

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
function stopWorkers(cancellation = false) {
  if (cancellation && pending) recordMetric('cancellations');
  workerEpoch++;
  W.forEach(worker => worker.terminate());
  W = [];
  workersReady = false;
  queuedDispatch = null;
  pending = false;
  inbox = [];
  activeSearch = null;
  reqId++;
}

function ensureWorkers(callback) {
  queuedDispatch = callback;
  if (workersReady) {
    queuedDispatch = null;
    callback();
    return;
  }
  if (W.length) return;

  const epoch = ++workerEpoch;
  let started = 0;
  for (let i = 0; i < NW; i++) {
    const worker = new Worker('worker.js');
    worker.onmessage = event => {
      if (epoch !== workerEpoch) return;
      if (event.data.type === 'ready') {
        if (++started === NW) {
          workersReady = true;
          const dispatch = queuedDispatch;
          queuedDispatch = null;
          if (dispatch) dispatch();
        }
        return;
      }
      onWorker(event);
    };
    worker.onerror = event => {
      if (epoch !== workerEpoch) return;
      console.error('Search worker failed.', event.error || event.message);
      stopWorkers(false);
      render({ error: 'Search worker failed. Reload the page and try again.' });
    };
    worker.postMessage({ type: 'init', db: DB });
    W.push(worker);
  }
}

function loadData() {
  dataReady = false;
  clearTimeout(debounceTimer);
  searchGeneration++;
  stopWorkers(false);
  memoryCache.clear();
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
    dataReady = true;
    run(true);
  }).catch(e => { $('status').textContent = 'data load failed: ' + e; });
}

loadData();

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'result') return;
  if (m.id !== reqId) return;            // stale shard from a superseded search
  inbox.push(m);
  if (inbox.length < W.length) return;   // still waiting on other shards

  pending = false;
  const parts = inbox; inbox = [];
  const err = parts.find(p => p.error);
  if (err) {
    activeSearch = null;
    render({ error: err.error });
    return;
  }

  // Each shard returns its own sorted top slice; merge, re-sort, then dedup
  // globally — a trait signature can appear in more than one shard.
  const search = activeSearch;
  if (!search) return;
  const merged = {
    rows: [].concat(...parts.map(p => p.rows))
      .sort(comparator(search.opts.sortMode, search.opts.sortMode2)),
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
  activeSearch = null;
  recordMetric('workerMs', merged.ms);
  if (merged.truncated) recordMetric('truncated');
  memoryCacheSet(search.key, merged);
  void deviceCacheSet(search.key, merged);
  render(merged);
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
const STAT_ICON_BASE =
  'https://raw.communitydragon.org/pbe/plugins/rcp-be-lol-game-data/global/default/' +
  'assets/ux/fonts/texticons/lol/statsicon';
const THREE_STAR_ICON =
  'https://raw.communitydragon.org/pbe/plugins/rcp-be-lol-game-data/global/default/' +
  'assets/ux/fonts/texticons/tft/staricon_3_enabled.png';
const STAT_ICONS = {
  scaleAD: ['AD', 'Attack Damage'],
  scaleAP: ['AP', 'Ability Power'],
  scaleAS: ['Attack Speed', 'Attack Speed'],
  scaleArmor: ['Armor', 'Armor'],
  scaleMR: ['MR', 'Magic Resist'],
  scaleHealth: ['HP', 'Health'],
  scaleManaRegen: ['Mana Regen', 'Mana Regeneration'],
  scaleDR: ['Damage Reduction', 'Damage Reduction'],
  scaleCrit: ['Crit', 'Critical Strike Chance'],
  scaleDA: ['Damage Amp', 'Damage Amplification'],
};

function statIcon(token) {
  const stat = STAT_ICONS[token];
  if (!stat) return '';
  const [label, title] = stat;
  return `<img class="si" src="${STAT_ICON_BASE}/${token.toLowerCase()}.png" ` +
    `alt="${label}" title="${title}">`;
}

const ROLE_ICON_BASE =
  'https://raw.communitydragon.org/pbe/plugins/rcp-be-lol-game-data/global/default/' +
  'assets/ux/fonts/texticons/tft/characterroles';
const ROLE_DAMAGE = {
  AD: ['Attack', 'attack'],
  AP: ['Magic', 'magic'],
  Hybrid: ['Hybrid', 'hybrid'],
};

function roleBadge(role) {
  const match = /^(AD|AP|Hybrid)(Carry|Caster|Fighter|Reaper|Specialist|Tank)$/.exec(role || '');
  if (!match) return '';
  const [, damage, unitType] = match;
  const [damageName, assetName] = ROLE_DAMAGE[damage];
  const label = `${damageName} ${unitType}`;
  const icon = `${ROLE_ICON_BASE}/tft_${assetName}_${unitType.toLowerCase()}.png`;
  return `<div class="crole" title="Unit role: ${label}">` +
    `<img src="${icon}" alt=""><span>${label}</span></div>`;
}

function abilityLine(line) {
  return cleanText(line).replace(
    /^([A-Z][A-Za-z ]{0,24}:)(?=\s|$)/,
    '<b class="alabel">$1</b>');
}

function abilityText(text) {
  return String(text || '').split(/\n{2,}/)
    .map(paragraph => paragraph.split(/\n/).filter(Boolean).map(abilityLine).join('<br>'))
    .filter(Boolean)
    .map(paragraph => `<p class="apara">${paragraph}</p>`)
    .join('');
}

function cleanText(s) {
  if (!s) return '';
  return s
    // Riot's string table carries literal backslash-n (and \r\n) escapes, not
    // real newlines — left alone they render as visible "\n" in the card.
    .replace(/\\+[rn]/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')                                  // strip markup
    .replace(/%i:(\w+)%/g, (_, token) => statIcon(token))
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

function traitUnitStrip(key) {
  const units = DB.champions.filter(champion => champion.traits.includes(key))
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
    .map(champion => `<span class="tunit k${champion.cost}" title="${champion.name}">` +
      `<img src="${champion.icon}" alt="${champion.name}"></span>`)
    .join('');
  return units ? `<div class="tunits">${units}</div>` : '';
}

function traitCard(key) {
  const t = DB.traits[key];
  if (!t) return '';
  const { lead, tiers } = traitDesc(t);
  const upgrades = (t.upgrades || []).map(upgrade =>
    `<div class="tupgrade"><span class="tucount">${upgrade.count}` +
      `<img class="tstar" src="${THREE_STAR_ICON}" alt="3-star"></span>` +
      `<span>${cleanText(upgrade.desc)}</span></div>`).join('');
  const upgradeList = upgrades ? `<div class="tupgrades">${upgrades}</div>` : '';
  const details = (t.details || []).map(detail =>
    `<div class="tdetail">${abilityLine(detail)}</div>`).join('');
  const detailList = details ? `<div class="tdetails">${details}</div>` : '';
  const rows = (t.bp || []).map((n, i) => {
    const content = (tiers[i] || '') + (i === 0 ? upgradeList : '');
    return content
      ? `<div class="crow"><span class="cbp ${styleAt(t, n)}">${n}</span><span class="ctx">${content}</span></div>`
      : `<div class="crow"><span class="cbp ${styleAt(t, n)}">${n}</span></div>`;
  }).join('');
  return `<div class="chd">${t.icon ? `<img src="${t.icon}">` : ''}
      <div><b>${t.name}</b><span class="csub">${(t.bp || []).join(' / ')}</span></div></div>` +
    (lead ? `<p class="clead">${lead}</p>` : '') + detailList + rows + traitUnitStrip(key);
}

function abilityDescription(ability) {
  if (!(ability.sections || []).length) {
    return abilityText(ability.descResolved || ability.desc);
  }
  const sections = ability.sections.map(section => {
    if (!section.mode) return `<div class="ashared">${abilityText(section.desc)}</div>`;
    const mode = section.mode.toUpperCase();
    const icon = statIcon(mode === 'AD' ? 'scaleAD' : 'scaleAP');
    return `<div class="amode ${mode.toLowerCase()}">` +
      `<span class="amodekey"><b>Adaptor</b>` +
      `<span class="amodestat">${icon}<b>${mode}</b></span></span>` +
      `<div class="amodetext">${abilityText(section.desc)}</div></div>`;
  }).join('');
  return `<div class="asections">${sections}</div>`;
}

function unitCard(key) {
  const c = DB.champions.find(x => x.key === key);
  if (!c) return '';
  const traits = c.traits.map(k => {
    const t = DB.traits[k];
    return `<span class="cch">${t?.icon ? `<img src="${t.icon}">` : ''}${t?.name || k}</span>`;
  }).join('');
  const role = roleBadge(c.role);
  // Mana reads as a cost, not a transition: 0/45 means "needs 45, starts at 0".
  const mana = c.mana
    ? `<div class="cstat"><span>Mana</span><b>${c.mana.start}/${c.mana.max}</b></div>` : '';
  const a = c.ability;
  const ability = a
    ? `<div class="cab"><b>${a.name}</b></div>${abilityDescription(a)}`
    : `<p class="cnote">No ability text in the PBE data for this unit.</p>`;
  // Stats come from the raw character bins. Any given unit can be missing a
  // field (Kayle has no baseDamage -- she transforms), so each row is dropped
  // rather than printed as "undefined".
  const s = c.stats || {};
  const row = (label, v) =>
    v == null ? '' : `<div class="cstat"><span>${label}</span><b>${v}</b></div>`;
  const n1 = v => (v == null ? null : Math.round(v * 100) / 100);
  const starValues = (values, fallback) => Array.isArray(values)
    ? `<span class="stars" title="1-star / 2-star / 3-star">` +
      values.map(n1).join('<i>/</i>') + `</span>`
    : n1(fallback);
  const body =
    row('Team Slots', c.slots > 1 ? c.slots : null) +
    row('Health', starValues(s.hpStars, s.hp)) +
    row('Damage', starValues(s.adStars, s.ad)) +
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
    <div class="cchs">${traits}</div>${role}${stats}${ability}`;
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

// ---------- search dispatch ----------
function buildSearchOptions() {
  const size = +$('size').value;
  const reqIdx = [], poolIdx = [];
  DB.champions.forEach((c, i) => {
    const s = state.get(c.key);
    if (s === 1) reqIdx.push(i);
    else if (s === 2) return;
    else if (costOn.has(c.cost)) poolIdx.push(i);
  });
  const tkeys = Object.keys(DB.traits);
  return {
    size, maxWaste: +$('waste').value, reqIdx, poolIdx, emblems: [...emblems],
    reqTraits: reqTraits.map(r => ({ t: tkeys.indexOf(r.key), n: r.n }))
                        .filter(r => r.t >= 0),
    muted: [...muted].map(k => tkeys.indexOf(k)).filter(t => t >= 0),
    sortMode: $('sort').value, sortMode2: $('sort2').value,
    limit: 100, uniq: true,
    // Shards over-return so the global dedup has spare rows to draw from,
    // and so collapsed rows have real alternates to offer.
    returnN: 800,
    shards: NW,
  };
}

function dispatchSearch(generation, opts, key) {
  if (generation !== searchGeneration || !workersReady) return;
  pending = true;
  inbox = [];
  $('status').textContent = 'searching…';
  const id = ++reqId;
  activeSearch = { generation, key, opts };
  recordMetric('workerRuns');
  W.forEach((worker, shard) =>
    worker.postMessage({ type: 'search', id, opts: { ...opts, shard } }));
}

async function executeSearch(generation) {
  if (!dataReady || generation !== searchGeneration) return;
  recordMetric('requests');
  const opts = buildSearchOptions();
  const version = `${SEARCH_ALGORITHM_VERSION}:${DB.builtAt || DB.gameBuild || DB.set}`;
  const key = searchCacheKey(version, opts);

  const memoryResult = memoryCacheGet(key);
  if (memoryResult) {
    recordMetric('memoryHits');
    render({ ...memoryResult, cached: 'memory' });
    return;
  }

  const deviceResult = await deviceCacheGet(key);
  if (generation !== searchGeneration) return;
  if (deviceResult) {
    recordMetric('deviceHits');
    memoryCacheSet(key, deviceResult);
    render({ ...deviceResult, cached: 'device' });
    return;
  }

  ensureWorkers(() => dispatchSearch(generation, opts, key));
}

function run(immediate = false) {
  if (!dataReady) return;
  const generation = ++searchGeneration;
  clearTimeout(debounceTimer);
  if (pending) {
    stopWorkers(true);
    $('status').textContent = 'updating…';
  }
  if (immediate) {
    void executeSearch(generation);
  } else {
    debounceTimer = setTimeout(() => {
      void executeSearch(generation);
    }, DEBOUNCE_MS);
  }
}

// ---------- render ----------
const COPY_CODE_ICON = `<svg class="copyicon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
  <g class="copyglyph"><path d="M7 6V4.8C7 3.8 7.8 3 8.8 3h6.4c1 0 1.8.8 1.8 1.8v6.4c0 1-.8 1.8-1.8 1.8H14"/><rect x="3" y="7" width="10" height="10" rx="2"/></g>
  <path class="checkglyph" d="m4.8 10.4 3.1 3.1 7.3-7.3"/>
</svg>`;

function copyCodeButton(units) {
  return `<button type="button" class="copycode" data-units="${units.join(',')}" ` +
    `data-tip="Copy TFT Team Planner code" aria-label="Copy TFT Team Planner code">${COPY_CODE_ICON}</button>`;
}

function portraitRoleBadge(champion) {
  const role = champion.role || '';
  let kind, label, icons;
  if (role.endsWith('Tank')) {
    kind = 'tank';
    label = 'Tank';
    icons = statIcon('scaleArmor');
  } else if (champion.traits.includes('Adaptor') || role.startsWith('Hybrid')) {
    kind = 'dual';
    label = champion.traits.includes('Adaptor') ? 'Adaptor: AD or AP' : 'Hybrid: AD and AP';
    icons = statIcon('scaleAD') + statIcon('scaleAP');
  } else if (role.startsWith('AD')) {
    kind = 'ad';
    label = 'AD';
    icons = statIcon('scaleAD');
  } else if (role.startsWith('AP')) {
    kind = 'ap';
    label = 'AP';
    icons = statIcon('scaleAP');
  } else {
    return '';
  }
  return `<span class="rtype ${kind}" title="${label}">${icons}</span>`;
}

function unitPortrait(c) {
  const req = state.get(c.key) === 1 ? ' req' : '';
  return `<span class="uc k${c.cost}${req}" data-key="${c.key}" title="${c.name}">` +
    `<img loading="lazy" src="${c.icon}" alt="${c.name}">${portraitRoleBadge(c)}` +
    `<span class="un">${c.name}</span></span>`;
}

function teamProfile(units, compact = false) {
  const counts = { tanks: 0, AD: 0, AP: 0, Hybrid: 0 };
  for (const index of units) {
    const champion = DB.champions[index];
    const role = champion.role || '';
    if (role.endsWith('Tank')) counts.tanks++;
    else if (champion.traits.includes('Adaptor') || role.startsWith('Hybrid')) counts.Hybrid++;
    else if (role.startsWith('AD')) counts.AD++;
    else if (role.startsWith('AP')) counts.AP++;
  }
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [
    `<span class="profilepart tank" title="${plural(counts.tanks, 'tank')}">` +
      `${statIcon('scaleArmor')}<b>${counts.tanks}</b> Tank</span>`,
  ];
  if (counts.AD) {
    parts.push(`<span class="profilepart ad" title="${plural(counts.AD, 'AD unit')}">` +
      `${statIcon('scaleAD')}<b>${counts.AD}</b> AD</span>`);
  }
  if (counts.AP) {
    parts.push(`<span class="profilepart ap" title="${plural(counts.AP, 'AP unit')}">` +
      `${statIcon('scaleAP')}<b>${counts.AP}</b> AP</span>`);
  }
  if (counts.Hybrid) {
    parts.push(`<span class="profilepart hybrid" title="${plural(counts.Hybrid, 'hybrid unit')}">` +
      `${statIcon('scaleAD')}${statIcon('scaleAP')}<b>${counts.Hybrid}</b> Hybrid</span>`);
  }
  return `<div class="teamprofile${compact ? ' compact' : ''}">${parts.join('')}</div>`;
}

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
      const ov = overBy[ti] ? ` <i class="ov" title="${overBy[ti]} trait point(s) past the ${t.name} breakpoint">+${overBy[ti]}</i>` : '';
      const req = reqTraits.some(r => r.key === key) ? ' pin' : '';
      const nop = filterable(t) && canScore ? '' : ' nopin';
      return `<span class="tb ${cls}${isEmb}${uq}${ns}${mu}${req}${nop}" data-tk="${key}" data-tn="${n}">${t.icon ? `<img src="${t.icon}">` : ''}<b>${n}</b> ${t.name}${ov}</span>`;
    }).join('');

    const units = r.units.map(i => DB.champions[i])
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .map(unitPortrait)
      .join('');
    const profile = teamProfile(r.units);
    const occupiedSlots = r.slots ?? r.units.length;
    const slotTag = occupiedSlots !== +$('size').value || occupiedSlots !== r.units.length
      ? `<span title="Occupied team slots">${occupiedSlots} slots</span> · `
      : '';


    // Same trait signature, different roster. Offered per-board instead of as a
    // global toggle, because the question is "swap THIS board", not "show me
    // every permutation of everything".
    const nv = (r.variants || []).length;
    const varTag = nv
      ? `<button type="button" class="vtag" aria-expanded="false" data-count="${nv}" ` +
        `aria-label="Show ${nv} alternate composition${nv > 1 ? 's' : ''}" ` +
        `title="Same traits and counts, different units">${nv} alternate${nv > 1 ? 's' : ''}` +
        `<i class="vchev" aria-hidden="true"></i></button>`
      : '';
    const varRows = nv ? `<div class="vlist">` + r.variants.map(v =>
      `<div class="vrow">` + v.units.map(i => DB.champions[i])
        .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
        .map(unitPortrait)
        .join('') +
      teamProfile(v.units, true) +
      `<span class="vg" title="Assumes every unit at 2★ (3 copies)">${v.gold}g</span>` +
      copyCodeButton(v.units) + `</div>`).join('') + `</div>` : '';

    const d = document.createElement('div');
    d.className = 'comp';
    d.innerHTML =
      `<div class="left"><div class="tline">${badges}${deadBadges}</div>` +
      `<div class="uline">${units}${varTag}</div>${profile}</div>` +
      `<div class="compmeta">` + copyCodeButton(r.units) +
      `<div class="score"><b>${r.live}</b>traits active<br>` +
      (r.uniqN ? `<span class="u">+${r.uniqN} unique</span> · ` : '') +
      (r.waste ? `<span class="w">${r.waste} wasted</span> · ` : '') +
      slotTag + `<span title="Assumes every unit at 2★ (3 copies)">${r.gold}g</span></div></div>` +
      varRows;
    frag.appendChild(d);
  }
  list.innerHTML = '';
  list.appendChild(frag);
}

// Click any trait badge in the results to pin it as a requirement at that count.
$('list').addEventListener('click', (e) => {
  const copy = e.target.closest('.copycode');
  if (copy) {
    const champions = copy.dataset.units.split(',').map(i => DB.champions[+i]);
    const code = TeamCode.encode(champions, DB.teamPlannerSet);
    const copied = () => {
      clearTimeout(copy.copyReset);
      copy.classList.add('copied');
      copy.dataset.tip = 'Copied to clipboard';
      copy.setAttribute('aria-label', 'Copied to clipboard');
      copy.copyReset = setTimeout(() => {
        if (!copy.isConnected) return;
        copy.classList.remove('copied');
        copy.dataset.tip = 'Copy TFT Team Planner code';
        copy.setAttribute('aria-label', 'Copy TFT Team Planner code');
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(copied)
        .catch(() => window.prompt('Copy this TFT Team Planner code:', code));
    } else {
      window.prompt('Copy this TFT Team Planner code:', code);
    }
    return;
  }
  const vt = e.target.closest('.vtag');
  if (vt) {
    const open = vt.closest('.comp').classList.toggle('vopen');
    vt.setAttribute('aria-expanded', String(open));
    vt.setAttribute('aria-label',
      `${open ? 'Hide' : 'Show'} ${vt.dataset.count} alternate composition` +
      (vt.dataset.count === '1' ? '' : 's'));
    return;
  }
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
