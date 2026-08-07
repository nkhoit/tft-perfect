import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// Marking a unit as a CARRY is the third pick state (none -> required ->
// carry). A carry is still a required unit, so it must reach the solver in
// reqIdx -- the bug this guards is a carry that shows up in the comp bar but
// is silently dropped from the search, so the tool claims to build around a
// unit that never appears in the results.

const CLICK = `(() => {
  const tiles = [...document.querySelectorAll('.u[data-key]')];
  const pick = key => tiles.find(t => t.dataset.key === key);
  const aph = pick('Aphelios');
  if (!aph) return { ok: false };
  aph.click(); aph.click();          // none -> required -> carry
  return { ok: true, value: state.get('Aphelios') };
})()`;

const PROBE = `(() => {
  const rows = [...document.querySelectorAll('#list .comp')];
  const bar = document.getElementById('compBar');
  const has = r => [...r.querySelectorAll('[data-key]')].some(u => u.dataset.key === 'Aphelios');
  return {
    rows: rows.length,
    withCarry: rows.filter(has).length,
    units: rows[0] ? [...rows[0].querySelectorAll('[data-key]')].map(u => u.dataset.key) : [],
    barText: bar ? bar.textContent : '',
    barHidden: bar ? bar.hidden : true,
    pickN: document.getElementById('pickN').textContent,
  };
})()`;

test('a declared carry reaches the solver and appears in every board', { timeout: 300000 }, async () => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${session.appPort}/traits/`,
    });

    await waitFor(async () => {
      const r = await session.cdp.evaluate(
        `document.querySelectorAll('.u[data-key]').length`);
      return r > 0;
    }, 120000);

    const marked = await session.cdp.evaluate(CLICK);
    assert.ok(marked.ok, 'Aphelios tile should exist in the pool');
    assert.equal(marked.value, 3, 'two clicks should land on the carry state');

    // The comp bar renders after the results paint, so wait for BOTH rather
    // than assuming one implies the other.
    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return s.rows > 0 && !s.barHidden;
    }, 240000);

    const seen = await session.cdp.evaluate(PROBE);

    // The regression: reqIdx only looked at state === 1, so a carry was never
    // pinned. Checking only row 1 is NOT enough -- with the bug present the
    // carry still turns up in a handful of boards by chance (5 of 100 when
    // this was written), so assert it is pinned into EVERY row.
    assert.equal(seen.withCarry, seen.rows,
      `carry must be pinned into all ${seen.rows} boards, got ${seen.withCarry}`);
    assert.ok(seen.units.includes('Aphelios'),
      `carry must be in the top board, got: ${seen.units.join(', ')}`);
    assert.equal(seen.pickN, '1 required · 0 excluded',
      'a carry counts as a required unit in the header');
    assert.equal(seen.barHidden, false, 'comp bar shows once a carry exists');
    assert.match(seen.barText, /Building around/);
    assert.match(seen.barText, /Aphelios/);
  } finally {
    await session.cleanup();
  }
});
