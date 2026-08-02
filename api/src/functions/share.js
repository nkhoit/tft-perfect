const { app } = require('@azure/functions');
const { publicOrigin, shareHtml, validToken } = require('../lib/preview.js');

async function shareHandler(request) {
  const token = request.params.token;
  if (!validToken(token)) {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Invalid shared composition.',
    };
  }
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-robots-tag': 'noindex, nofollow',
    },
    body: request.method === 'HEAD' ? null : shareHtml(publicOrigin(request), token),
  };
}

app.http('share', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'share/{token}',
  handler: shareHandler,
});

module.exports = { shareHandler };
