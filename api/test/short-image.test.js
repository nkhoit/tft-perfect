const assert = require('node:assert/strict');
const test = require('node:test');

const { shortImageHandler } = require('../src/functions/short-image.js');
const { clearMemoryCache } = require('../src/lib/preview-cache.js');
const { PREVIEW_ROUTE_VERSION } = require('../src/lib/preview-state.js');
const { saveToken } = require('../src/lib/short-links.js');

const token = state => 'r' + Buffer.from(JSON.stringify(state)).toString('base64url');
const selectedToken = token({ v: 2, l: 2, sel: [['Shen', 'Teemo']] });

function shareStore() {
  const rows = new Map();
  return {
    async create(row) { rows.set(row.id, row); },
    async get(id) { return rows.get(id) || null; },
  };
}

function imageOptions() {
  const rows = new Map();
  const options = {
    gets: 0,
    store: {
      async get(key) {
        options.gets++;
        return rows.get(key) || null;
      },
      async put(key, body) { rows.set(key, Buffer.from(body)); },
    },
    render: async () => Buffer.from('PNG body'),
  };
  return options;
}

function request(id, version = PREVIEW_ROUTE_VERSION, method = 'GET') {
  return {
    method,
    params: { id, version },
    headers: new Headers(),
  };
}

const context = { error() {}, warn() {} };

test.beforeEach(() => clearMemoryCache());

test('short image route resolves IDs and returns immutable cached PNGs', async () => {
  const shares = shareStore();
  const { id } = await saveToken(selectedToken, shares);
  const images = imageOptions();
  const result = await shortImageHandler(request(id), context, shares, images);
  const conditional = request(id);
  conditional.headers.set('if-none-match', result.headers.etag);
  const notModified = await shortImageHandler(
    conditional, context, shares, images);
  const head = await shortImageHandler(
    request(id, PREVIEW_ROUTE_VERSION, 'HEAD'), context, shares, images);

  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(Buffer.from(result.body).toString(), 'PNG body');
  assert.match(result.headers.etag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal(notModified.status, 304);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(images.gets, 1);
});

test('short image route preserves old valid versions and rejects missing IDs', async () => {
  const shares = shareStore();
  const { id } = await saveToken(selectedToken, shares);
  const oldVersion = await shortImageHandler(
    request(id, 'p0-AAAAAAAAAA'), context, shares, imageOptions());
  const missing = await shortImageHandler(
    request('A'.repeat(12)), context, shares, imageOptions());

  assert.equal(oldVersion.status, 200);
  assert.equal(missing.status, 404);
});
