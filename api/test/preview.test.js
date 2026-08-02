const assert = require('node:assert/strict');
const test = require('node:test');

const { shareHandler } = require('../src/functions/share.js');
const { ogHandler } = require('../src/functions/og.js');
const { shareHtml, validToken } = require('../src/lib/preview.js');

function request(token, method = 'GET') {
  return {
    method,
    params: { token },
    url: `https://preview.example.test/api/share/${token || ''}`,
    headers: new Headers({ host: 'preview.example.test', 'x-forwarded-proto': 'https' }),
  };
}

test('share HTML contains server-rendered metadata and a safe app redirect', async () => {
  const result = await shareHandler(request('rYWJj'));
  assert.equal(result.status, 200);
  assert.match(result.body, /property="og:image"/);
  assert.match(result.body, /https:\/\/preview\.example\.test\/api\/og\/rYWJj/);
  assert.match(result.body, /location\.replace\("\/traits\/\?s=rYWJj"\)/);
  assert.match(result.body, /noindex,nofollow/);
});

test('public metadata uses the Static Web Apps origin', async () => {
  const req = request('rYWJj');
  req.headers.set(
    'x-ms-original-url',
    'https://preview-host.azurestaticapps.net/api/share/rYWJj');
  const result = await shareHandler(req);
  assert.match(result.body,
    /https:\/\/preview-host\.azurestaticapps\.net\/api\/og\/rYWJj/);
  assert.doesNotMatch(result.body, /azurewebsites\.net/);
});

test('share HTML escapes reflected values', () => {
  const html = shareHtml('https://example.test', 'rYWJj');
  assert.doesNotMatch(html, /<script[^>]*>.*rYWJj.*<\/script>.*<script/s);
});

test('share endpoints reject malformed and oversized tokens', async () => {
  assert.equal(validToken('rYWJj'), true);
  assert.equal(validToken('r!bad'), false);
  assert.equal(validToken('r' + 'a'.repeat(2048)), false);
  assert.equal((await shareHandler(request('r!bad'))).status, 400);
  assert.equal((await ogHandler(request('r!bad'))).status, 400);
});

test('OG endpoint returns a 1200x630 PNG', { timeout: 30000 }, async () => {
  const result = await ogHandler(request('rYWJj'));
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  const png = Buffer.from(result.body);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300000);
});
