// app.js — TFT Trait Explorer
let DB = null, W = [], dataReady = false, workersReady = false;
let reqId = 0, pending = false, workerEpoch = 0, searchGeneration = 0;
let inbox = [];                   // shard results for the in-flight request
// Mid-flight snapshots, keyed by worker, so a shard's newer snapshot replaces
// its older one instead of accumulating duplicate rows.
let shardProgress = new Map();
// Best board the solver has proved for the in-flight request, kept separately
// from solverInbox so interim renders can include it before the solver
// finishes enumerating the runners-up.
let solverBest = null;
// Interim-render throttle state. Declared up here with the rest of the module
// state, NOT next to renderProgress(): stopWorkers() runs during init and calls
// cancelProgressRender(), and a `let` declared further down would still be in
// its temporal dead zone at that point, throwing and killing page load.
const PROGRESS_RENDER_MS = 250;
let progressFrame = null;
let lastProgressRender = 0;
let debounceTimer = null, queuedDispatch = null, activeSearch = null;
// The MILP solver runs beside the DFS shards. It proves the ceiling in a few
// hundred ms where the DFS needs tens of seconds and usually gives up first, so
// its row is what makes a result trustworthy rather than merely plausible.
let solverWorker = null, solverReady = false, solverInbox = null;
let solverBroken = false;
// One worker per core, minus one so the UI thread keeps a lane. Capped at 8:
// past that the merge cost outweighs the split on this search size.
const NW = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const DEBOUNCE_MS = 200;
const MEMORY_CACHE_LIMIT = 24;
const DEVICE_CACHE_LIMIT = 50;
const DEVICE_CACHE_DB = 'tft-trait-search-cache';
const DEVICE_CACHE_STORE = 'results';
const METRICS_KEY = 'tft-search-metrics-v1';
const SHARE_SCHEMA_VERSION = 2;
const DEFAULT_LEVEL = 8;
const DEFAULT_WASTE = 10;
const DEFAULT_SIZE = 8;
const DEFAULT_SORT = ['live', 'cost'];
const DEFAULT_EFFORT = 'deep';
const EFFORT_ORDER = ['quick', 'balanced', 'deep'];
const EFFORTS = {
  quick: { timeBudgetMs: 1000, workers: 2 },
  balanced: { timeBudgetMs: 4000, workers: 4 },
  deep: { timeBudgetMs: 0, workers: 8 },
};
const VALID_SORTS = new Set(['live', 'tier', 'waste', 'cost', 'rich']);
const POOL_VIEWS = new Set(['cost', 'origin', 'class']);
const MAX_SHARED_EMBLEMS = 20;
const FILTERS_STORAGE_KEY = 'tftkit:filters-collapsed';

const $ = id => document.getElementById(id);
const state = new Map();          // champ key -> 0 none / 1 required / 2 excluded
// Comps the user set aside, keyed by roster signature -> the full row object.
// A Map keeps insertion order, so the section reads in the order things were
// picked rather than reshuffling on every re-render.
const selectedComps = new Map();
const costOn = new Set([1, 2, 3, 4, 5]);
const emblems = [];               // trait keys
const reqTraits = [];             // [{key, n}] — trait floors, e.g. Invoker 4
const muted = new Set();          // trait keys that still show but earn no score or waste
const excludedGroups = new Set();
let poolView = 'cost';

const { algorithmVersion, antiStack, breakpoints, compSignature, isUnique,
  mergeSearchResults, moveSelectionFirst, scoreFloor, scoresAt,
  scoringBreakpoints, searchCacheKey, summary, toggleSelection } = SearchUtils;

const memoryCache = new Map();
let cacheDbPromise = null, metricsStorageWarned = false;
let urlSyncGeneration = 0;
let savedSearches = [], savedSearchesAvailable = true;
let BOARD_TABLES = null;
let selectedRestoreNotice = '';
let lastShareApiWarmAt = 0;
let filtersPreferenceExplicit = false;

function setFiltersCollapsed(collapsed, persist = false) {
  const wrap = document.querySelector('.wrap');
  const panel = $('filtersPanel');
  const content = $('filtersContent');
  const toggle = $('filtersToggle');
  wrap.classList.toggle('filters-collapsed', collapsed);
  panel.dataset.collapsed = String(collapsed);
  content.hidden = collapsed;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Show filters' : 'Hide filters');
  toggle.title = collapsed ? 'Show filters' : 'Hide filters';
  if (!persist) return;
  filtersPreferenceExplicit = true;
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, collapsed ? '1' : '0');
  } catch (error) {
    console.warn('Could not save the filter panel preference.', error);
  }
}

function initialFiltersCollapsed() {
  try {
    const stored = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (stored === '1' || stored === '0') {
      filtersPreferenceExplicit = true;
      return stored === '1';
    }
  } catch (error) {
    console.warn('Could not read the filter panel preference.', error);
  }
  return matchMedia('(max-width: 820px)').matches;
}

const filtersMedia = matchMedia('(max-width: 820px)');
setFiltersCollapsed(initialFiltersCollapsed());
$('filtersToggle').addEventListener('click', () => {
  setFiltersCollapsed(!$('filtersContent').hidden, true);
});
filtersMedia.addEventListener?.('change', event => {
  if (!filtersPreferenceExplicit) setFiltersCollapsed(event.matches);
});

