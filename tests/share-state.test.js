const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const test = require('node:test');

const { decode, encode } = require('../web/share-state.js');

test('share state round-trips through a URL-safe token', async () => {
  const state = {
    v: 1,
    l: 9,
    w: 2,
    r: ['Shen', 'Teemo'],
    x: ['LuxCoven'],
    c: [1, 2, 3, 4],
    t: [['Invoker', 4], ['Riftbeast', 5]],
    m: ['Rival'],
    e: [['Invoker', 2]],
    s: ['tier', 'rich'],
  };

  const token = await encode(state);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decode(token), state);
});

test('share state rejects malformed payloads', async () => {
  await assert.rejects(decode('r!bad'), /invalid/i);
  await assert.rejects(decode('r' + Buffer.from('[]').toString('base64url')), /invalid/i);
});

test('share state bounds decompressed payloads', async () => {
  const compressed = deflateSync(JSON.stringify({ q: 'x'.repeat(300000) }));
  await assert.rejects(decode('z' + compressed.toString('base64url')), /too large/i);
});
