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
    const expected = await session.cdp.evaluate(`({
      key: document.querySelector('.sheetwrap.show .upchamp.add').dataset.key,
      level: document.querySelector('.sheetwrap.show [data-upfield="level"]').value,
    })`);
    await session.cdp.evaluate(
      `document.querySelector('.sheetwrap.show .upchamp.add').click()`);
    await waitFor(() => session.cdp.evaluate(
      `!document.querySelector('.sheetwrap.show')`));
    assert.deepEqual(await session.cdp.evaluate(`({
      level: document.querySelector('#size').value,
      required: document.querySelector('.u[data-key="${expected.key}"]')
        .classList.contains('req'),
    })`), {
      level: expected.level,
      required: true,
    });
  } finally {
    await session.cleanup();
  }
});

test('Clear restores cost, level, and waste filters', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    await loadExplorer(session);
    await session.cdp.evaluate(`(() => {
      document.querySelector('#costs [data-cost="5"]').click();
      const size = document.querySelector('#size');
      size.value = '9';
      size.dispatchEvent(new Event('input', { bubbles: true }));
      const waste = document.querySelector('#waste');
      waste.value = '4';
      waste.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal(await session.cdp.evaluate(
      `document.querySelectorAll('#activeFilters .afchip').length >= 3`), true);
    await session.cdp.evaluate(`document.querySelector('#clear').click()`);
    assert.deepEqual(await session.cdp.evaluate(`({
      allCosts: [...document.querySelectorAll('#costs .cbtn')].every(button =>
        button.classList.contains('on')),
      size: document.querySelector('#size').value,
      waste: document.querySelector('#waste').value,
      filtersHidden: document.querySelector('#activeFilters').hidden,
    })`), {
      allCosts: true,
      size: '8',
      waste: '10',
      filtersHidden: true,
    });
  } finally {
    await session.cleanup();
  }
});

test('clicking an added upgrade portrait requires it at the target level',
  { timeout: 120000 }, async () => {
    const session = await launchBrowser();
    try {
      await loadExplorer(session);
      await session.cdp.evaluate(
        `document.querySelector('#list .comp .upgradepath').click()`);
      await waitFor(() => session.cdp.evaluate(
        `Boolean(document.querySelector('#list .upgradepanel .upchamp.add[data-key]')
          && !document.querySelector('#list .upgradepanel')?.textContent.includes('Finding'))`),
      60000);
      const expected = await session.cdp.evaluate(`({
        key: document.querySelector('#list .upchamp.add').dataset.key,
        name: document.querySelector('#list .upchamp.add img').alt,
        level: document.querySelector('#list [data-upfield="level"]').value,
      })`);
      if (await session.cdp.evaluate(
        `matchMedia('(hover: hover) and (pointer: fine)').matches`)) {
        await session.cdp.evaluate(`(() => {
          const portrait = document.querySelector('#list .upchamp.add');
          portrait.dispatchEvent(new MouseEvent('mouseover', {
            bubbles: true,
            clientX: 100,
            clientY: 100,
          }));
        })()`);
        await waitFor(() => session.cdp.evaluate(
          `document.querySelector('#card.show')?.textContent.includes(${JSON.stringify(expected.name)})`));
      }
      await session.cdp.evaluate(
        `document.querySelector('#list .upchamp.add').click()`);
      assert.deepEqual(await session.cdp.evaluate(`({
        level: document.querySelector('#size').value,
        required: document.querySelector('.u[data-key="${expected.key}"]')
          .classList.contains('req'),
        panelClosed: !document.querySelector('#list .upgradepanel'),
      })`), {
        level: expected.level,
        required: true,
        panelClosed: true,
      });
    } finally {
      await session.cleanup();
    }
  });
