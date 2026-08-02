const { app } = require('@azure/functions');
const { fallbackPng } = require('../lib/preview.js');
const { cachedPreviewPng } = require('../lib/preview-cache.js');
const { decodeToken, validToken } = require('../lib/share-codec.js');
const { etag, previewState } = require('../lib/preview-state.js');

const renderedEtags = new Set();

function rememberEtag(tag) {
  renderedEtags.delete(tag);
  renderedEtags.add(tag);
  while (renderedEtags.size > 100) renderedEtags.delete(renderedEtags.values().next().value);
}

async function previewImageResponse(
  request,
  token,
  preview,
  context,
  cacheControl = 'public, max-age=300',
  cacheOptions = {},
) {
  const tag = etag(token);
  if (request.headers.get('if-none-match') === tag && renderedEtags.has(tag)) {
    return { status: 304, headers: { etag: tag } };
  }
  let body;
  try {
    body = await cachedPreviewPng(token, preview, {
      ...cacheOptions,
      onCacheError(error) {
        cacheOptions.onCacheError?.(error);
        context?.warn?.('Preview image cache unavailable.', error);
      },
    });
  } catch (error) {
    context?.error?.('Could not render preview image.', error);
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
      'cache-control': cacheControl,
      etag: tag,
    },
    body: request.method === 'HEAD' ? null : body,
  };
}

async function ogHandler(request, context) {
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
  return previewImageResponse(request, token, preview, context);
}

app.http('og', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'og/{token}',
  handler: ogHandler,
});

module.exports = { ogHandler, previewImageResponse };
