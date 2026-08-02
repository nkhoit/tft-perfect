const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadToken,
  saveToken,
  tokenDigest,
  validShortId,
} = require('../src/lib/short-links.js');
const {
  shortenHandler,
  shortShareHandler,
} = require('../src/functions/short-links.js');

const token = state => 'r' + Buffer.from(JSON.stringify(state)).toString('base64url');
const selectedToken = token({ v: 2, l: 2, sel: [['Shen', 'Teemo']] });

function memoryStore(initial = []) {
  const rows = new Map(initial.map(row => [row.id, row]));
  return {
    rows,
    async create(row) {
      if (rows.has(row.id)) {
        const error = new Error('Conflict');
        error.statusCode = 409;
        throw error;
      }
      rows.set(row.id, row);
    },
    async get(id) {
      return rows.get(id) || null;
    },
  };
}

function request({ body, id, method = 'GET', url = 'https://preview.example.test' }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    params: { id },
    url,
    headers: new Headers({
      host: 'preview.example.test',
      'content-length': String(Buffer.byteLength(raw)),
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    }),
    text: async () => raw,
  };
}

const context = { error() {} };

test('share tokens receive deterministic 12-character IDs', async () => {
  const store = memoryStore();
  const first = await saveToken(selectedToken, store);
  const second = await saveToken(selectedToken, store);

  assert.equal(first.id.length, 12);
  assert.equal(first.id, second.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(await loadToken(first.id, store), selectedToken);
  assert.equal(validShortId(first.id), true);
});

test('hash-prefix collisions expand the later ID', async () => {
  const digest = tokenDigest(selectedToken);
  const store = memoryStore([{
    id: digest.slice(0, 12),
    token: token({ v: 1, l: 8 }),
  }]);

  const saved = await saveToken(selectedToken, store);
  assert.equal(saved.id, digest.slice(0, 16));
  assert.equal(await loadToken(saved.id, store), selectedToken);
});

function concurrentStore(tokenAtFirstId) {
  const rows = new Map();
  let firstRead = true;
  return {
    async get(id) {
      if (id.length === 12) {
        if (firstRead) {
          firstRead = false;
          return null;
        }
        return { id, token: tokenAtFirstId };
      }
      return rows.get(id) || null;
    },
    async create(row) {
      if (row.id.length === 12) {
        const error = new Error('Conflict');
        error.statusCode = 409;
        throw error;
      }
      rows.set(row.id, row);
    },
  };
}

test('concurrent creation reuses an identical token', async () => {
  const saved = await saveToken(selectedToken, concurrentStore(selectedToken));
  assert.equal(saved.id, tokenDigest(selectedToken).slice(0, 12));
  assert.equal(saved.created, false);
});

test('concurrent creation widens an ID occupied by another token', async () => {
  const other = token({ v: 1, l: 8 });
  const saved = await saveToken(selectedToken, concurrentStore(other));
  assert.equal(saved.id, tokenDigest(selectedToken).slice(0, 16));
  assert.equal(saved.created, true);
});

test('shorten endpoint validates and stores share tokens', async () => {
  const store = memoryStore();
  const result = await shortenHandler(request({
    method: 'POST',
    url: 'https://preview.example.test/api/shorten',
    body: { token: selectedToken },
  }), context, store);
  const payload = JSON.parse(result.body);

  assert.equal(result.status, 201);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(payload.id, /^[A-Za-z0-9_-]{12}$/);
});

test('short share endpoint serves metadata and restores the long token', async () => {
  const store = memoryStore();
  const { id } = await saveToken(selectedToken, store);
  const result = await shortShareHandler(request({
    id,
    url: `https://preview.example.test/api/s/${id}`,
  }), context, store);

  assert.equal(result.status, 200);
  assert.match(result.body, new RegExp(`property="og:url" content="https:\\/\\/preview\\.example\\.test\\/api\\/s\\/${id}"`));
  assert.match(result.body, new RegExp(`https:\\/\\/preview\\.example\\.test\\/api\\/og\\/${selectedToken}`));
  assert.match(result.body, new RegExp(`location\\.replace\\("\\/traits\\/\\?s=${selectedToken}"\\)`));
  assert.match(result.body, /Shen, Teemo/);
});

test('short-link endpoints reject invalid and missing records', async () => {
  const store = memoryStore();
  const invalidToken = await shortenHandler(request({
    method: 'POST',
    body: { token: 'r!bad' },
  }), context, store);
  const invalidId = await shortShareHandler(request({ id: 'bad' }), context, store);
  const missing = await shortShareHandler(request({ id: 'A'.repeat(12) }), context, store);

  assert.equal(invalidToken.status, 400);
  assert.equal(invalidId.status, 400);
  assert.equal(missing.status, 404);
});

test('shorten endpoint rejects oversized bodies before parsing', async () => {
  const result = await shortenHandler(request({
    method: 'POST',
    body: { token: 'r' + 'a'.repeat(5000) },
  }), context, memoryStore());
  assert.equal(result.status, 413);
});

test('shorten endpoint reports unavailable storage explicitly', async () => {
  const previous = process.env.SHARE_STORAGE_CONNECTION_STRING;
  delete process.env.SHARE_STORAGE_CONNECTION_STRING;
  try {
    const result = await shortenHandler(request({
      method: 'POST',
      body: { token: selectedToken },
    }), context);
    assert.equal(result.status, 503);
    assert.match(result.body, /temporarily unavailable/);
  } finally {
    if (previous === undefined) delete process.env.SHARE_STORAGE_CONNECTION_STRING;
    else process.env.SHARE_STORAGE_CONNECTION_STRING = previous;
  }
});