function loadMetrics() {
  const empty = {
    requests: 0, memoryHits: 0, deviceHits: 0, precomputedHits: 0, workerRuns: 0,
    cancellations: 0, truncated: 0, workerMs: 0, workerNodes: 0,
    timeStops: 0, nodeStops: 0, cacheErrors: 0,
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

async function showPrecomputedLanding() {
  if (!isDefaultSharedState(sharedSearchState())) return false;
  const generation = searchGeneration;
  const opts = buildSearchOptions();
  const version = `${algorithmVersion}:${DB.builtAt || DB.gameBuild || DB.set}`;
  const key = searchCacheKey(version, opts);
  try {
    const response = await fetch('precomputed-default.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const snapshot = await response.json();
    if (generation !== searchGeneration) return true;
    const result = snapshot.result;
    if (snapshot.schemaVersion !== 1
        || snapshot.algorithmVersion !== algorithmVersion
        || snapshot.dataBuiltAt !== DB.builtAt
        || snapshot.queryKey !== key
        || !result || !Array.isArray(result.rows)
        || result.rows.length !== 100
        || !Number.isFinite(result.total)
        || typeof result.truncated !== 'boolean') {
      throw new Error('Landing result metadata does not match this build.');
    }
    recordMetric('requests');
    recordMetric('precomputedHits');
    memoryCacheSet(key, result);
    render({ ...result, cached: 'precomputed' });
    return true;
  } catch (error) {
    if (generation !== searchGeneration) return true;
    console.warn('Could not load the precomputed landing result.', error);
    return false;
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

function effortSettings() {
  return EFFORTS[$('effort').value] || EFFORTS[DEFAULT_EFFORT];
}

function updateRefineButton() {
  const index = EFFORT_ORDER.indexOf($('effort').value);
  const next = EFFORT_ORDER[index + 1];
  $('refine').disabled = !next;
  $('refine').textContent = next
    ? `Refine to ${next[0].toUpperCase() + next.slice(1)}`
    : 'Fully refined';
}

function resetSearchState() {
  for (const key of state.keys()) state.set(key, 0);
  costOn.clear();
  for (let cost = 1; cost <= 5; cost++) costOn.add(cost);
  emblems.length = 0;
  reqTraits.length = 0;
  muted.clear();
  excludedGroups.clear();
  $('size').value = DEFAULT_LEVEL;
  $('sizeV').textContent = DEFAULT_LEVEL;
  $('waste').value = DEFAULT_WASTE;
  $('wasteV').textContent = DEFAULT_WASTE;
  $('sort').value = DEFAULT_SORT[0];
  $('sort2').value = DEFAULT_SORT[1];
  $('effort').value = DEFAULT_EFFORT;
  $('search').value = '';
  poolView = 'cost';
  selectedComps.clear();
  selectedRestoreNotice = '';
}

function sharedSearchState() {
  const shared = { v: SHARE_SCHEMA_VERSION };
  const level = +$('size').value;
  const waste = +$('waste').value;
  if (level !== DEFAULT_LEVEL) shared.l = level;
  if (waste !== DEFAULT_WASTE) shared.w = waste;

  const required = [], excluded = [];
  for (const champion of DB.champions) {
    const value = state.get(champion.key);
    if (value === 1) required.push(champion.key);
    else if (value === 2) excluded.push(champion.key);
  }
  if (required.length) shared.r = required;
  if (excluded.length) shared.x = excluded;
  if (excludedGroups.size) shared.xg = [...excludedGroups].sort();

  const costs = [...costOn].sort((a, b) => a - b);
  if (costs.length !== 5 || costs.some((cost, index) => cost !== index + 1)) {
    shared.c = costs;
  }

  if (reqTraits.length) {
    shared.t = reqTraits.map(({ key, n }) => [key, n])
      .sort(([a], [b]) => a.localeCompare(b));
  }
  if (muted.size) shared.m = [...muted].sort();
  if (emblems.length) {
    const counts = new Map();
    for (const key of emblems) counts.set(key, (counts.get(key) || 0) + 1);
    let remaining = MAX_SHARED_EMBLEMS;
    shared.e = [...counts].sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => {
        const accepted = Math.min(count, remaining);
        remaining -= accepted;
        return [key, accepted];
      })
      .filter(([, count]) => count > 0);
  }

  const sort = [$('sort').value, $('sort2').value];
  if (sort[0] !== DEFAULT_SORT[0] || sort[1] !== DEFAULT_SORT[1]) shared.s = sort;
  if ($('effort').value !== DEFAULT_EFFORT) shared.o = $('effort').value;
  const query = $('search').value.trim();
  if (query) shared.q = query.slice(0, 100);
  if (poolView !== 'cost') shared.g = poolView;
  if (selectedComps.size) {
    shared.sel = [...selectedComps.values()].slice(0, 12).map(row =>
      row.units.map(index => DB.champions[index].key));
  }
  return shared;
}

function applySharedSearchState(shared) {
  if (!Number.isInteger(shared.v) || shared.v < 1 || shared.v > SHARE_SCHEMA_VERSION) {
    throw new Error(`Unsupported shared-search version: ${shared.v}`);
  }
  resetSearchState();

  if (Number.isInteger(shared.l) && shared.l >= 2 && shared.l <= 10) {
    $('size').value = shared.l;
    $('sizeV').textContent = shared.l;
  }
  if (Number.isInteger(shared.w) && shared.w >= 0 && shared.w <= 10) {
    $('waste').value = shared.w;
    $('wasteV').textContent = shared.w;
  }

  const championKeys = new Set(DB.champions.map(champion => champion.key));
  const strings = (value, limit) => Array.isArray(value)
    ? value.filter(item => typeof item === 'string').slice(0, limit)
    : [];
  for (const key of strings(shared.r, DB.champions.length)) {
    if (championKeys.has(key)) state.set(key, 1);
  }
  for (const key of strings(shared.x, DB.champions.length)) {
    if (championKeys.has(key) && state.get(key) === 0) state.set(key, 2);
  }
  const validGroups = new Set(formGroups().map(({ group }) => group));
  for (const group of strings(shared.xg, validGroups.size)) {
    if (validGroups.has(group)) excludedGroups.add(group);
  }
  for (const champion of DB.champions) {
    if (isGroupExcluded(champion)) state.set(champion.key, 0);
  }

  if (Array.isArray(shared.c)) {
    costOn.clear();
    for (const cost of shared.c) {
      if (Number.isInteger(cost) && cost >= 1 && cost <= 5) costOn.add(cost);
    }
  }

  for (const entry of Array.isArray(shared.t) ? shared.t.slice(0, 35) : []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, n] = entry;
    const trait = DB.traits[key];
    if (!trait || !filterable(trait) || !scoringBreakpoints(trait).includes(n)) continue;
    if (!reqTraits.some(requirement => requirement.key === key)) reqTraits.push({ key, n });
  }

  for (const key of strings(shared.m, 35)) {
    if (DB.traits[key] && filterable(DB.traits[key])) muted.add(key);
  }
  for (let i = reqTraits.length - 1; i >= 0; i--) {
    if (muted.has(reqTraits[i].key)) reqTraits.splice(i, 1);
  }

  const emblemKeys = new Set(emblemable().map(trait => trait.key));
  let emblemTotal = 0;
  for (const entry of Array.isArray(shared.e) ? shared.e.slice(0, 35) : []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, count] = entry;
    if (!emblemKeys.has(key) || !Number.isInteger(count) || count < 1) continue;
    const accepted = Math.min(count, MAX_SHARED_EMBLEMS - emblemTotal);
    for (let i = 0; i < accepted; i++) emblems.push(key);
    emblemTotal += accepted;
    if (emblemTotal >= MAX_SHARED_EMBLEMS) break;
  }

  if (Array.isArray(shared.s) && shared.s.length === 2
      && shared.s.every(sort => VALID_SORTS.has(sort))) {
    $('sort').value = shared.s[0];
    $('sort2').value = shared.s[1];
  }
  if (typeof shared.o === 'string' && EFFORTS[shared.o]) $('effort').value = shared.o;
  if (typeof shared.q === 'string') $('search').value = shared.q.slice(0, 100);
  if (POOL_VIEWS.has(shared.g)) poolView = shared.g;

  let dropped = 0;
  const seenSelections = new Set();
  const mutedIndexes = [...muted].map(key => BOARD_TABLES.traitIndex.get(key))
    .filter(index => index !== undefined);
  for (const roster of Array.isArray(shared.sel) ? shared.sel.slice(0, 12) : []) {
    const validated = BoardScore.validateRoster(DB, BOARD_TABLES, roster, {
      size: +$('size').value,
      emblems,
      muted: mutedIndexes,
    });
    if (validated.error) {
      dropped++;
      continue;
    }
    const signature = compSignature(validated.indexes);
    if (seenSelections.has(signature)) continue;
    seenSelections.add(signature);
    selectedComps.set(signature, validated.row);
  }
  if (dropped) {
    selectedRestoreNotice = `${dropped} invalid selected comp${dropped === 1 ? '' : 's'} ` +
      `could not be restored.`;
  }
}

function refreshSearchControls() {
  for (const button of $('costs').children) {
    button.classList.toggle('on', costOn.has(+button.dataset.cost));
  }
  renderEmblems();
  renderTraitGrid();
  buildGroupExclusions();
  buildPool();
  updPickN();
  updateRefineButton();
}

function isDefaultSharedState(shared) {
  return Object.keys(shared).length === 1;
}

async function shareUrl(shared = sharedSearchState()) {
  const url = new URL(location.href);
  if (isDefaultSharedState(shared)) {
    url.searchParams.delete('s');
  } else {
    url.searchParams.set('s', await ShareState.encode(shared));
  }
  return url;
}

async function previewShareUrl(shared = sharedSearchState()) {
  const url = new URL(location.href);
  const token = await ShareState.encode(shared);
  url.pathname = `/api/share/${token}`;
  url.search = '';
  url.hash = '';
  try {
    const response = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(12000)
        : undefined,
    });
    if (!response.ok) throw new Error(`Short-link service returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{12,43}$/.test(payload.id)) {
      throw new Error('Short-link service returned an invalid ID.');
    }
    if (payload.prewarm !== `/api/prewarm/${payload.id}`) {
      throw new Error('Short-link service returned an invalid prewarm path.');
    }
    url.pathname = `/api/s/${payload.id}`;
    void fetch(payload.prewarm, {
      method: 'POST',
      keepalive: true,
    }).catch(error => console.warn('Could not prewarm the Discord preview.', error));
    return url;
  } catch (error) {
    console.warn('Falling back to the stateless share URL.', error);
    return url;
  }
}

function warmShareApi() {
  const now = Date.now();
  if (now - lastShareApiWarmAt < 5 * 60 * 1000) return;
  lastShareApiWarmAt = now;
  void fetch('/api/ready', { cache: 'no-store' }).then(response => {
    if (!response.ok) throw new Error(`Share API returned HTTP ${response.status}.`);
  }).catch(error => {
    lastShareApiWarmAt = 0;
    console.warn('Could not warm the share API.', error);
  });
}

async function syncSearchUrl(generation) {
  if (!dataReady || !DB) return;
  const sync = ++urlSyncGeneration;
  const url = await shareUrl();
  if (sync !== urlSyncGeneration || generation !== searchGeneration) return;
  history.replaceState(null, '', url);
}

async function restoreSharedSearch() {
  const url = new URL(location.href);
  const token = url.searchParams.get('s');
  if (!token) return;
  try {
    applySharedSearchState(await ShareState.decode(token));
  } catch (error) {
    console.warn('Ignoring invalid shared search.', error);
    url.searchParams.delete('s');
    history.replaceState(null, '', url);
  }
}

function defaultSavedSearchName() {
  const query = $('search').value.trim();
  if (query) return query;
  if (reqTraits.length) {
    const { key, n } = reqTraits[0];
    return `${DB.traits[key]?.name || key} ${n}`;
  }
  const champion = DB.champions.find(unit => state.get(unit.key) === 1);
  if (champion) return `${champion.name} team`;
  if (excludedGroups.size) return `No ${[...excludedGroups][0]} forms`;
  if (poolView !== 'cost') return `Units by ${poolView}`;
  return `Level ${$('size').value} search`;
}

function renderSavedSearches() {
  const list = $('savedList');
  list.replaceChildren();
  $('savedN').textContent = savedSearches.length;
  $('saveSearch').disabled = !savedSearchesAvailable || !dataReady;

  if (!savedSearchesAvailable || !savedSearches.length) {
    const empty = document.createElement('div');
    empty.className = 'savedempty';
    empty.textContent = savedSearchesAvailable
      ? 'No saved searches yet.'
      : 'Saved searches are unavailable.';
    list.appendChild(empty);
    return;
  }

  for (const saved of savedSearches) {
    const row = document.createElement('div');
    row.className = 'saveditem';

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'savedload';
    load.dataset.id = saved.id;
    load.disabled = !dataReady;
    load.title = `Load ${saved.name}`;
    const name = document.createElement('span');
    name.className = 'savedname';
    name.textContent = saved.name;
    load.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saveddelete';
    remove.dataset.id = saved.id;
    remove.setAttribute('aria-label', `Delete ${saved.name}`);
    remove.title = `Delete ${saved.name}`;
    remove.textContent = '\u00d7';

    row.append(load, remove);
    list.appendChild(row);
  }
}

function readSavedSearches() {
  try {
    savedSearches = SavedSearches.load(localStorage);
    savedSearchesAvailable = true;
  } catch (error) {
    console.error('Could not read saved searches.', error);
    savedSearches = [];
    try {
      localStorage.removeItem(SavedSearches.STORAGE_KEY);
      savedSearchesAvailable = true;
    } catch (cleanupError) {
      console.error('Could not reset saved-search storage.', cleanupError);
      savedSearchesAvailable = false;
    }
  }
  renderSavedSearches();
}

async function saveCurrentSearch() {
  if (!dataReady) return;
  const proposed = window.prompt('Name this search:', defaultSavedSearchName());
  if (proposed == null) return;
  const name = proposed.trim();
  if (!name) return;
  try {
    const token = await ShareState.encode(sharedSearchState());
    savedSearches = SavedSearches.upsert(localStorage, { name, token });
    renderSavedSearches();
    const button = $('saveSearch');
    clearTimeout(button.savedReset);
    button.textContent = 'Saved';
    button.savedReset = setTimeout(() => {
      button.textContent = 'Save';
    }, 1200);
  } catch (error) {
    console.error('Could not save the search.', error);
    window.alert('This search could not be saved on this device.');
  }
}

async function restoreSavedEntry(id) {
  if (!dataReady) return;
  const saved = savedSearches.find(entry => entry.id === id);
  if (!saved) return;
  try {
    applySharedSearchState(await ShareState.decode(saved.token));
    refreshSearchControls();
    $('savedMenu').open = false;
    run(true);
  } catch (error) {
    console.error('Could not restore the saved search.', error);
    window.alert('This saved search is invalid or no longer supported.');
  }
}

function deleteSavedEntry(id) {
  try {
    savedSearches = SavedSearches.remove(localStorage, id);
    renderSavedSearches();
  } catch (error) {
    console.error('Could not delete the saved search.', error);
    window.alert('This saved search could not be deleted.');
  }
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
function stopWorkers(cancellation = false) {
  if (cancellation && pending) recordMetric('cancellations');
  workerEpoch++;
  W.forEach(worker => worker.terminate());
  W = [];
  workersReady = false;
  queuedDispatch = null;
  pending = false;
  inbox = [];
  shardProgress = new Map();
  cancelProgressRender();
  solverBest = null;
  solverInbox = null;
  activeSearch = null;
  reqId++;
  // The solver worker is deliberately NOT terminated here: booting it means
  // re-fetching and re-instantiating ~3MB of wasm, which costs far more than
  // letting a stale solve finish and be discarded by its request id.
}

// Lazily spin up the MILP solver. Failures are non-fatal by design — if the
// wasm can't load (old browser, blocked fetch, OOM) the DFS still answers, we
// just lose the optimality proof.
function ensureSolver() {
  if (solverBroken || solverWorker) return;
  try {
    solverWorker = new Worker('solver-worker.js');
  } catch (err) {
    solverBroken = true;
    return;
  }
  solverWorker.onmessage = event => {
    const message = event.data;
    if (message.type === 'ready') { solverReady = true; return; }
    if (message.type === 'solver') onSolver(message);
  };
  solverWorker.onerror = () => {
    solverBroken = true;
    solverReady = false;
    if (solverWorker) { solverWorker.terminate(); solverWorker = null; }
    // A search waiting only on the solver must not hang forever.
    if (pending && activeSearch && inbox.length >= W.length) finishSearch();
  };
  solverWorker.postMessage({ type: 'init', db: DB });
}

function ensureWorkers(count, callback) {
  if (W.length && W.length !== count) stopWorkers(false);
  queuedDispatch = callback;
  if (workersReady && W.length === count) {
    queuedDispatch = null;
    callback();
    return;
  }
  if (W.length) return;

  const epoch = ++workerEpoch;
  let started = 0;
  for (let i = 0; i < count; i++) {
    const worker = new Worker('worker.js');
    worker.onmessage = event => {
      if (epoch !== workerEpoch) return;
      if (event.data.type === 'ready') {
        if (++started === count) {
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
  excludedGroups.clear();
  poolView = 'cost';
  $('status').textContent = 'loading data…';
  $('list').innerHTML = '';
  return fetch('data.json', { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }).then(async db => {
    DB = db;
    BOARD_TABLES = BoardScore.tables(DB);
    db.champions.forEach(c => state.set(c.key, 0));
    resetSearchState();
    const build = String(db.gameBuild || '').split('+')[0];
    const nUniq = Object.values(db.traits).filter(t => !filterable(t)).length;
    const nTr = Object.keys(db.traits).length;
    $('meta').innerHTML =
      `${db.champions.length} units · ` +
      `<span title="${nTr - nUniq} you can build around, ` +
      `${nUniq} tied to a specific champion">${nTr} traits</span>` +
      (db.note ? ` <span class="tag" title="Data build ${build} — ${db.note}">PBE</span>` : '');
    $('pool').innerHTML = ''; $('costs').innerHTML = '';
    buildCosts(); buildEmblemGrid();
    buildTraitGrid(); updPickN();
    await restoreSharedSearch();
    refreshSearchControls();
    dataReady = true;
    warmShareApi();
    renderSavedSearches();
    renderSelectedComps();
    if (!await showPrecomputedLanding()) run(true);
  }).catch(e => { $('status').textContent = 'data load failed: ' + e; });
}

