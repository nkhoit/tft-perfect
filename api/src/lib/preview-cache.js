const { BlobServiceClient } = require('@azure/storage-blob');

const { PREVIEW_ROUTE_VERSION, previewDigest } = require('./preview-state.js');
const { previewPng } = require('./preview.js');

const MAX_MEMORY_ENTRIES = 16;
const memoryCache = new Map();
const inFlight = new Map();
let storePromise = null;

function isStatus(error, statusCode) {
  return error?.statusCode === statusCode || error?.status === statusCode;
}

function previewCacheKey(token) {
  return `${PREVIEW_ROUTE_VERSION}/${previewDigest(token)}.png`;
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

async function cachedPreviewPng(token, preview, options = {}) {
  const key = previewCacheKey(token);
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

  if (!inFlight.has(key)) {
    const render = options.render || previewPng;
    const pending = (async () => {
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
};
