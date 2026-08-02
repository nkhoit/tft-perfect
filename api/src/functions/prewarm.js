const { app } = require('@azure/functions');

const {
  cachedPreviewPng,
  RenderLeaseTimeoutError,
  shortPreviewCacheKey,
} = require('../lib/preview-cache.js');
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

async function prewarmHandler(request, context, shareStore, imageOptions = {}) {
  const id = request.params.id;
  if (!validShortId(id)) return text(400, 'Invalid short link.');

  let token;
  try {
    token = await loadToken(id, shareStore || await azureShareStore());
  } catch (error) {
    context.error('Could not resolve preview prewarm request.', error);
    if (error instanceof InvalidStoredTokenError) {
      return text(500, 'Stored shared composition is invalid.');
    }
    return text(503, 'Preview prewarming is temporarily unavailable.');
  }
  if (!token) return text(404, 'Shared composition not found.');

  let preview;
  try {
    preview = previewState(decodeToken(token));
  } catch (error) {
    context.error('Stored preview could not be prewarmed.', error);
    return text(500, 'Stored shared composition is invalid.');
  }
  try {
    const {
      leaseWaitMs = 0,
      renderOnLeaseTimeout = false,
      ...cacheOptions
    } = imageOptions;
    await cachedPreviewPng(token, preview, {
      ...cacheOptions,
      key: shortPreviewCacheKey(id),
      leaseWaitMs,
      renderOnLeaseTimeout,
      onCacheError(error) {
        cacheOptions.onCacheError?.(error);
        context.warn?.('Preview image cache unavailable during prewarm.', error);
      },
    });
  } catch (error) {
    if (error instanceof RenderLeaseTimeoutError) {
      return {
        status: 202,
        headers: { 'cache-control': 'no-store' },
        body: null,
      };
    }
    context.error('Could not prewarm preview image.', error);
    return text(503, 'Preview prewarming is temporarily unavailable.');
  }
  return {
    status: 204,
    headers: { 'cache-control': 'no-store' },
    body: null,
  };
}

app.http('prewarm', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'prewarm/{id}',
  handler: prewarmHandler,
});

module.exports = { prewarmHandler };
