const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { decode, encode } = require('../web/traits/share-state.js');

test('encode rejects a raw token that would exceed the server limit', async () => {
  const heavy = { v: 2, q: 'x'.repeat(3000), x: Array.from({ length: 40 }, (_, i) => `Champion${i}`) };
  const orig = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    await assert.rejects(() => encode(heavy), /too large to share/i);
  } finally {
    globalThis.CompressionStream = orig;
  }
});

test('a modest state still encodes and round-trips', async () => {
  const state = { v: 2, l: 8, r: ['Akali'], c: [1, 2, 3] };
  const token = await encode(state);
  assert.ok(token.length <= 2049);
  assert.deepEqual(await decode(token), state);
});

test('decode rejects a token longer than MAX_TOKEN_CHARS', async () => {
  const longToken = 'r' + 'A'.repeat(2049);
  assert.equal(longToken.length, 2050);
  await assert.rejects(() => decode(longToken), /invalid/i);
});

test('client limits match api/src/lib/share-codec.js', () => {
  const apiSrc = fs.readFileSync(path.join(__dirname, '../api/src/lib/share-codec.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(__dirname, '../web/traits/share-state.js'), 'utf8');

  const apiBytesMatch = apiSrc.match(/MAX_DECODED_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(apiBytesMatch, 'api MAX_DECODED_BYTES not found');
  const apiBytes = Number(apiBytesMatch[1]) * Number(apiBytesMatch[2]);

  const webBytesMatch = webSrc.match(/MAX_DECODED_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/);
  assert.ok(webBytesMatch, 'web MAX_DECODED_BYTES not found');
  const webBytes = Number(webBytesMatch[1]) * Number(webBytesMatch[2]);
  assert.equal(webBytes, apiBytes);

  const apiTokenMatch = apiSrc.match(/TOKEN\s*=\s*\/\^.*\{2,(\d+)\}\$\//);
  assert.ok(apiTokenMatch, 'api TOKEN max not found');
  const apiMaxTokenChars = Number(apiTokenMatch[1]) + 1;

  const webTokenMatch = webSrc.match(/MAX_TOKEN_CHARS\s*=\s*(\d+)/);
  assert.ok(webTokenMatch, 'web MAX_TOKEN_CHARS not found');
  const webMax = Number(webTokenMatch[1]);
  assert.equal(webMax, apiMaxTokenChars);

  assert.match(webSrc, /MUST match api\/src\/lib\/share-codec\.js/);
});

test('encode rejection carries SHARE_TOO_LARGE code', async () => {
  const heavy = { v: 2, q: 'x'.repeat(3000), x: Array.from({ length: 40 }, (_, i) => `Champion${i}`) };
  const orig = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    await assert.rejects(async () => {
      try { await encode(heavy); } catch (error) {
        assert.equal(error.code, 'SHARE_TOO_LARGE');
        throw error;
      }
    }, /too large to share/i);
  } finally {
    globalThis.CompressionStream = orig;
  }
});

test('syncSearchUrl does not call window.alert on failure', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../web/traits/app.js'), 'utf8');
  const start = appSrc.indexOf('async function syncSearchUrl');
  assert.ok(start !== -1, 'syncSearchUrl not found');
  const nextFn = appSrc.indexOf('\nasync function restoreSharedSearch', start);
  const block = nextFn === -1 ? appSrc.slice(start) : appSrc.slice(start, nextFn);
  assert.doesNotMatch(block, /window\.alert/);
  assert.doesNotMatch(block, /\/too large to share\/i/);
  assert.match(block, /console\.error/);
});
