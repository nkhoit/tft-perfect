const { app } = require('@azure/functions');
const { previewPng, validToken } = require('../lib/preview.js');

async function ogHandler(request) {
  const token = request.params.token;
  if (!validToken(token)) {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Invalid shared composition.',
    };
  }
  const body = await previewPng();
  return {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300',
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
