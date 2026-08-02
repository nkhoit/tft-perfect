const assert = require('node:assert/strict');
const test = require('node:test');

const { readyHandler } = require('../src/functions/ready.js');

test('ready endpoint warms the Function app without caching', async () => {
  const result = await readyHandler();
  assert.equal(result.status, 204);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body, null);
});
