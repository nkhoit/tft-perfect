import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// On a coarse pointer a tap opens the info sheet instead of cycling the pick
// state, so the desktop click-cycle (none -> required -> carry) is unreachable.
// Without a Carry button in the sheet, mobile users cannot declare a carry at
// all -- the whole comp-quality feature is desktop-only. This guards the sheet
// route end to end: tap the button, then assert the carry actually reached the
// solver rather than just lighting up the UI.

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const SHEET = `(() => {
  const tile = [...document.querySelectorAll('.u[data-key]')]
    .find(t => t.dataset.key === 'Aphelios');
  if (!tile) return { ok: false };
  tile.click();
  const foot = document.querySelector('.sheetfoot');
  if (!foot) return { ok: false };
  return {
    ok: true,
    coarse: matchMedia('(pointer: coarse)').matches,
    acts: [...foot.querySelectorAll('[data-act]')].map(b => b.dataset.act),
    overflow: foot.scrollWidth > foot.clientWidth,
  };
})()`;

const TAP = `(() => {
  const b = document.querySelector('[data-act="cry"]');
  if (!b) return { ok: false };
  b.click();
  return { ok: true, value: state.get('Aphelios') };
})()`;

const PROBE = `(() => {
  const rows = [...document.querySelectorAll('#list .comp')];
  const bar = document.getElementById('compBar');
  const has = r => [...r.querySelectorAll('[data-key]')].some(u => u.dataset.key === 'Aphelios');
  return {
    rows: rows.length,
    withCarry: rows.filter(has).length,
    barHidden: bar ? bar.hidden : true,
    barText: bar ? bar.textContent : '',
  };
})()`;

test('a phone can declare a carry through the unit sheet', { timeout: 300000 }, async () => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Emulation.setDeviceMetricsOverride', PHONE);
    await session.cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await session.cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${session.appPort}/traits/`,
    });

    await waitFor(async () => {
      const n = await session.cdp.evaluate(
        `document.querySelectorAll('.u[data-key]').length`);
      return n > 0;
    }, 120000);

    const sheet = await session.cdp.evaluate(SHEET);
    assert.ok(sheet.ok, 'tapping a unit should open the sheet');
    assert.ok(sheet.coarse, 'device emulation should report a coarse pointer');
    assert.deepEqual(sheet.acts, ['req', 'cry', 'exc'],
      'the sheet needs its own Carry button -- touch cannot click-cycle');
    assert.equal(sheet.overflow, false,
      'three buttons must still fit a 390px phone without scrolling');

    const tapped = await session.cdp.evaluate(TAP);
    assert.ok(tapped.ok, 'the sheet should render a Carry button');
    assert.equal(tapped.value, 3, 'tapping Carry lands on the carry state');

    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return s.rows > 0 && !s.barHidden;
    }, 240000);

    const seen = await session.cdp.evaluate(PROBE);
    // Same non-vacuous shape as the desktop guard: with the carry dropped from
    // reqIdx it still appears in a few boards by chance, so require all of them.
    assert.equal(seen.withCarry, seen.rows,
      `carry must be pinned into all ${seen.rows} boards, got ${seen.withCarry}`);
    assert.match(seen.barText, /Building around/);
    assert.match(seen.barText, /Aphelios/);
  } finally {
    await session.cleanup();
  }
});
