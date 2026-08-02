const { app } = require('@azure/functions');

async function readyHandler() {
  return {
    status: 204,
    headers: { 'cache-control': 'no-store' },
    body: null,
  };
}

app.http('ready', {
  methods: ['GET', 'HEAD'],
  authLevel: 'anonymous',
  route: 'ready',
  handler: readyHandler,
});

module.exports = { readyHandler };
