const { app } = require('@azure/functions');

const { publicOrigin, shortShareHtml } = require('../lib/preview.js');
const { previewState } = require('../lib/preview-state.js');
const { decodeToken, validToken } = require('../lib/share-codec.js');
const {
  InvalidStoredTokenError,
  azureShareStore,
  loadToken,
  saveToken,
  validShortId,
} = require('../lib/short-links.js');

function text(status, body) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
  };
}

async function shortenHandler(request, context, store) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return text(415, 'Short-link requests must use JSON.');
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return text(413, 'Short-link request is too large.');
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return text(400, 'Invalid short-link request.');
  }
  if (Buffer.byteLength(raw, 'utf8') > 4096) {
    return text(413, 'Short-link request is too large.');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return text(400, 'Invalid short-link request.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !validToken(payload.token)) {
    return text(400, 'Invalid shared composition.');
  }
  try {
    decodeToken(payload.token);
  } catch {
    return text(400, 'Invalid shared composition.');
  }

  let saved;
  try {
    saved = await saveToken(payload.token, store || await azureShareStore());
  } catch (error) {
    context.error('Could not persist short link.', error);
    return text(503, 'Short links are temporarily unavailable.');
  }
  return {
    status: saved.created ? 201 : 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      id: saved.id,
      prewarm: `/api/prewarm/${saved.id}`,
      url: `${publicOrigin(request)}/api/s/${saved.id}`,
    }),
  };
}

async function shortShareHandler(request, context, store) {
  const id = request.params.id;
  if (!validShortId(id)) return text(400, 'Invalid short link.');

  let token;
  try {
    token = await loadToken(id, store || await azureShareStore());
  } catch (error) {
    context.error('Could not resolve short link.', error);
    if (error instanceof InvalidStoredTokenError) {
      return text(500, 'Stored shared composition is invalid.');
    }
    return text(503, 'Short links are temporarily unavailable.');
  }
  if (!token) return text(404, 'Shared composition not found.');

  let preview;
  try {
    preview = previewState(decodeToken(token));
  } catch (error) {
    context.error('Stored short link could not be rendered.', error);
    return text(500, 'Stored shared composition is invalid.');
  }
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-robots-tag': 'noindex, nofollow',
    },
    body: request.method === 'HEAD'
      ? null
      : shortShareHtml(publicOrigin(request), id, token, preview),
  };
}

app.http('shorten', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'shorten',
  handler: shortenHandler,
});

app.http('shortShare', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 's/{id}',
  handler: shortShareHandler,
});

module.exports = { shortenHandler, shortShareHandler };
