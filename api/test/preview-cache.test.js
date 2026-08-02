const assert = require('node:assert/strict');
const test = require('node:test');

const {
  cachedPreviewPng,
  clearMemoryCache,
  previewCacheKey,
  shortPreviewCacheKey,
} = require('../src/lib/preview-cache.js');

function memoryStore(initial = []) {
  const rows = new Map(initial);
  return {
    gets: 0,
    puts: 0,
    rows,
    async get(key) {
      this.gets++;
      return rows.get(key) || null;
    },
    async put(key, body) {
      this.puts++;
      if (!rows.has(key)) rows.set(key, Buffer.from(body));
    },
  };
}

test.beforeEach(() => clearMemoryCache());

test('short preview cache keys use the content-addressed share ID', () => {
  assert.match(shortPreviewCacheKey('A'.repeat(12)),
    /^p[0-9]+-[A-Za-z0-9_-]{10}\/A{12}\.png$/);
});

test('durable cache hits skip preview rendering', async () => {
  const token = 'r-cache-hit';
  const key = previewCacheKey(token);
  const store = memoryStore([[key, Buffer.from('cached')]]);
  let renders = 0;

  const body = await cachedPreviewPng(token, {}, {
    store,
    render: async () => {
      renders++;
      return Buffer.from('rendered');
    },
  });

  assert.equal(body.toString(), 'cached');
  assert.equal(renders, 0);
  assert.equal(store.gets, 1);
  assert.equal(store.puts, 0);
});

test('cache misses render and persist only once per warm instance', async () => {
  const token = 'r-cache-miss';
  const store = memoryStore();
  let renders = 0;
  const options = {
    store,
    render: async () => {
      renders++;
      return Buffer.from('rendered');
    },
  };

  const [first, concurrent] = await Promise.all([
    cachedPreviewPng(token, {}, options),
    cachedPreviewPng(token, {}, options),
  ]);
  const warm = await cachedPreviewPng(token, {}, options);

  assert.equal(first.toString(), 'rendered');
  assert.equal(concurrent.toString(), 'rendered');
  assert.equal(warm.toString(), 'rendered');
  assert.equal(renders, 1);
  assert.equal(store.puts, 1);
});

test('cache failures are surfaced while rendering still succeeds', async () => {
  const failures = [];
  const store = {
    async get() { throw new Error('Blob read failed'); },
    async put() { throw new Error('Blob write failed'); },
  };

  const body = await cachedPreviewPng('r-cache-error', {}, {
    store,
    render: async () => Buffer.from('rendered'),
    onCacheError: error => failures.push(error.message),
  });

  assert.equal(body.toString(), 'rendered');
  assert.deepEqual(failures, ['Blob read failed', 'Blob write failed']);
});

test('cache write failures do not discard a rendered preview', async () => {
  const failures = [];
  const store = {
    async get() { return null; },
    async put() { throw new Error('Blob write failed'); },
  };

  const body = await cachedPreviewPng('r-cache-write-error', {}, {
    store,
    render: async () => Buffer.from('rendered'),
    onCacheError: error => failures.push(error.message),
  });

  assert.equal(body.toString(), 'rendered');
  assert.deepEqual(failures, ['Blob write failed']);
});

test('warm cache evicts the least recently used image', async () => {
  const rows = Array.from({ length: 17 }, (_, index) => {
    const token = `r-eviction-${index}`;
    return [previewCacheKey(token), Buffer.from(String(index))];
  });
  const store = memoryStore(rows);
  for (let index = 0; index < 17; index++) {
    await cachedPreviewPng(`r-eviction-${index}`, {}, { store });
  }
  const readsBefore = store.gets;
  const first = await cachedPreviewPng('r-eviction-0', {}, { store });

  assert.equal(first.toString(), '0');
  assert.equal(store.gets, readsBefore + 1);
});
