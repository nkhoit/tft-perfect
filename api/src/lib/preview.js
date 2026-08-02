const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 1200;
const HEIGHT = 630;
let rendererPromise = null;

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

function previewText(preview) {
  if (!preview.featured) {
    return {
      title: 'TFT Trait Explorer search',
      description: 'Open this shared TFT Trait Explorer search.',
    };
  }
  const row = preview.featured.row;
  return {
    title: `${row.live} active traits · ${row.waste} wasted`,
    description: preview.featured.champions.map(champion => champion.name).join(', '),
  };
}

function shareHtml(origin, token, preview) {
  const escapedOrigin = escapeHtml(origin);
  const escapedToken = escapeHtml(token);
  const text = previewText(preview);
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
<meta property="og:title" content="${escapeHtml(text.title)}">
<meta property="og:description" content="${escapeHtml(text.description)}">
<meta property="og:url" content="${escapedOrigin}/api/share/${escapedToken}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="${WIDTH}">
<meta property="og:image:height" content="${HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<title>${escapeHtml(text.title)} — TFTKIT</title>
<noscript><meta http-equiv="refresh" content="0;url=${appUrl}"></noscript>
</head>
<body>
<p><a href="${appUrl}">Open this composition in TFTKIT</a></p>
<script>location.replace(${JSON.stringify(`/traits/?s=${token}`)});</script>
</body>
</html>`;
}

function previewTree(preview) {
  const costColors = ['#9aa4b2', '#2dd4a7', '#60a5fa', '#c084fc', '#fbbf24'];
  const card = champion => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', width: 122, height: 122, borderRadius: 14,
        border: `4px solid ${costColors[champion.cost - 1] || '#9aa4b2'}`,
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        background: '#1b2130', color: '#e6edf3', fontSize: 18, fontWeight: 700,
        lineHeight: 1.1, overflow: 'hidden', wordBreak: 'break-word', padding: 8,
      },
      children: champion.name.replace(/([a-z])([A-Z])/g, '$1 $2'),
    },
  });
  const featured = preview.featured;
  const champions = featured?.champions || [];
  const traits = featured?.traits || [];
  const headline = featured
    ? `${featured.row.live} active traits · ${featured.row.waste} wasted`
    : 'Shared Trait Explorer search';
  const summary = featured
    ? `${featured.row.gold}g · Level ${preview.size}` +
      (preview.otherCount ? ` · +${preview.otherCount} other selected` : '')
    : 'Open to inspect the search and selected compositions';
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
              { type: 'div', props: { style: { fontSize: 38, fontWeight: 700 }, children: headline } },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 14 },
                  children: champions.slice(0, 8).map(card),
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 9, flexWrap: 'wrap' },
                  children: traits.map(trait => ({
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex', padding: '6px 12px', borderRadius: 16,
                        border: '1px solid #3d485a', background: '#131822',
                        color: '#c8d0dc', fontSize: 20,
                      },
                      children: `${trait.count} ${trait.name}`,
                    },
                  })),
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', gap: 18, color: '#8b97a8', fontSize: 24 },
            children: [summary],
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

async function previewPng(preview) {
  const { satori, Resvg, fonts } = await renderer();
  const svg = await satori(previewTree(preview), { width: WIDTH, height: HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
}

function fallbackPng() {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', 'assets', 'fallback.png'));
}

module.exports = {
  HEIGHT,
  WIDTH,
  escapeHtml,
  fallbackPng,
  previewPng,
  publicOrigin,
  shareHtml,
  previewText,
};
