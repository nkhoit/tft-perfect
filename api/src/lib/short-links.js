const crypto = require('node:crypto');

const { decodeToken, validToken } = require('./share-codec.js');

const ID = /^[A-Za-z0-9_-]{12,43}$/;
const ID_LENGTHS = [12, 16, 22, 32, 43];
const PARTITION = 'v1';
let storePromise = null;

class InvalidStoredTokenError extends Error {}

function validShortId(value) {
  return typeof value === 'string' && ID.test(value);
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function isStatus(error, statusCode) {
  return error?.statusCode === statusCode || error?.status === statusCode;
}

async function saveToken(token, store) {
  if (!validToken(token)) throw new TypeError('Invalid shared-search token.');
  decodeToken(token);
  const digest = tokenDigest(token);

  for (const length of ID_LENGTHS) {
    const id = digest.slice(0, length);
    const existing = await store.get(id);
    if (existing) {
      if (existing.token === token) return { created: false, id };
      continue;
    }
    const row = { id, token, createdAt: new Date().toISOString() };
    try {
      await store.create(row);
      return { created: true, id };
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      const concurrent = await store.get(id);
      if (concurrent?.token === token) return { created: false, id };
    }
  }
  throw new Error('Could not allocate a collision-free short-link ID.');
}

async function loadToken(id, store) {
  if (!validShortId(id)) throw new TypeError('Invalid short-link ID.');
  const row = await store.get(id);
  if (!row) return null;
  if (!validToken(row.token)) {
    throw new InvalidStoredTokenError('Stored short link contains an invalid token.');
  }
  try {
    decodeToken(row.token);
  } catch {
    throw new InvalidStoredTokenError('Stored short link contains an invalid payload.');
  }
  return row.token;
}

async function azureShareStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const connectionString = process.env.SHARE_STORAGE_CONNECTION_STRING;
      if (!connectionString) throw new Error('SHARE_STORAGE_CONNECTION_STRING is not configured.');
      const { TableClient } = require('@azure/data-tables');
      const client = TableClient.fromConnectionString(
        connectionString, process.env.SHARE_STORAGE_TABLE || 'shares');
      return {
        async create(row) {
          await client.createEntity({
            partitionKey: PARTITION,
            rowKey: row.id,
            token: row.token,
            createdAt: row.createdAt,
          });
        },
        async get(id) {
          try {
            const entity = await client.getEntity(PARTITION, id);
            return { id: entity.rowKey, token: entity.token, createdAt: entity.createdAt };
          } catch (error) {
            if (isStatus(error, 404)) return null;
            throw error;
          }
        },
      };
    })().catch(error => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

module.exports = {
  InvalidStoredTokenError,
  azureShareStore,
  loadToken,
  saveToken,
  tokenDigest,
  validShortId,
};
