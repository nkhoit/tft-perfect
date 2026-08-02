const assert = require('node:assert/strict');
const test = require('node:test');

const { prewarmHandler } = require('../src/functions/prewarm.js');
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
    renders: 0,
    store: {
      rows,
      async acquire() {
        return { async release() {} };
      },
      async get(key) { return rows.get(key) || null; },
      async put(key, body) { rows.set(key, Buffer.from(body)); },
    },
    async render() {
      options.renders++;
      return Buffer.from('PNG body');
    },
  };
  return options;
}

function request(id) {
  return {
    method: 'POST',
    params: { id },
    headers: new Headers(),
  };
}

const context = { error() {}, warn() {} };

test.beforeEach(() => clearMemoryCache());

test('prewarm endpoint renders and stores a short-link image', async () => {
  const shares = shareStore();
  const images = imageOptions();
  const { id } = await saveToken(selectedToken, shares);
  const result = await prewarmHandler(request(id), context, shares, images);

  assert.equal(result.status, 204);
  assert.equal(images.renders, 1);
  assert.equal(images.store.rows.size, 1);
  assert.ok(images.store.rows.has(`${PREVIEW_ROUTE_VERSION}/${id}.png`));
});

test('prewarm endpoint rejects unknown short links', async () => {
  const result = await prewarmHandler(
    request('A'.repeat(12)), context, shareStore(), imageOptions());
  assert.equal(result.status, 404);
});

test('prewarm contenders return immediately when another render owns the lease', async () => {
  const shares = shareStore();
  const { id } = await saveToken(selectedToken, shares);
  const images = imageOptions();
  images.store.acquire = async () => null;
  const result = await prewarmHandler(request(id), context, shares, images);

  assert.equal(result.status, 202);
  assert.equal(images.renders, 0);
});

test('prewarmed bytes are reused by the short image route', async () => {
  clearMemoryCache();
  const shares = shareStore();
  const images = imageOptions();
  const { id } = await saveToken(selectedToken, shares);
  assert.equal(
    (await prewarmHandler(request(id), context, shares, images)).status,
    204);
  clearMemoryCache();

  const image = await shortImageHandler({
    method: 'GET',
    params: { version: PREVIEW_ROUTE_VERSION, id },
    headers: new Headers(),
  }, context, shares, images);

  assert.equal(image.status, 200);
  assert.equal(Buffer.from(image.body).toString(), 'PNG body');
  assert.equal(images.renders, 1);
});