loadData();

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'result') return;
  if (m.id !== reqId) return;            // stale shard from a superseded search
  // A partial is a mid-flight snapshot, not a finished shard. It must never
  // land in `inbox` or it would be counted toward completion and the search
  // would "finish" while the DFS is still running.
  if (m.partial) {
    if (pending && activeSearch) {
      shardProgress.set(e.target, m);
      renderProgress();
    }
    return;
  }
  shardProgress.delete(e.target);
  inbox.push(m);
  if (inbox.length < W.length) { renderProgress(); return; }
  finishSearch();
}

// Interim render while shards are still grinding: merge whatever each engine
// has found so far. Rows are already sorted inside each shard, and
// mergeSearchResults() dedupes by trait signature, so this is the same
// combination the final render does — just over incomplete inputs.
//
// Coalesced: eight shards emit independently, so without this the UI would
// rebuild the whole 100-board list ~20x/second and steal main-thread time from
// the search itself. One render per animation frame, and at most one per
// PROGRESS_RENDER_MS, is plenty to look live. (The throttle state itself lives
// at the top of this file — see the note there about the temporal dead zone.)

// Drop any queued interim render. Without this a timer armed mid-search can
// fire AFTER the final render and revert the UI to "finding more…".
function cancelProgressRender() {
  if (progressFrame !== null) {
    clearTimeout(progressFrame);
    progressFrame = null;
  }
}

