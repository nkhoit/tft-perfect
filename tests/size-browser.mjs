import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, loadExplorer, waitFor } from './browser-harness.mjs';

// A Tactician's Crown (or an augment that grants a slot) decouples board size
// from player level: you can sit at level 10 and field 11 or 12 units. The
// control is therefore a unit count, not a level, and must go past 10.

test('board size goes past 10 for Tactician\u2019s Crown boards', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    await loadExplorer(session);

    const slider = await session.cdp.evaluate(`(() => {
      const el = document.getElementById('size');
      return { min: el.min, max: el.max, label:
        document.querySelector('#filtersContent section h2').textContent.trim() };
    })()`);
    assert.equal(slider.max, '12', 'slider must reach 12 units');
    assert.match(slider.label, /units/i,
      'the control counts units, not levels');

    // Setting 12 must actually search a 12-unit board, not silently clamp.
    await session.cdp.evaluate(`(() => {
      const el = document.getElementById('size');
      el.value = '12';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    // The results list is repopulated asynchronously. Waiting on "a comp
    // exists" is not enough -- the previous 8-unit results are still on screen
    // and the assertion reads them instead. Wait for a board that actually
    // reflects the new size.
    await waitFor(() => session.cdp.evaluate(
      `document.querySelector('#list > .comp')?.querySelectorAll('.uc').length >= 12`),
    60000);

    assert.equal(await session.cdp.evaluate(
      `document.getElementById('sizeV').textContent`), '12');

    const comps = await session.cdp.evaluate(
      `document.querySelectorAll('#list > .comp').length`);
    assert.ok(comps > 0, 'a 12-unit search should still return boards');

    // Boards must actually grow with the slider. Note a board can hold MORE
    // unit cards than the slider value: summoned units bring their own slots,
    // which is what the "N slots" badge reports. So the contract is "at least
    // 12", and strictly more than the same search at 8.
    const big = await session.cdp.evaluate(
      `document.querySelector('#list > .comp').querySelectorAll('.uc').length`);
    assert.ok(big >= 12, `expected at least 12 units, got ${big}`);

    await session.cdp.evaluate(`(() => {
      const el = document.getElementById('size');
      el.value = '8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => session.cdp.evaluate(
      `document.querySelector('#list > .comp')?.querySelectorAll('.uc').length === 8`),
    60000);
    const small = await session.cdp.evaluate(
      `document.querySelector('#list > .comp').querySelectorAll('.uc').length`);
    assert.ok(big > small, `12-unit board (${big}) must beat the 8-unit one (${small})`);
  } finally {
    await session.cleanup();
  }
});

test('a shared link restores a board size above the old level cap', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    // Encode on a clean load, then navigate to the token like a user would.
    await loadExplorer(session);
    const token = await session.cdp.evaluate(
      `window.ShareState.encode({ v: 1, l: 12, w: 2 })`);
    assert.ok(typeof token === 'string' && token.length, 'expected a share token');

    await session.cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${session.appPort}/traits/?s=${token}`,
    });

    // The old guard clamped `l` to 10, so a 12-unit link silently reverted to
    // the default: the link looked fine and showed the wrong search.
    await waitFor(() => session.cdp.evaluate(
      `document.getElementById('sizeV')?.textContent === '12'
       && document.querySelectorAll('#list > .comp').length > 0`), 60000);

    assert.equal(await session.cdp.evaluate(
      `document.getElementById('size').value`), '12');
    const units = await session.cdp.evaluate(
      `document.querySelector('#list > .comp').querySelectorAll('.uc').length`);
    assert.ok(units >= 12, `shared 12-unit board rendered ${units} units`);
  } finally {
    await session.cleanup();
  }
});
