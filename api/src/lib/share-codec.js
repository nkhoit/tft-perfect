const zlib = require('node:zlib');

const TOKEN = /^[A-Za-z0-9_-]{2,2048}$/;
const MAX_DECODED_BYTES = 32 * 1024;

function validToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function decodeToken(token) {
  if (!validToken(token)) throw new Error('Invalid shared-search token.');
  const prefix = token[0];
  const input = Buffer.from(token.slice(1), 'base64url');
  let decoded;
  if (prefix === 'r') decoded = input;
  else if (prefix === 'd') {
    decoded = zlib.inflateRawSync(input, { maxOutputLength: MAX_DECODED_BYTES });
  } else if (prefix === 'z') {
    decoded = zlib.inflateSync(input, { maxOutputLength: MAX_DECODED_BYTES });
  } else {
    throw new Error('Unsupported shared-search encoding.');
  }
  if (decoded.length > MAX_DECODED_BYTES) throw new Error('Shared-search token is too large.');
  let state;
  try {
    state = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Invalid shared-search payload.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || !Number.isInteger(state.v) || state.v < 1 || state.v > 2) {
    throw new Error('Unsupported shared-search payload.');
  }
  return state;
}

module.exports = { decodeToken, validToken };