function renderProgress() {
  if (progressFrame !== null) return;
  const since = performance.now() - lastProgressRender;
  const wait = Math.max(0, PROGRESS_RENDER_MS - since);
  progressFrame = setTimeout(() => {
    progressFrame = null;
    lastProgressRender = performance.now();
    renderProgressNow();
  }, wait);
}

function renderProgressNow() {
  const search = activeSearch;
  if (!search || !pending) return;

  const parts = [
    ...inbox,                             // shards that already finished
    ...shardProgress.values(),            // snapshots from shards still running
  ];
  const solverRows = solverBest ? [solverBest] : [];
  if (solverRows.length) {
    parts.push({
      rows: solverRows, total: 0, ms: 0,
      nodes: 0, truncated: false, capped: false, stopReason: null,
    });
  }
  if (!parts.length) return;

  const merged = mergeSearchResults(parts, search.opts.sortMode, search.opts.sortMode2);
  if (!merged.rows.length) return;
  merged.effort = search.opts.effort;
  merged.proved = !!solverBest;
  merged.partial = true;
  render(merged);
}

function onSolver(m) {
  if (m.id !== reqId) return;            // stale solve from a superseded search
  // A partial is an early proof, not a completed solve: record it and render,
  // but keep waiting for the real message or the search would finish holding
  // just the one board.
  if (m.partial) {
    if (pending && activeSearch && m.rows && m.rows.length) {
      solverBest = m.rows[0];
      renderProgress();
    }
    return;
  }
  solverInbox = m;
  if (!pending || !activeSearch) return;
  if (m.rows && m.rows.length && !m.error) solverBest = m.rows[0];
  if (inbox.length >= W.length) { finishSearch(); return; }
  // The DFS is still grinding, but the solver has already proved the ceiling.
  // Show it now — waiting means staring at "searching…" for another ten seconds
  // to receive rows we can already prove are no better.
  renderProgress();
}

// Both engines are in. Combine and render.
//
// The solver contributes proven-optimal boards; the DFS contributes volume.
// mergeSearchResults() dedupes by trait signature and keeps the best roster per
// signature, so overlapping boards collapse correctly rather than double-count.
function finishSearch() {
  const search = activeSearch;
  if (!search) return;
  // Wait for the solver unless it is unavailable or already reported.
  const solverPending = !solverBroken && solverWorker && solverInbox === null;
  if (solverPending) return;

  pending = false;
  const parts = inbox; inbox = [];
  shardProgress = new Map();
  cancelProgressRender();
  solverBest = null;
  const solver = solverInbox; solverInbox = null;
  activeSearch = null;

  const err = parts.find(p => p.error);
  if (err) {
    render({ error: err.error });
    return;
  }

  const solverRows = (solver && !solver.error && solver.rows) ? solver.rows : [];
  // The synthetic part mimics a shard so mergeSearchResults() can treat both
  // engines uniformly. total:0 keeps the "boards examined" figure honest —
  // the solver proves rather than enumerates, so it counts no nodes.
  const solverPart = {
    rows: solverRows, total: 0, ms: solver ? solver.ms : 0,
    nodes: 0, truncated: false, capped: false, stopReason: null,
  };
  const merged = mergeSearchResults(
    solverRows.length ? [...parts, solverPart] : parts,
    search.opts.sortMode, search.opts.sortMode2);
  merged.effort = search.opts.effort;
  // `proved` means the solver ran to optimality on this exact query, so the top
  // row is the best board that exists — not merely the best one we stumbled on.
  merged.proved = !!(solver && solver.proved);
  merged.solverMs = solver ? solver.ms : null;
  if (solver && solver.error) merged.solverError = solver.error;

  recordMetric('workerMs', merged.ms);
  recordMetric('workerNodes', merged.nodes);
  if (merged.truncated) recordMetric('truncated');
  if (merged.stopReason === 'time') recordMetric('timeStops');
  else if (merged.stopReason === 'nodes') recordMetric('nodeStops');
  if (merged.proved) recordMetric('proved');
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
    b.dataset.cost = c;
    b.onclick = () => {
      costOn.has(c) ? costOn.delete(c) : costOn.add(c);
      b.classList.toggle('on', costOn.has(c));
      applyFilter(); run();
    };
    el.appendChild(b);
  }
}

function formGroups() {
  const groups = new Map();
  for (const champion of DB.champions) {
    if (!champion.group) continue;
    if (!groups.has(champion.group)) groups.set(champion.group, []);
    groups.get(champion.group).push(champion);
  }
  return [...groups].map(([group, champions]) => ({ group, champions }))
    .filter(({ champions }) => champions.length > 1)
    .sort((a, b) => a.group.localeCompare(b.group));
}

function isGroupExcluded(champion) {
  return Boolean(champion.group && excludedGroups.has(champion.group));
}

function buildGroupExclusions() {
  const groups = formGroups();
  const container = $('groupExclusions');
  const list = $('groupExclusionList');
  list.replaceChildren();
  container.hidden = !groups.length;
  for (const { group, champions } of groups) {
    const label = document.createElement('label');
    label.className = 'groupcheck';
    label.title = `Exclude all ${champions.length} ${group} forms`;
    label.innerHTML = `<input type="checkbox" data-group="${group}">` +
      `<span>Exclude ${group} forms</span><b>${champions.length}</b>`;
    label.querySelector('input').addEventListener('change', event => {
      setGroupExcluded(group, event.target.checked);
    });
    list.appendChild(label);
  }
  renderGroupExclusions();
}

