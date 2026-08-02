const { app } = require('@azure/functions');

const { previewImageResponse } = require('./og.js');
const { fallbackPng } = require('../lib/preview.js');
const { previewState } = require('../lib/preview-state.js');
const { decodeToken } = require('../lib/share-codec.js');
const {
  InvalidStoredTokenError,
  azureShareStore,
  loadToken,
  validShortId,
} = require('../lib/short-links.js');

function text(status, body) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
  };
}

function fallback(request) {
  return {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'no-store',
    },
    body: request.method === 'HEAD' ? null : fallbackPng(),
  };
}

async function shortImageHandler(request, context, shareStore, imageOptions) {
  if (!/^p[0-9]+-[A-Za-z0-9_-]{10}$/.test(request.params.version)) {
    return text(404, 'Preview image version not found.');
  }
  const id = request.params.id;
  if (!validShortId(id)) return text(400, 'Invalid short link.');

  let token;
  try {
    token = await loadToken(id, shareStore || await azureShareStore());
  } catch (error) {
    context.error('Could not resolve preview image.', error);
    if (error instanceof InvalidStoredTokenError) {
      return fallback(request);
    }
    return fallback(request);
  }
  if (!token) return text(404, 'Shared composition not found.');

  let preview;
  try {
    preview = previewState(decodeToken(token));
  } catch (error) {
    context.error('Stored preview image could not be rendered.', error);
    return fallback(request);
  }
  return previewImageResponse(request, token, preview, context,
    'public, max-age=31536000, immutable', imageOptions);
}

app.http('shortImage', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'i/{version}/{id}',
  handler: shortImageHandler,
});

module.exports = { shortImageHandler };
