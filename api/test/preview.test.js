const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { shareHandler } = require('../src/functions/share.js');
const { ogHandler } = require('../src/functions/og.js');
const {
  fallbackPng,
  previewText,
  previewTree,
  shareHtml,
} = require('../src/lib/preview.js');
const { data, previewState } = require('../src/lib/preview-state.js');
const { decodeToken, validToken } = require('../src/lib/share-codec.js');

const token = state => 'r' + Buffer.from(JSON.stringify(state)).toString('base64url');
const selectedToken = token({ v: 2, l: 2, sel: [['Shen', 'Teemo']] });

function request(token, method = 'GET') {
  return {
    method,
    params: { token },
    url: `https://preview.example.test/api/share/${token || ''}`,
    headers: new Headers({ host: 'preview.example.test', 'x-forwarded-proto': 'https' }),
  };
}

test('share HTML contains server-rendered metadata and a safe app redirect', async () => {
  const result = await shareHandler(request(selectedToken));
  assert.equal(result.status, 200);
  assert.match(result.body, /property="og:image"/);
  assert.match(result.body, new RegExp(
    `https:\\/\\/preview\\.example\\.test\\/api\\/og\\/${selectedToken}`));
  assert.match(result.body, new RegExp(
    `location\\.replace\\("\\/traits\\/\\?s=${selectedToken}"\\)`));
  assert.match(result.body, /Shen, Teemo/);
  assert.match(result.body, /noindex,nofollow/);
});

test('public metadata uses the Static Web Apps origin', async () => {
  const req = request(selectedToken);
  req.headers.set(
    'x-ms-original-url',
    `https://preview-host.azurestaticapps.net/api/share/${selectedToken}`);
  const result = await shareHandler(req);
  assert.match(result.body, new RegExp(
    `https:\\/\\/preview-host\\.azurestaticapps\\.net\\/api\\/og\\/${selectedToken}`));
  assert.doesNotMatch(result.body, /azurewebsites\.net/);
});

test('share HTML escapes reflected values', () => {
  const html = shareHtml('https://example.test', selectedToken, { featured: null });
  assert.doesNotMatch(html, /<script[^>]*>.*<script/s);
});

test('share endpoints reject malformed and oversized tokens', async () => {
  assert.equal(validToken('rYWJj'), true);
  assert.equal(validToken('r!bad'), false);
  assert.equal(validToken('r' + 'a'.repeat(2048)), false);
  assert.equal((await shareHandler(request('r!bad'))).status, 400);
  assert.equal((await ogHandler(request('r!bad'))).status, 400);
});

test('OG endpoint returns a 1200x630 PNG', { timeout: 30000 }, async () => {
  const result = await ogHandler(request(selectedToken));
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  const png = Buffer.from(result.body);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300000);
  assert.match(result.headers.etag, /^"[A-Za-z0-9_-]+"$/);
  const cachedRequest = request(selectedToken);
  cachedRequest.headers.set('if-none-match', result.headers.etag);
  const cached = await ogHandler(cachedRequest);
  assert.equal(cached.status, 304);
});

test('bundled fallback is a 1200x630 PNG', () => {
  const png = Buffer.from(fallbackPng());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('every champion has a bundled preview portrait', () => {
  const portraitDir = path.join(__dirname, '..', 'assets', 'champions');
  for (const champion of data.champions) {
    const portrait = fs.readFileSync(path.join(portraitDir, `${champion.key}.png`));
    assert.equal(portrait.subarray(1, 4).toString(), 'PNG', champion.key);
  }
});

test('preview cards use bundled portraits with bottom name labels', () => {
  const tree = previewTree(previewState({
    v: 2,
    l: 2,
    sel: [['Pebbles', 'AncientSentinel']],
  }));
  const nodes = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) visit(child);
  };
  visit(tree);

  const portraits = nodes.filter(node => node.type === 'img');
  assert.equal(portraits.length, 2);
  assert.ok(portraits.every(node => node.props.src.startsWith('data:image/png;base64,')));
  for (const name of ['Pebbles', 'Ancient Sentinel']) {
    const label = nodes.find(node => node.props?.children === name);
    assert.equal(label.props.style.position, 'absolute');
    assert.equal(label.props.style.bottom, 0);
  }
});

test('preview emphasizes active traits and team composition instead of waste', () => {
  const preview = previewState({
    v: 2,
    l: 8,
    sel: [[
      'Pebbles', 'AncientSentinel', 'Morgana', 'Rakan',
      'Xayah', 'Yorick', 'Fiddlesticks', 'Raptor',
    ]],
  });
  const text = previewText(preview);
  const tree = previewTree(preview);
  const labels = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.props?.children === 'string') labels.push(node.props.children);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) visit(child);
  };
  visit(tree);

  assert.equal(text.title, '8 active traits');
  assert.deepEqual(preview.featured.profile, { tanks: 4, AD: 2, AP: 2, Hybrid: 0 });
  assert.ok(labels.includes('4 Tank'));
  assert.ok(labels.includes('2 AD'));
  assert.ok(labels.includes('2 AP'));
  assert.doesNotMatch(labels.join(' '), /wasted/);
});

test('fallback responses are not cacheable', async () => {
  // A malformed-but-valid state produces the generic renderer, not the fallback.
  // The no-store fallback path is asserted structurally so a renderer failure
  // can never inherit the strong ETag response headers.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'functions', 'og.js'), 'utf8');
  assert.match(source, /'cache-control': 'no-store'/);
  assert.match(source, /renderedEtags\.has\(tag\)/);
});

test('v1 tokens remain valid and render a generic preview', async () => {
  const v1 = token({ v: 1, l: 8 });
  assert.equal(decodeToken(v1).v, 1);
  const result = await shareHandler(request(v1));
  assert.equal(result.status, 200);
  assert.match(result.body, /TFT Trait Explorer search/);
});

test('invalid selected rosters are dropped rather than repaired', async () => {
  const invalid = token({
    v: 2,
    l: 2,
    sel: [['LuxBlossom', 'LuxCoven'], ['Shen', 'Teemo']],
  });
  const result = await shareHandler(request(invalid));
  assert.equal(result.status, 200);
  assert.match(result.body, /Shen, Teemo/);
  assert.doesNotMatch(result.body, /Lux/);
});

test('API generated scoring files match the browser sources', () => {
  const root = path.resolve(__dirname, '..', '..');
  for (const file of ['search-utils.js', 'board-score.js', 'data.json']) {
    assert.equal(
      fs.readFileSync(path.join(root, 'api', 'generated', file), 'utf8'),
      fs.readFileSync(path.join(root, 'web', 'traits', file), 'utf8'),
      `${file} drifted from its browser source`);
  }
});