function renderGroupExclusions() {
  for (const input of $('groupExclusionList').querySelectorAll('input[data-group]')) {
    input.checked = excludedGroups.has(input.dataset.group);
  }
}

function setGroupExcluded(group, excluded) {
  if (excluded) {
    excludedGroups.add(group);
    for (const champion of DB.champions) {
      if (champion.group === group) state.set(champion.key, 0);
    }
  } else {
    excludedGroups.delete(group);
  }
  renderGroupExclusions();
  buildPool();
  updPickN();
  run();
}

function buildPool() {
  const el = $('pool');
  el.innerHTML = '';
  el.classList.toggle('traitview', poolView !== 'cost');
  if (poolView !== 'cost') buildPoolByCategory(el, poolView);
  else buildPoolByCost(el);
  renderPoolView();
  applyFilter();
}

function buildPoolByCost(el) {
  const byCost = new Map();
  for (const c of DB.champions) {
    if (!byCost.has(c.cost)) byCost.set(c.cost, []);
    byCost.get(c.cost).push(c);
  }
  const costs = [...byCost.keys()].sort((a, b) => a - b);
  for (const cost of costs) {
    const group = `cost:${cost}`;
    const h = document.createElement('div');
    h.className = 'poolhdr costhdr c' + cost;
    h.dataset.group = group;
    h.innerHTML = `<span>${cost} cost</span><i>${byCost.get(cost).length}</i>`;
    el.appendChild(h);
    byCost.get(cost).sort((a, b) => a.name.localeCompare(b.name))
      .forEach(c => addUnit(el, c, group));
  }
}

function buildPoolByCategory(el, category) {
  const groups = Object.entries(DB.traits)
    .filter(([, trait]) => trait.category === category)
    .map(([key, trait]) => ({
      key,
      trait,
      units: DB.champions.filter(champion => champion.traits.includes(key)),
    })).filter(group => group.units.length)
    .sort((a, b) => a.trait.name.localeCompare(b.trait.name));
  for (const { key, trait, units } of groups) {
    const group = `trait:${key}`;
    const section = document.createElement('section');
    section.className = 'traitgroup';
    section.dataset.group = group;
    const h = document.createElement('div');
    h.className = 'poolhdr traithdr';
    h.dataset.group = group;
    h.innerHTML = (trait.icon ? `<img src="${trait.icon}" alt="">` : '') +
      `<span>${trait.name}</span><i>${units.length}</i>`;
    const unitGrid = document.createElement('div');
    unitGrid.className = 'traitunits';
    section.append(h, unitGrid);
    el.appendChild(section);
    units.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .forEach(champion => addUnit(unitGrid, champion, group));
  }
}

function renderPoolView() {
  const views = [
    ['cost', 'poolViewCost'],
    ['origin', 'poolViewOrigin'],
    ['class', 'poolViewClass'],
  ];
  for (const [view, id] of views) {
    const active = poolView === view;
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-selected', String(active));
  }
}

function setPoolView(view) {
  if (!POOL_VIEWS.has(view) || view === poolView) return;
  poolView = view;
  buildPool();
  void syncSearchUrl(searchGeneration);
}

function setUnitState(key, value) {
  const champion = DB.champions.find(unit => unit.key === key);
  if (champion && isGroupExcluded(champion)) return;
  state.set(key, value);
  for (const tile of document.querySelectorAll('.u[data-key], .uc[data-key]')) {
    if (tile.dataset.key !== key) continue;
    tile.classList.toggle('req', value === 1);
    tile.classList.toggle('exc', value === 2);
  }
  applyFilter();
  updPickN();
  run();
}

function addUnit(el, c, group) {
    const d = document.createElement('div');
    d.className = 'u b' + c.cost;
    d.dataset.cost = c.cost;
    d.dataset.key = c.key;
    d.dataset.group = group;
    d.dataset.search = (c.name + ' ' + c.traits.map(t => DB.traits[t]?.name || t).join(' ')).toLowerCase();
    d.title = c.name + ' — ' + c.traits.map(t => DB.traits[t]?.name || t).join(', ');
    d.innerHTML = `<img loading="lazy" src="${c.icon}" alt="">
      ${portraitRoleBadge(c)}<span class="cst c${c.cost}">${c.cost}</span><span class="nm">${c.name}</span>`;
    const value = isGroupExcluded(c) ? 2 : (state.get(c.key) || 0);
    d.classList.toggle('req', value === 1);
    d.classList.toggle('exc', value === 2);
    d.onclick = () => {
      // Touch has no hover, so a tap must be able to mean "tell me about
      // this" -- the sheet carries require/exclude as explicit buttons.
      if (isTouch()) return openSheet(unitCard(c.key), 'unit', c.key);
      setUnitState(c.key, state.get(c.key) === 1 ? 0 : 1);
    };
    d.oncontextmenu = e => {
      e.preventDefault();
      setUnitState(c.key, state.get(c.key) === 2 ? 0 : 2);
    };
    el.appendChild(d);
    state.set(c.key, state.get(c.key) || 0);
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  const shown = new Map();
  for (const d of $('pool').querySelectorAll('.u[data-key]')) {
    const c = DB.champions.find(x => x.key === d.dataset.key);
    const hide = (!costOn.has(c.cost) && state.get(c.key) !== 1) ||
                 (q && !d.dataset.search.includes(q));
    d.classList.toggle('hide', hide);
    if (!hide) shown.set(d.dataset.group, (shown.get(d.dataset.group) || 0) + 1);
  }
  for (const d of $('pool').querySelectorAll('.poolhdr')) {
    const n = shown.get(d.dataset.group) || 0;
    d.classList.toggle('hide', n === 0);
    d.querySelector('i').textContent = n;
    const section = d.closest('.traitgroup');
    if (section) section.classList.toggle('hide', n === 0);
  }
}

function updPickN() {
  let r = 0, x = 0;
  for (const champion of DB.champions) {
    const value = state.get(champion.key);
    if (value === 1) r++;
    else if (value === 2 || isGroupExcluded(champion)) x++;
  }
  $('pickN').textContent = `${r} required · ${x} excluded`;
  renderSel();
}

// The pool is 73 tiles deep and your picks scatter across five cost rows, so a
// selection is easy to lose track of. Mirror them into one strip.
// Active filters used to live in six places -- a strip under the grid for
// units, bare counts in the sidebar for traits and emblems, dimmed swatches
// for costs, slider positions for level and waste. On mobile the sidebar
// collapses and half of them vanish entirely. One bar, above the results
// they shape, so the sidebar is an input surface and not a source of truth.

function chipHtml(kind, id, label, icon, cls) {
  const art = icon ? `<img loading="lazy" src="${icon}">` : '';
  return `<span class="afchip ${cls || ''}" data-kind="${kind}" data-id="${id}" ` +
    `title="${label} \u2014 click to clear">${art}<span class="afct">${label}</span>` +
    '<b class="x">\u2715</b></span>';
}

