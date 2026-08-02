(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SavedSearches = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const STORAGE_KEY = 'tft-saved-searches-v1';
  const LIMIT = 20;

  function validEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = typeof entry.id === 'string' ? entry.id.slice(0, 100) : '';
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 60) : '';
    const token = typeof entry.token === 'string' ? entry.token : '';
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
    if (!id || !name || token.length < 2 || token.length > 12000
        || !/^[A-Za-z0-9_-]+$/.test(token) || updatedAt <= 0) return null;
    return { id, name, token, updatedAt };
  }

  function normalize(entries) {
    if (!Array.isArray(entries)) throw new Error('Saved searches are corrupted.');
    const seenTokens = new Set(), seenIds = new Set();
    return entries.map(validEntry).filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(entry => {
        if (seenTokens.has(entry.token) || seenIds.has(entry.id)) return false;
        seenTokens.add(entry.token);
        seenIds.add(entry.id);
        return true;
      })
      .slice(0, LIMIT);
  }

  function load(storage) {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Saved searches are corrupted.');
    }
    return normalize(parsed);
  }

  function persist(storage, entries) {
    const normalized = normalize(entries);
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function upsert(storage, search, now = Date.now()) {
    const entries = load(storage);
    const previous = entries.find(entry => entry.token === search.token);
    const entry = validEntry({
      id: previous?.id || createId(),
      name: search.name,
      token: search.token,
      updatedAt: now,
    });
    if (!entry) throw new Error('Invalid saved search.');
    return persist(storage, [entry, ...entries.filter(item => item.id !== entry.id)]);
  }

  function remove(storage, id) {
    return persist(storage, load(storage).filter(entry => entry.id !== id));
  }

  return { LIMIT, STORAGE_KEY, load, remove, upsert };
});
