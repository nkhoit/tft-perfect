(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShareState = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const FORMATS = [
    ['d', 'deflate-raw'],
    ['z', 'deflate'],
  ];
  const MAX_DECODED_BYTES = 256 * 1024;

  function base64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(value) {
    if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid shared-search encoding.');
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function transform(bytes, stream, maxBytes = Infinity) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('Shared-search payload is too large.');
      }
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  async function encode(state) {
    const raw = new TextEncoder().encode(JSON.stringify(state));
    let best = { prefix: 'r', bytes: raw };
    if (typeof CompressionStream === 'function') {
      for (const [prefix, format] of FORMATS) {
        try {
          const bytes = await transform(raw, new CompressionStream(format));
          if (bytes.length < best.bytes.length) best = { prefix, bytes };
        } catch {
          // Browser support differs by format; raw JSON remains valid.
        }
      }
    }
    return best.prefix + base64Url(best.bytes);
  }

  async function decode(value) {
    if (typeof value !== 'string' || value.length < 2 || value.length > 12000) {
      throw new Error('Invalid shared-search state.');
    }
    const prefix = value[0];
    let bytes = fromBase64Url(value.slice(1));
    if (prefix !== 'r') {
      const format = FORMATS.find(([candidate]) => candidate === prefix)?.[1];
      if (!format || typeof DecompressionStream !== 'function') {
        throw new Error('This browser cannot decode the shared search.');
      }
      try {
        bytes = await transform(
          bytes, new DecompressionStream(format), MAX_DECODED_BYTES);
      } catch (error) {
        if (/too large/i.test(error.message)) throw error;
        throw new Error('Invalid compressed shared-search state.');
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('Invalid shared-search payload.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid shared-search payload.');
    }
    return parsed;
  }

  return { decode, encode };
});