function activeChips() {
  const out = [];
  const req = [], exc = [];
  for (const c of DB.champions) {
    const v = state.get(c.key);
    if (v === 1) req.push(c); else if (v === 2) exc.push(c);
  }
  const byCost = (a, b) => a.cost - b.cost || a.name.localeCompare(b.name);
  for (const c of req.sort(byCost))
    out.push(chipHtml('unit', c.key, c.name, c.icon, 'req k' + c.cost));
  for (const c of exc.sort(byCost))
    out.push(chipHtml('unit', c.key, c.name, c.icon, 'exc k' + c.cost));
  for (const { group, champions } of formGroups()) {
    if (!excludedGroups.has(group)) continue;
    out.push(chipHtml('group', group, group + ' forms', champions[0].icon, 'exc'));
  }
  for (const { key, n } of reqTraits) {
    const t = DB.traits[key];
    if (t) out.push(chipHtml('trait', key, n + ' ' + t.name, t.icon, 'req'));
  }
  for (const key of muted) {
    const t = DB.traits[key];
    if (t) out.push(chipHtml('mute', key, t.name + ' muted', t.icon, 'mute'));
  }
  const seen = new Map();
  for (const key of emblems) seen.set(key, (seen.get(key) || 0) + 1);
  for (const [key, n] of seen) {
    const t = DB.traits[key];
    if (!t) continue;
    const label = (n > 1 ? n + '\u00D7 ' : '') + t.name + ' emblem';
    out.push(chipHtml('emblem', key, label, t.icon, 'emb'));
  }
  for (let c = 1; c <= 5; c++)
    if (!costOn.has(c)) out.push(chipHtml('cost', c, 'no ' + c + '\u2605', '', 'off'));
  const size = +$('size').value;
  if (size !== DEFAULT_SIZE) out.push(chipHtml('size', size, 'Level ' + size, '', 'num'));
  const waste = +$('waste').value;
  if (waste !== DEFAULT_WASTE)
    out.push(chipHtml('waste', waste, waste + ' waste', '', 'num'));
  return out;
}

function renderActiveFilters() {
  const chips = activeChips();
  $('afChips').innerHTML = chips.join('');
  $('activeFilters').hidden = !chips.length;
}

function renderSel() { renderActiveFilters(); }

// Rather than call renderActiveFilters at every mutation site, wrap the two
// renderers each sidebar control already funnels through, plus the sliders.
function syncFilterBar(fn) {
  return function (...args) {
    const out = fn.apply(this, args);
    if (typeof DB !== 'undefined' && DB && DB.champions) renderActiveFilters();
    return out;
  };
}

// Removable only -- a chip clears its own filter and nothing else.
function clearChip(kind, id) {
  if (kind === 'unit') return setUnitState(id, 0);
  if (kind === 'group') return setGroupExcluded(id, false);
  if (kind === 'trait') {
    const i = reqTraits.findIndex(r => r.key === id);
    if (i >= 0) reqTraits.splice(i, 1);
    renderTraitGrid(); applyFilter(); return run();
  }
  if (kind === 'mute') {
    muted.delete(id);
    renderTraitGrid(); applyFilter(); return run();
  }
  if (kind === 'emblem') {
    for (let i = emblems.length - 1; i >= 0; i--)
      if (emblems[i] === id) emblems.splice(i, 1);
    renderEmblems(); return run();
  }
  if (kind === 'cost') {
    costOn.add(+id);
    for (const b of $('costs').children)
      b.classList.toggle('on', costOn.has(+b.dataset.cost));
    applyFilter(); return run();
  }
  if (kind === 'size' || kind === 'waste') {
    const el = $(kind);
    el.value = kind === 'size' ? DEFAULT_SIZE : DEFAULT_WASTE;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
}

$('afChips').addEventListener('click', e => {
  const chip = e.target.closest('.afchip');
  if (!chip) return;
  clearChip(chip.dataset.kind, chip.dataset.id);
  renderActiveFilters();
});
// The sidebar Clear button predates the cost filter and the sliders and
// resets neither, so delegating to it would strand chips in the bar. Clear
// all means all: every chip the bar can show must go.
$('afClear').addEventListener('click', () => {
  for (let c = 1; c <= 5; c++) costOn.add(c);
  for (const b of $('costs').children) b.classList.add('on');
  $('size').value = DEFAULT_SIZE;
  $('sizeV').textContent = DEFAULT_SIZE;
  $('waste').value = DEFAULT_WASTE;
  $('wasteV').textContent = DEFAULT_WASTE;
  $('clear').click();
  renderActiveFilters();
});
renderEmblems = syncFilterBar(renderEmblems);
renderTraitGrid = syncFilterBar(renderTraitGrid);
for (const id of ['size', 'waste'])
  $(id).addEventListener('input', renderActiveFilters);
$('costs').addEventListener('click', () => setTimeout(renderActiveFilters, 0));

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
$('effort').addEventListener('change', () => {
  updateRefineButton();
  run();
});
$('refine').onclick = () => {
  const next = EFFORT_ORDER[EFFORT_ORDER.indexOf($('effort').value) + 1];
  if (!next) return;
  $('effort').value = next;
  updateRefineButton();
  run(true);
};
$('search').addEventListener('input', () => {
  applyFilter();
  void syncSearchUrl(searchGeneration);
});
$('poolViewCost').onclick = () => setPoolView('cost');
$('poolViewOrigin').onclick = () => setPoolView('origin');
$('poolViewClass').onclick = () => setPoolView('class');
$('saveSearch').onclick = () => {
  void saveCurrentSearch();
};
$('savedList').addEventListener('click', event => {
  const load = event.target.closest('.savedload');
  if (load) {
    void restoreSavedEntry(load.dataset.id);
    return;
  }
  const remove = event.target.closest('.saveddelete');
  if (remove) deleteSavedEntry(remove.dataset.id);
});
$('share').onclick = async () => {
  const button = $('share');
  button.disabled = true;
  let url = null;
  try {
    url = await previewShareUrl();
    const copied = () => {
      clearTimeout(button.copyReset);
      button.textContent = 'Copied';
      button.copyReset = setTimeout(() => {
        button.textContent = 'Copy link';
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      copied();
    } else {
      window.prompt('Copy this search link:', url.toString());
    }
  } catch (error) {
    console.error('Could not copy the search link.', error);
    if (url) window.prompt('Copy this search link:', url.toString());
    else button.textContent = 'Copy failed';
  } finally {
    button.disabled = false;
  }
};
$('clear').onclick = () => {
  for (const k of state.keys()) state.set(k, 0);
  emblems.length = 0; renderEmblems();
  reqTraits.length = 0; muted.clear(); renderTraitGrid();
  excludedGroups.clear();
  renderGroupExclusions();
  poolView = 'cost';
  $('search').value = '';
  buildPool();
  updPickN();
  run();
};

readSavedSearches();

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

// ---------- touch info sheet ----------
// Hover cards are pointer-only. On a touch device tapping a tile went
// straight to require/exclude, so there was no way to read a unit's ability
// or a trait's breakpoints at all. The sheet reuses unitCard()/traitCard()
// and moves filtering behind explicit buttons.
const isTouch = () => matchMedia('(pointer: coarse)').matches;
let sheetEl = null;
let sheetKey = null;
let sheetKind = null;

function closeSheet() {
  if (sheetEl) sheetEl.classList.remove('show');
  sheetKey = sheetKind = null;
}

function sheetActions(kind, key) {
  if (kind === 'unit') {
    const st = state.get(key) || 0;
    return '<button class="sheetbtn' + (st === 1 ? ' on' : '') + '" data-act="req">' +
      (st === 1 ? 'Required \u2713' : 'Require') + '</button>' +
      '<button class="sheetbtn' + (st === 2 ? ' on' : '') + '" data-act="exc">' +
      (st === 2 ? 'Excluded \u2713' : 'Exclude') + '</button>';
  }
  return '<button class="sheetbtn" data-act="req">Require trait</button>' +
    '<button class="sheetbtn" data-act="exc">Mute trait</button>';
}

function openSheet(html, kind, key) {
  hideCard();
  if (!sheetEl) {
    sheetEl = document.createElement('div');
    sheetEl.className = 'sheetwrap';
    sheetEl.innerHTML = '<div class="sheetscrim"></div><div class="sheet" role="dialog" ' +
      'aria-modal="true"><div class="sheetgrip"></div>' +
      '<div class="sheetbody"></div><div class="sheetfoot"></div></div>';
    document.body.appendChild(sheetEl);
    sheetEl.querySelector('.sheetscrim').addEventListener('click', closeSheet);
    sheetEl.querySelector('.sheetfoot').addEventListener('click', onSheetAction);
  }
  sheetKind = kind;
  sheetKey = key;
  sheetEl.querySelector('.sheetbody').innerHTML = html;
  sheetEl.querySelector('.sheetfoot').innerHTML = sheetActions(kind, key);
  sheetEl.querySelector('.sheetbody').scrollTop = 0;
  sheetEl.classList.add('show');
}

function onSheetAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !sheetKey) return;
  const act = b.dataset.act;
  if (sheetKind === 'unit') {
    const st = state.get(sheetKey) || 0;
    const want = act === 'req' ? 1 : 2;
    setUnitState(sheetKey, st === want ? 0 : want);
  } else if (act === 'req') {
    cycleTrait(sheetKey, false);
  } else {
    cycleTrait(sheetKey, true);
  }
  closeSheet();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});
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

