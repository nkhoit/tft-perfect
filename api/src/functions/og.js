const { app } = require('@azure/functions');
const { fallbackPng, previewPng } = require('../lib/preview.js');
const { decodeToken, validToken } = require('../lib/share-codec.js');
const { etag, previewState } = require('../lib/preview-state.js');

const renderedEtags = new Set();

function rememberEtag(tag) {
  renderedEtags.delete(tag);
  renderedEtags.add(tag);
  while (renderedEtags.size > 100) renderedEtags.delete(renderedEtags.values().next().value);
}

async function ogHandler(request) {
  const token = request.params.token;
  if (!validToken(token)) {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Invalid shared composition.',
    };
  }
  let preview;
  try {
    preview = previewState(decodeToken(token));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Invalid shared composition.',
    };
  }
  const tag = etag(token);
  if (request.headers.get('if-none-match') === tag && renderedEtags.has(tag)) {
    return { status: 304, headers: { etag: tag } };
  }
  let body;
  try {
    body = await previewPng(preview);
  } catch (error) {
    return {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
      },
      body: request.method === 'HEAD' ? null : fallbackPng(),
    };
  }
  rememberEtag(tag);
  return {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300',
      etag: tag,
    },
    body: request.method === 'HEAD' ? null : body,
  };
}

app.http('og', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'og/{token}',
  handler: ogHandler,
});

module.exports = { ogHandler };
