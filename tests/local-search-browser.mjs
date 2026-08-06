import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

test('the persisted experiment toggle routes searches only to local workers',
  { timeout: 120000 }, async () => {
    const session = await launchBrowser();
    try {
      await session.cdp.call('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('tftkit:local-search-experiment', '1');
          globalThis.__searchWorkerUrls = [];
          const NativeWorker = globalThis.Worker;
          globalThis.Worker = function(url, options) {
            globalThis.__searchWorkerUrls.push(String(url));
            return new NativeWorker(url, options);
          };
          globalThis.Worker.prototype = NativeWorker.prototype;
          addEventListener('DOMContentLoaded', () => {
            document.getElementById('effort').value = 'quick';
          });
        `,
      });
      await session.cdp.call('Page.navigate', {
        url: `http://127.0.0.1:${session.appPort}/traits/`,
      });
      await waitFor(() => session.cdp.evaluate(`(() => {
        const status = document.getElementById('status')?.textContent || '';
        const count = document.getElementById('count')?.textContent || '';
        return /experimental sample/.test(status) && !/so far/.test(count);
      })()`), 30000);

      const local = await session.cdp.evaluate(`({
        checked: document.getElementById('newExperience').checked,
        status: document.getElementById('status').textContent,
        urls: globalThis.__searchWorkerUrls,
        upgradeCount: document.querySelectorAll('.upgradepath').length,
        upgradesDisabled: [...document.querySelectorAll('.upgradepath')]
          .every(button => button.disabled),
      })`);
      assert.equal(local.checked, true);
      assert.match(local.status, /experimental sample/);
      assert.ok(local.urls.some(url => /local-worker\.js/.test(url)), local.urls.join(','));
      assert.ok(local.urls.every(url => !/(^|\/)worker\.js/.test(url)
        && !/solver-worker\.js/.test(url)), local.urls.join(','));
      assert.ok(local.upgradeCount > 0);
      assert.equal(local.upgradesDisabled, true);

      await session.cdp.evaluate(`(() => {
        globalThis.__searchWorkerUrls.length = 0;
        document.getElementById('size').value = '2';
        document.getElementById('effort').value = 'quick';
        document.getElementById('newExperience').click();
      })()`);
      await waitFor(() => session.cdp.evaluate(
        `globalThis.__searchWorkerUrls.some(url => /(^|\\/)worker\\.js/.test(url))
          && globalThis.__searchWorkerUrls.some(url => /solver-worker\\.js/.test(url))`),
      30000);
      const existing = await session.cdp.evaluate(`({
        checked: document.getElementById('newExperience').checked,
        persisted: localStorage.getItem('tftkit:local-search-experiment'),
        urls: globalThis.__searchWorkerUrls,
      })`);
      assert.equal(existing.checked, false);
      assert.equal(existing.persisted, '0');
      assert.ok(existing.urls.some(url => /(^|\/)worker\.js/.test(url)));
      assert.ok(existing.urls.some(url => /solver-worker\.js/.test(url)));
    } finally {
      await session.cleanup();
    }
  });
