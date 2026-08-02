const fs = require('node:fs');

const WIDTH = 1200;
const HEIGHT = 630;
const TOKEN = /^[A-Za-z0-9_-]{2,2048}$/;

let rendererPromise = null;

function validToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function publicOrigin(request) {
  const originalUrl = request.headers.get('x-ms-original-url');
  if (originalUrl) {
    try {
      const parsed = new URL(originalUrl);
      if (['http:', 'https:'].includes(parsed.protocol)
          && /^[A-Za-z0-9.:[\]-]+$/.test(parsed.host)) {
        return parsed.origin;
      }
    } catch {
      // Fall through to forwarded headers.
    }
  }
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost || request.headers.get('host');
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return 'https://tftkit.com';
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const requestProto = (() => {
    try { return new URL(request.url).protocol.slice(0, -1); } catch { return null; }
  })();
  const proto = forwardedProto === 'http' || requestProto === 'http' ? 'http' : 'https';
  return `${proto}://${host}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function shareHtml(origin, token) {
  const escapedOrigin = escapeHtml(origin);
  const escapedToken = escapeHtml(token);
  const appUrl = `${escapedOrigin}/traits/?s=${escapedToken}`;
  const imageUrl = `${escapedOrigin}/api/og/${escapedToken}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#4ade80">
<meta property="og:site_name" content="TFTKIT">
<meta property="og:type" content="website">
<meta property="og:title" content="TFT Trait Explorer composition">
<meta property="og:description" content="Open this shared TFT search and selected composition.">
<meta property="og:url" content="${escapedOrigin}/api/share/${escapedToken}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${WIDTH}">
<meta property="og:image:height" content="${HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<title>TFT Trait Explorer composition</title>
<noscript><meta http-equiv="refresh" content="0;url=${appUrl}"></noscript>
</head>
<body>
<p><a href="${appUrl}">Open this composition in TFTKIT</a></p>
<script>location.replace(${JSON.stringify(`/traits/?s=${token}`)});</script>
</body>
</html>`;
}

function previewTree() {
  const card = (name, cost, color) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', width: 116, height: 116, borderRadius: 14,
        border: `4px solid ${color}`, alignItems: 'center', justifyContent: 'center',
        background: '#1b2130', color: '#e6edf3', fontSize: 23, fontWeight: 700,
      },
      children: `${cost}★ ${name}`,
    },
  });
  return {
    type: 'div',
    props: {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        padding: 54, background: '#0b0e14', color: '#e6edf3',
        fontFamily: 'Inter', justifyContent: 'space-between',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
            children: [
              { type: 'div', props: { style: { fontSize: 48, fontWeight: 700 }, children: 'TFTKIT' } },
              { type: 'div', props: { style: { fontSize: 25, color: '#4ade80' }, children: 'Trait Explorer' } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: 18 },
            children: [
              { type: 'div', props: { style: { fontSize: 38, fontWeight: 700 }, children: 'Shared composition preview' } },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 16 },
                  children: [
                    card('Shen', 2, '#2dd4a7'),
                    card('Teemo', 2, '#2dd4a7'),
                    card('Karma', 1, '#9aa4b2'),
                    card('Ahri', 4, '#c084fc'),
                    card('Sett', 4, '#c084fc'),
                    card('Gnar', 5, '#fbbf24'),
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', gap: 18, color: '#8b97a8', fontSize: 24 },
            children: ['9 traits active', '•', '2 tanks', '•', 'Open to inspect the full search'],
          },
        },
      ],
    },
  };
}

async function renderer() {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const [{ default: satori }, resvg] = await Promise.all([
        import('satori'),
        import('@resvg/resvg-wasm'),
      ]);
      const wasm = fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await resvg.initWasm(wasm);
      const regular = fs.readFileSync(require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff'));
      const bold = fs.readFileSync(require.resolve('@fontsource/inter/files/inter-latin-700-normal.woff'));
      return { satori, Resvg: resvg.Resvg, fonts: [
        { name: 'Inter', data: regular, weight: 400, style: 'normal' },
        { name: 'Inter', data: bold, weight: 700, style: 'normal' },
      ] };
    })();
  }
  return rendererPromise;
}

async function previewPng() {
  const { satori, Resvg, fonts } = await renderer();
  const svg = await satori(previewTree(), { width: WIDTH, height: HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
}

module.exports = {
  HEIGHT,
  WIDTH,
  escapeHtml,
  previewPng,
  publicOrigin,
  shareHtml,
  validToken,
};
