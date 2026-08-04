import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, loadExplorer, waitFor } from './browser-harness.mjs';

test('upgrade paths render without replacing desktop results', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    await loadExplorer(session);
    const before = await session.cdp.evaluate(
      `document.querySelectorAll('#list > .comp').length`);
    await session.cdp.evaluate(
      `document.querySelector('#list .comp .upgradepath').click()`);
    await waitFor(() => session.cdp.evaluate(
      `Boolean(document.querySelector('#list .upgradepanel .uplist[data-proved="true"] .upmove')
        && !document.querySelector('#list .upgradepanel .upempty')
        && !document.querySelector('#list .upgradepanel')?.textContent.includes('Finding'))`),
    60000);
    const after = await session.cdp.evaluate(
      `document.querySelectorAll('#list > .comp').length`);
    assert.equal(after, before);
    assert.equal(await session.cdp.evaluate(
      `document.querySelectorAll('#list .upgradepanel').length`), 1);
    assert.equal(await session.cdp.evaluate(
      `Boolean(document.querySelector('#list .upchamp.add img')
        && document.querySelector('#list .upchamp.add .upchampmark')
        && document.querySelector('#list .uptrait.add'))`), true);
    await session.cdp.evaluate(`(() => {
      const keep = document.querySelector('#list .upgradepanel [data-upfield="keep"]');
      keep.value = String(Number(keep.value) - 1);
      keep.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => session.cdp.evaluate(
      `Boolean(document.querySelector('#list .upgradepanel .upchamp.remove img')
        && !document.querySelector('#list .upgradepanel')?.textContent.includes('Finding'))`),
    60000);
    await session.cdp.evaluate(
      `document.querySelector('#list .comp .upgradepath').click()`);
    await waitFor(() => session.cdp.evaluate(
      `!document.querySelector('#list .upgradepanel')`));
  } finally {
    await session.cleanup();
  }
});

test('coarse pointers use the existing mobile sheet', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await session.cdp.call('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await loadExplorer(session);
    assert.equal(await session.cdp.evaluate(
      `matchMedia('(pointer: coarse)').matches`), true);
    await session.cdp.evaluate(
      `document.querySelector('#list .comp .upgradepath').click()`);
    await waitFor(() => session.cdp.evaluate(
      `Boolean(document.querySelector('.sheetwrap.show .upgradepanel'))`));
    await waitFor(() => session.cdp.evaluate(
      `Boolean(document.querySelector('.sheetwrap.show .uplist[data-proved="true"] .upmove')
        && !document.querySelector('.sheetwrap.show .upempty')
        && !document.querySelector('.sheetwrap.show .upgradepanel')?.textContent.includes('Finding'))`),
    60000);
    assert.equal(await session.cdp.evaluate(
      `document.querySelector('.sheetfoot').hidden`), true);
    assert.equal(await session.cdp.evaluate(
      `Boolean(document.querySelector('.sheetwrap.show .upchamp.add img')
        && document.querySelector('.sheetwrap.show .uptrait'))`), true);
  } finally {
    await session.cleanup();
  }
});
