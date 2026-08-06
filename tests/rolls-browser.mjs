import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// The maths lives in tests/rolls.test.js. This file only proves the page
// wires up in a real browser: controls drive the numbers, impossible states
// explain themselves, and nothing overflows a phone viewport.

async function loadRolls(session, query = '') {
  await session.cdp.call('Page.navigate', {
    url: `http://127.0.0.1:${session.appPort}/rolls/${query}`,
  });
  await waitFor(() => session.cdp.evaluate(
    `Boolean(window.RollOdds && document.getElementById('bigPct').textContent.trim())`));
}

test('roll odds page responds to controls', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    // Pinned to s=1 so this stays a test of the gold/level controls rather
    // than of whatever the default star target happens to be.
    await loadRolls(session, '?lv=8&c=4&g=50&s=1');

    // Baseline: level 8, 4-cost, 50 gold, one copy.
    assert.equal(await session.cdp.evaluate(
      `document.getElementById('tierPct').textContent`), '24%');
    const base = await session.cdp.evaluate(
      `parseFloat(document.getElementById('bigPct').textContent)`);
    assert.ok(base > 80 && base < 95, `unexpected baseline ${base}`);

    // Spending less gold must lower the cumulative chance.
    await session.cdp.evaluate(`(() => {
      const g = document.getElementById('gold');
      g.value = '20';
      g.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const less = await session.cdp.evaluate(
      `parseFloat(document.getElementById('bigPct').textContent)`);
    assert.ok(less < base, `${less} should be below ${base}`);

    // Contention: copies already taken must lower it further.
    await session.cdp.evaluate(`(() => {
      const t = document.getElementById('taken');
      t.value = '5';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const contested = await session.cdp.evaluate(
      `parseFloat(document.getElementById('bigPct').textContent)`);
    assert.ok(contested < less, `${contested} should be below ${less}`);
  } finally {
    await session.cleanup();
  }
});

test('impossible tiers explain themselves instead of showing a bare 0%',
  { timeout: 120000 }, async () => {
    const session = await launchBrowser();
    try {
      // Level 5 shops never contain 5-costs.
      await loadRolls(session, '?lv=5&c=5&g=50');
      assert.equal(await session.cdp.evaluate(
        `document.getElementById('bigPct').textContent`), '0%');
      assert.match(await session.cdp.evaluate(
        `document.getElementById('bigSub').textContent`), /never contain 5-costs/);

      // The selected button stays reachable -- disabling it would strand the
      // user on a dead 0% with no way back via keyboard.
      assert.equal(await session.cdp.evaluate(
        `document.querySelector('#costSeg button[data-cost="5"]').disabled`), false);

      // Every confidence row should say so rather than printing a gold figure.
      assert.equal(await session.cdp.evaluate(
        `[...document.querySelectorAll('#confBody tr')]
          .every(r => r.lastElementChild.textContent === 'impossible')`), true);
    } finally {
      await session.cleanup();
    }
  });

test('the page fits a phone viewport without horizontal overflow',
  { timeout: 120000 }, async () => {
    const session = await launchBrowser();
    try {
      await session.cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
      });
      await loadRolls(session, '?lv=8&c=4&g=50');
      const overflow = await session.cdp.evaluate(
        `[...document.querySelectorAll('body *')]
          .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
          .map(e => e.tagName + '.' + e.className)`);
      assert.deepEqual(overflow, [], `overflowing: ${JSON.stringify(overflow)}`);

      // The page-level check above is not enough on its own: a scrollable
      // container clips its contents *inside* its own box, so the 5-cost
      // column can vanish off the right edge while every element still
      // reports right <= innerWidth. Assert the odds table is not scrolled.
      const table = await session.cdp.evaluate(`(() => {
        const wrap = document.querySelector('.tablescroll');
        const last = document.querySelector('.oddstable tbody tr:last-child td:last-child');
        return {
          clipped: wrap.scrollWidth > wrap.clientWidth + 1,
          lastVisible: last.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1,
          lastText: last.textContent,
        };
      })()`);
      assert.equal(table.clipped, false, 'shop odds table scrolls horizontally on a phone');
      assert.equal(table.lastVisible, true, '5-cost column is cut off');
      assert.equal(table.lastText, '35%');
    } finally {
      await session.cleanup();
    }
  });

test('star level changes the odds and survives a reload', { timeout: 120000 }, async () => {
  const session = await launchBrowser();
  try {
    const go = async (query) => {
      await session.cdp.call('Page.navigate', {
        url: `http://127.0.0.1:${session.appPort}/rolls/${query}`,
      });
      await waitFor(() => session.cdp.evaluate(
        `Boolean(document.querySelector('#starSeg button'))`));
    };

    await go('?lv=8&c=4&g=50&s=1');
    const single = await session.cdp.evaluate(
      `document.getElementById('bigPct').textContent`);

    // Clicking 2-star must lower the number and say so in words.
    await session.cdp.evaluate(
      `document.querySelector('#starSeg button[data-star="2"]').click()`);
    const twoStar = await session.cdp.evaluate(`({
      pct: document.getElementById('bigPct').textContent,
      sub: document.getElementById('bigSub').textContent,
      url: location.search,
      pressed: document.querySelector('#starSeg button[data-star="2"]')
        .getAttribute('aria-pressed'),
    })`);

    assert.match(twoStar.sub, /3 copies/, 'headline should name the copy count');
    assert.equal(twoStar.pressed, 'true');
    assert.match(twoStar.url, /s=2/, 'star level belongs in the URL');
    assert.ok(parseFloat(twoStar.pct) < parseFloat(single),
      `2-star ${twoStar.pct} should be harder than 1-star ${single}`);

    // The URL must actually restore that state on a fresh load.
    await go('?lv=8&c=4&g=50&s=2');
    const restored = await session.cdp.evaluate(
      `document.getElementById('bigPct').textContent`);
    assert.equal(restored, twoStar.pct, 's=2 should round-trip through the URL');

    // Tiny-but-possible odds must not render as a flat 0%, which would be
    // indistinguishable from a genuinely impossible ask.
    await go('?lv=8&c=4&g=50&s=3');
    const longShot = await session.cdp.evaluate(`({
      pct: document.getElementById('bigPct').textContent,
      exact: window.RollOdds.rollChance(4, 8, 25, { need: 9 }),
    })`);
    assert.ok(longShot.exact > 0, 'this ask is a long shot, not impossible');
    assert.notEqual(longShot.pct, '0%', 'a possible outcome must not read as 0%');
    assert.notEqual(longShot.pct, '0.0%', 'a possible outcome must not read as 0.0%');
  } finally {
    await session.cleanup();
  }
});
