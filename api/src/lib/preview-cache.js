const crypto = require('node:crypto');

const { BlobServiceClient } = require('@azure/storage-blob');

const { PREVIEW_ROUTE_VERSION, previewDigest } = require('./preview-state.js');
const { previewPng } = require('./preview.js');

const MAX_MEMORY_ENTRIES = 16;
const DEFAULT_LEASE_POLL_MS = 100;
const DEFAULT_LEASE_WAIT_MS = 5000;
const memoryCache = new Map();
const inFlight = new Map();
let storePromise = null;

class RenderLeaseTimeoutError extends Error {}

function isStatus(error, statusCode) {
  return error?.statusCode === statusCode || error?.status === statusCode;
}

function previewCacheKey(token) {
  return `${PREVIEW_ROUTE_VERSION}/${previewDigest(token)}.png`;
}

function shortPreviewCacheKey(id) {
  return `${PREVIEW_ROUTE_VERSION}/${id}.png`;
}

function shortPreviewEtag(id) {
  return '"' + crypto.createHash('sha256')
    .update(PREVIEW_ROUTE_VERSION)
    .update('\0')
    .update(id)
    .digest('base64url')
    .slice(0, 24) + '"';
}

function remember(key, body) {
  memoryCache.delete(key);
  memoryCache.set(key, body);
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function clearMemoryCache() {
  memoryCache.clear();
  inFlight.clear();
}

async function azurePreviewStore() {
  if (!storePromise) {
    storePromise = Promise.resolve().then(() => {
      const connectionString = process.env.SHARE_STORAGE_CONNECTION_STRING;
      if (!connectionString) throw new Error('SHARE_STORAGE_CONNECTION_STRING is not configured.');
      const service = BlobServiceClient.fromConnectionString(connectionString);
      const container = service.getContainerClient(
        process.env.SHARE_IMAGE_CONTAINER || 'og-cache');
      return {
        async acquire(key) {
          const lock = container.getBlockBlobClient(`locks/${key}.lock`);
          try {
            await lock.uploadData(Buffer.alloc(0), {
              conditions: { ifNoneMatch: '*' },
            });
          } catch (error) {
            if (!isStatus(error, 409) && !isStatus(error, 412)) throw error;
          }
          const lease = lock.getBlobLeaseClient();
          try {
            await lease.acquireLease(60);
          } catch (error) {
            if (isStatus(error, 409) || isStatus(error, 412)) return null;
            throw error;
          }
          return {
            async release() {
              try {
                await lease.releaseLease();
              } catch (error) {
                if (!isStatus(error, 404) && !isStatus(error, 409)
                    && !isStatus(error, 412)) throw error;
              }
            },
          };
        },
        async get(key) {
          try {
            const response = await container.getBlockBlobClient(key).download();
            const chunks = [];
            for await (const chunk of response.readableStreamBody) chunks.push(chunk);
            return Buffer.concat(chunks);
          } catch (error) {
            if (isStatus(error, 404)) return null;
            throw error;
          }
        },
        async put(key, body) {
          try {
            await container.getBlockBlobClient(key).uploadData(body, {
              conditions: { ifNoneMatch: '*' },
              blobHTTPHeaders: {
                blobCacheControl: 'public, max-age=31536000, immutable',
                blobContentType: 'image/png',
              },
            });
          } catch (error) {
            if (!isStatus(error, 409) && !isStatus(error, 412)) throw error;
          }
        },
      };
    }).catch(error => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireRenderLease(store, key, options) {
  const verify = async lease => {
    try {
      const cached = await store.get(key);
      return cached
        ? { body: Buffer.from(cached), lease }
        : { lease };
    } catch (error) {
      try { await lease.release(); } catch {}
      throw error;
    }
  };
  let lease = await store.acquire(key);
  if (lease) return verify(lease);

  const pollMs = options.leasePollMs ?? DEFAULT_LEASE_POLL_MS;
  const deadline = Date.now() + (options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS);
  let nextLeaseAttempt = Date.now() + Math.max(500, pollMs * 5);
  while (Date.now() < deadline) {
    await delay(pollMs);
    const cached = await store.get(key);
    if (cached) return { body: Buffer.from(cached) };
    if (Date.now() >= nextLeaseAttempt) {
      lease = await store.acquire(key);
      if (lease) return verify(lease);
      nextLeaseAttempt = Date.now() + Math.max(500, pollMs * 5);
    }
  }
  throw new RenderLeaseTimeoutError('Timed out waiting for preview render lease.');
}

async function readCachedPreview(key, options = {}) {
  const warm = memoryCache.get(key);
  if (warm) {
    remember(key, warm);
    return warm;
  }

  let store = options.store;
  if (!store) {
    try {
      store = await azurePreviewStore();
    } catch (error) {
      options.onCacheError?.(error);
    }
  }
  if (store) {
    try {
      const cached = await store.get(key);
      if (cached) {
        const body = Buffer.from(cached);
        remember(key, body);
        return body;
      }
    } catch (error) {
      options.onCacheError?.(error);
      store = null;
    }
  }
  return null;
}

async function cachedPreviewPng(token, preview, options = {}) {
  const key = options.key || previewCacheKey(token);
  if (!options.skipRead) {
    const cached = await readCachedPreview(key, options);
    if (cached) return cached;
  }

  let store = options.store;
  if (!store) {
    try {
      store = await azurePreviewStore();
    } catch (error) {
      options.onCacheError?.(error);
    }
  }
  if (!inFlight.has(key)) {
    const render = options.render || previewPng;
    const pending = (async () => {
      let lease = null;
      try {
        if (store?.acquire) {
          try {
            const coordinated = await acquireRenderLease(store, key, options);
            lease = coordinated.lease;
            if (coordinated.body) {
              remember(key, coordinated.body);
              return coordinated.body;
            }
          } catch (error) {
            if (error instanceof RenderLeaseTimeoutError
                && options.renderOnLeaseTimeout === false) throw error;
            options.onCacheError?.(error);
          }
        }
        const body = Buffer.from(await render(preview));
        remember(key, body);
        if (store) {
          try {
            await store.put(key, body);
          } catch (error) {
            options.onCacheError?.(error);
          }
        }
        return body;
      } finally {
        if (lease) {
          try {
            await lease.release();
          } catch (error) {
            options.onCacheError?.(error);
          }
        }
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return inFlight.get(key);
}

module.exports = {
  azurePreviewStore,
  cachedPreviewPng,
  clearMemoryCache,
  previewCacheKey,
  readCachedPreview,
  shortPreviewCacheKey,
  shortPreviewEtag,
  RenderLeaseTimeoutError,
};