// iOS synthesises mouseover on tap, so an unguarded hover listener races
// the touch sheet and shows the small card instead. Trust the media query
// over event type: it is the only signal that survives synthetic events.
function canHover() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

document.addEventListener('mouseover', e => {
  if (!canHover()) return;
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
  const effort = $('effort').value;
  const settings = effortSettings();
  const reqIdx = [], poolIdx = [];
  DB.champions.forEach((c, i) => {
    const s = state.get(c.key);
    if (s === 1) reqIdx.push(i);
    else if (s === 2 || isGroupExcluded(c)) return;
    else if (costOn.has(c.cost)) poolIdx.push(i);
  });
  const tkeys = Object.keys(DB.traits);
  return {
    size, maxWaste: +$('waste').value, reqIdx, poolIdx, emblems: [...emblems],
    reqTraits: reqTraits.map(r => ({ t: tkeys.indexOf(r.key), n: r.n }))
                        .filter(r => r.t >= 0),
    muted: [...muted].map(k => tkeys.indexOf(k)).filter(t => t >= 0),
    sortMode: $('sort').value, sortMode2: $('sort2').value,
    effort,
    timeBudgetMs: settings.timeBudgetMs,
    limit: 100, uniq: true,
    // The solver's cost is superlinear in rows returned (each no-good cut makes
    // the next solve harder), so we ask it for a small proven frontier and let
    // the DFS supply the tail. Measured: row 1 ~100-400ms, row 8 ~1-2s.
    solverRows: 8,
    solverBudgetMs: settings.timeBudgetMs ? Math.max(1500, settings.timeBudgetMs) : 5000,
    // Each shard's top 100 unique signatures are sufficient to recover the
    // global top 100; retained signatures carry their best found alternates.
    returnN: 100,
    shards: Math.min(NW, settings.workers),
  };
}

function dispatchSearch(generation, opts, key) {
  if (generation !== searchGeneration || !workersReady) return;
  pending = true;
  inbox = [];
  shardProgress = new Map();
  cancelProgressRender();
  solverBest = null;
  solverInbox = null;
  $('status').textContent = 'searching…';
  const id = ++reqId;
  activeSearch = { generation, key, opts };
  recordMetric('workerRuns');
  W.forEach((worker, shard) =>
    worker.postMessage({ type: 'search', id, opts: { ...opts, shard } }));
  ensureSolver();
  if (solverWorker && !solverBroken) {
    solverWorker.postMessage({ type: 'search', id, opts });
  }
}

async function executeSearch(generation) {
  if (!dataReady || generation !== searchGeneration) return;
  recordMetric('requests');
  void syncSearchUrl(generation);
  const opts = buildSearchOptions();
  const version = `${algorithmVersion}:${DB.builtAt || DB.gameBuild || DB.set}`;
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

  ensureWorkers(opts.shards, () => dispatchSearch(generation, opts, key));
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
const PREVIEW_ICON = `<svg class="previewicon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
  <rect x="2.5" y="3.5" width="15" height="13" rx="2"/>
  <circle cx="7" cy="8" r="1.5"/>
  <path d="m4.5 14 4-4 2.8 2.8 1.7-1.7 2.5 2.9"/>
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
  return `<span class="uc k${c.cost}${req}" data-key="${c.key}" ` +
    `title="${c.name} — click to ${req ? 'clear requirement' : 'require'}">` +
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

function variantTagMarkup(r) {
  const count = (r.variants || []).length;
  return count
    ? `<button type="button" class="vtag" aria-expanded="false" data-count="${count}" ` +
      `aria-label="Show ${count} alternate composition${count > 1 ? 's' : ''}" ` +
      `title="Same traits and counts, different units">${count} alternate${count > 1 ? 's' : ''}` +
      `<i class="vchev" aria-hidden="true"></i></button>`
    : '';
}

function variantRowsMarkup(r) {
  return (r.variants || []).length
    ? `<div class="vlist">` + r.variants.map(v =>
      `<div class="comprow alternate">` + v.units.map(i => DB.champions[i])
        .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
        .map(unitPortrait)
        .join('') +
      teamProfile(v.units, true) +
      `<span class="vg" title="Assumes every unit at 2★ (3 copies)">${v.gold}g</span>` +
      copyCodeButton(v.units) + `</div>`).join('') + `</div>`
    : '';
}

function rowRenderKey(r) {
  const traitUi = [
    [...emblems].sort(),
    reqTraits.map(({ key, n }) => [key, n]).sort(([a], [b]) => a.localeCompare(b)),
    [...muted].sort(),
  ];
  return JSON.stringify([
    r.live, r.uniqN, r.waste, r.tierSum, r.gold, r.slots,
    r.active, r.dead, r.over, traitUi, +$('size').value,
  ]);
}

function variantRenderKey(r) {
  return JSON.stringify((r.variants || []).map(variant => [
    compSignature(variant.units), variant.gold,
  ]));
}

function elementFromMarkup(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

// Build one board card for both lists. Only the selected section exposes the
// control that chooses which pinned comp appears in shared-link previews.
function compCard(r, { selected = false, showPreview = false } = {}) {
  const embCount = {};
  emblems.forEach(k => embCount[k] = (embCount[k] || 0) + 1);
  const tkeys = Object.keys(DB.traits);

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

  const deadN = (r.dead || []).length;
  const deadGroup = deadN
    ? `<span class="deadgrp"><i class="deadsum" aria-hidden="true">+${deadN} partial</i>${deadBadges}</span>`
    : '';

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
  const profile = teamProfile(r.units, true);
  const occupiedSlots = r.slots ?? r.units.length;
  const slotMeta = occupiedSlots !== +$('size').value || occupiedSlots !== r.units.length
    ? `<span class="slots" title="Occupied team slots">${occupiedSlots} slots</span>`
    : '';

  // Same trait signature, different roster. Offered per-board instead of as a
  // global toggle, because the question is "swap THIS board", not "show me
  // every permutation of everything".
  const varTag = variantTagMarkup(r);
  const varRows = variantRowsMarkup(r);

  const signature = compSignature(r.units);
  const featured = showPreview && selectedComps.keys().next().value === signature;
  const previewButton = showPreview
    ? `<button type="button" class="previewcomp" data-sig="${signature}" ` +
      `aria-pressed="${featured}" data-tip="${featured ? 'Discord preview comp' : 'Use for Discord preview'}" ` +
      `aria-label="${featured ? 'This comp is featured in the Discord preview' : 'Use this comp for the Discord preview'}">${PREVIEW_ICON}</button>`
    : '';
  const pinButton = `<button type="button" class="pincomp" data-sig="${signature}" ` +
    `aria-pressed="${selected}" ` +
    `data-tip="${selected ? 'Remove from selected' : 'Select this comp'}" ` +
    `aria-label="${selected ? 'Remove this comp from the selected section' : 'Select this comp and pin it above the results'}"></button>`;

  const d = document.createElement('div');
  d.className = 'comp' + (selected ? ' selected' : '');
  d.dataset.sig = signature;
  d.dataset.rowKey = rowRenderKey(r);
  d.dataset.variantKey = variantRenderKey(r);
  // Stash the row on the node: pinning needs the full scored board, and
  // re-deriving it from the DOM would mean a second scoring implementation.
  d.__row = r;
  d.innerHTML =
    `<div class="comphead"><div class="tline">${badges}${deadGroup}</div>` +
    `<div class="score"><span class="active"><b>${r.live}</b> traits active</span>` +
    (r.uniqN ? `<span class="unique">+${r.uniqN} unique</span>` : '') +
    `<span class="w"><b>${r.waste}</b> wasted</span>${slotMeta}</div></div>` +
    `<div class="comprow primary">${units}${varTag}</div>` +
    `<div class="compfoot">${profile}` +
    `<span class="vg" title="Assumes every unit at 2★ (3 copies)">${r.gold}g</span>` +
    copyCodeButton(r.units) + previewButton + pinButton + `</div>` +
    varRows;
  return d;
}

function syncPinState(card, selected) {
  card.classList.toggle('selected', selected);
  const button = card.querySelector('.pincomp');
  if (!button) return;
  button.setAttribute('aria-pressed', String(selected));
  button.dataset.tip = selected ? 'Remove from selected' : 'Select this comp';
  button.setAttribute('aria-label', selected
    ? 'Remove this comp from the selected section'
    : 'Select this comp and pin it above the results');
}

function syncRequiredPortraits(card) {
  for (const portrait of card.querySelectorAll('.uc[data-key]')) {
    portrait.classList.toggle('req', state.get(portrait.dataset.key) === 1);
  }
}

function syncVariants(card, row) {
  const key = variantRenderKey(row);
  if (card.dataset.variantKey === key) return;
  const open = card.classList.contains('vopen');
  const oldTag = card.querySelector('.vtag');
  const oldList = [...card.children].find(child => child.classList.contains('vlist'));
  const tagMarkup = variantTagMarkup(row);
  const rowsMarkup = variantRowsMarkup(row);

  if (tagMarkup) {
    const tag = elementFromMarkup(tagMarkup);
    if (open) {
      tag.setAttribute('aria-expanded', 'true');
      tag.setAttribute('aria-label',
        `Hide ${tag.dataset.count} alternate composition${tag.dataset.count === '1' ? '' : 's'}`);
    }
    if (oldTag) oldTag.replaceWith(tag);
    else card.querySelector('.comprow.primary').appendChild(tag);
  } else if (oldTag) {
    oldTag.remove();
  }

  if (rowsMarkup) {
    const list = elementFromMarkup(rowsMarkup);
    if (oldList) oldList.replaceWith(list);
    else card.appendChild(list);
  } else if (oldList) {
    oldList.remove();
  }
  card.classList.toggle('vopen', open && Boolean(rowsMarkup));
  card.dataset.variantKey = key;
}

function updateResultCard(card, row, selected) {
  if (!card || card.dataset.rowKey !== rowRenderKey(row)) {
    const replacement = compCard(row, { selected });
    if (!card) {
      replacement.classList.add('entering');
      replacement.addEventListener('animationend',
        () => replacement.classList.remove('entering'), { once: true });
    }
    return replacement;
  }
  card.__row = row;
  syncPinState(card, selected);
  syncRequiredPortraits(card);
  syncVariants(card, row);
  return card;
}

function reconcileResultCards(rows) {
  const list = $('list');
  const existing = new Map(
    [...list.children].filter(child => child.classList.contains('comp'))
      .map(card => [card.dataset.sig, card]));
  const stale = new Set(list.children);
  let cursor = list.firstElementChild;

  for (const row of rows) {
    const signature = compSignature(row.units);
    const card = updateResultCard(
      existing.get(signature), row, selectedComps.has(signature));
    stale.delete(card);
    if (card === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(card, cursor);
  }
  for (const node of stale) node.remove();
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

  reconcileResultCards(m.rows);
  if (!m.partial) renderSelectedComps();
}

// The selected section sits above the results and survives re-searching: these
// are boards the user deliberately set aside to compare or share, so a slider
// nudge must not throw them away.
function renderSelectedComps() {
  const host = $('selected');
  if (!host) return;
  if (!selectedComps.size && !selectedRestoreNotice) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const frag = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'selhead';
  head.innerHTML = `<h2>SELECTED <span class="tag">${selectedComps.size}</span></h2>` +
    `<button type="button" class="clearsel">Clear</button>`;
  frag.appendChild(head);
  if (selectedRestoreNotice) {
    const notice = document.createElement('p');
    notice.className = 'selnotice';
    notice.textContent = selectedRestoreNotice;
    frag.appendChild(notice);
  }
  for (const r of selectedComps.values()) {
    frag.appendChild(compCard(r, { selected: true, showPreview: true }));
  }
  host.innerHTML = '';
  host.appendChild(frag);
}

// Click any trait badge in the results to pin it as a requirement at that count.
// Bound to both containers so a selected comp behaves exactly like a result row.
function onCompClick(e) {
  // Expand the collapsed "+N partial" trait chip (mobile only; the group is
  // display:contents on desktop so the badges are always visible there).
  const deadsum = e.target.closest('.deadsum');
  if (deadsum) {
    const grp = deadsum.closest('.deadgrp');
    if (grp) grp.classList.toggle('open');
    return;
  }
  const preview = e.target.closest('.previewcomp');
  if (preview) {
    if (moveSelectionFirst(selectedComps, preview.dataset.sig)) syncSelectedState();
    return;
  }
  // Select / deselect. Held in memory as the whole row, so the pinned card
  // needs no recompute and survives the next search unchanged.
  const pin = e.target.closest('.pincomp');
  if (pin) {
    const sig = pin.dataset.sig;
    const card = pin.closest('.comp');
    toggleSelection(selectedComps, sig, card && card.__row);
    syncSelectedState();
    return;
  }
  if (e.target.closest('.clearsel')) {
    selectedComps.clear();
    selectedRestoreNotice = '';
    syncSelectedState();
    return;
  }
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
  const unit = e.target.closest('.uc[data-key]');
  if (unit) {
    if (isTouch()) openSheet(unitCard(unit.dataset.key), 'unit', unit.dataset.key);
    else setUnitState(unit.dataset.key, state.get(unit.dataset.key) === 1 ? 0 : 1);
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
}

$('list').addEventListener('click', onCompClick);
$('selected').addEventListener('click', onCompClick);

// Re-render the selected section and flip the pin state on any matching result
// row, without rebuilding the whole results list.
function syncSelectedState() {
  renderSelectedComps();
  if (selectedComps.size) warmShareApi();
  for (const card of $('list').querySelectorAll('.comp[data-sig]')) {
    const on = selectedComps.has(card.dataset.sig);
    card.classList.toggle('selected', on);
    card.querySelector('.previewcomp')?.remove();
    const button = card.querySelector('.pincomp');
    if (!button) continue;
    button.setAttribute('aria-pressed', String(on));
    button.dataset.tip = on ? 'Remove from selected' : 'Select this comp';
    button.setAttribute('aria-label', on
      ? 'Remove this comp from the selected section'
      : 'Select this comp and pin it above the results');
  }
  void syncSearchUrl(searchGeneration);
}

// Sticky sidebar offset must equal the real header height, or the panel slides
// a few px under it before locking. Measured, not hardcoded.
function syncHeaderVar() {
  const h = document.querySelector('header');
  if (h) document.documentElement.style.setProperty('--hdr', Math.round(h.getBoundingClientRect().height) + 'px');
}
syncHeaderVar();
addEventListener('resize', syncHeaderVar);
if (window.ResizeObserver) new ResizeObserver(syncHeaderVar).observe(document.querySelector('header'));
