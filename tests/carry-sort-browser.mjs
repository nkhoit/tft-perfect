import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// Declaring a carry means "I am itemizing this board", so among boards with
// identical traits the tiebreak should prefer the stronger bodies. The default
// tiebreak is "cheapest board", which actively picks the 1-cost stat-stick
// (Xayah) over the 3-cost with a real body (Raptor).
const SETUP = `(() => {
  for (const k of ['Aphelios','AncientSentinel','Brambleback']) setUnitState(k, 1);
  setTraitReq('Vanguard', 4);
  return 1;
})()`;

const MARK_CARRY = `(() => { setUnitState('Aphelios', 3); return document.getElementById('sort2').value; })()`;

const PROBE = `(() => {
  const rows = [...document.querySelectorAll('#list .comp')];
  const keys = rows.map(r => [...r.querySelectorAll('[data-key]')].map(u => u.dataset.key));
  const firstWith = k => { const i = keys.findIndex(u => u.includes(k)); return i < 0 ? 0 : i + 1; };
  return {
    rows: keys.length,
    sort2: document.getElementById('sort2').value,
    status: document.getElementById('status').textContent,
    firstRaptor: firstWith('Raptor'),
    rank1: keys[0] || [],
  };
})()`;

test('declaring a carry breaks ties toward stronger bodies', async () => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Page.navigate', { url: `http://127.0.0.1:${session.appPort}/traits/` });
    await waitFor(async () =>
      (await session.cdp.evaluate(`document.querySelectorAll('.u[data-key]').length`)) > 0, 120000);

    await session.cdp.evaluate(SETUP);
    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return s.rows > 0 && /optimal/.test(s.status);
    }, 240000);

    const before = await session.cdp.evaluate(PROBE);

    const sort2 = await session.cdp.evaluate(MARK_CARRY);
    assert.equal(sort2, 'rich', 'declaring a carry moves the tiebreak to strongest bodies');

    // sort2 flips synchronously and the pre-carry list is already 100 rows and
    // "optimal", so those alone cannot tell the old list from the new one.
    // Wait for the status string itself to change, then for a settled solve.
    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return s.rows > 0 && s.sort2 === 'rich'
        && /optimal/.test(s.status) && s.status !== before.status;
    }, 240000);

    const seen = await session.cdp.evaluate(PROBE);
    // Under the "cheapest board" default Raptor is buried; strength-first must
    // pull him into the very top board.
    assert.equal(seen.firstRaptor, 1,
      `Raptor should lead once a carry is declared, first seen at rank ${seen.firstRaptor} (${seen.status})`);
    assert.ok(seen.rank1.includes('Raptor'), 'top board keeps the stronger body');
  } finally {
    await session.cleanup();
  }
});

test('a tiebreak the user picked is never overwritten', async () => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Page.navigate', { url: `http://127.0.0.1:${session.appPort}/traits/` });
    await waitFor(async () =>
      (await session.cdp.evaluate(`document.querySelectorAll('.u[data-key]').length`)) > 0, 120000);

    // The user deliberately asks for cheapest boards, then marks a carry.
    const chosen = await session.cdp.evaluate(`(() => {
      const el = document.getElementById('sort2');
      el.value = 'waste';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      setUnitState('Aphelios', 3);
      return el.value;
    })()`);
    assert.equal(chosen, 'waste', 'an explicit tiebreak survives declaring a carry');
  } finally {
    await session.cleanup();
  }
});
