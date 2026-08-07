import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// The solver proves the TOP board optimal in phase one, then enumerates the
// rest of the ranked list under a time budget in phase two. When that budget
// runs out the list is a truncated sample, but the status line used to show a
// bare "optimal" badge -- which reads as "this list is complete" and makes
// two searches with different constraints look contradictory.
// Regression: https://tftkit.com/traits/ with ~20k candidate boards.

const BIG = 'dFcqxCoAgFEDRf7nzG7LRvSHoD8QpHyVJgpEJ0b-H44HzUrGjkLBmENqGdSx3wwuKdY4pBS1PzgExXhzzWfOhpcsLV_8pVkUocd3x3w8';

const PROBE = `(() => {
  const el = document.getElementById('status');
  return {
    text: (el && el.textContent) || '',
    html: (el && el.innerHTML) || '',
  };
})()`;

test('a budget-truncated list says so instead of a bare "optimal"', { timeout: 300000 }, async t => {
  const session = await launchBrowser();
  try {
    await session.cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${session.appPort}/traits/?s=${BIG}`,
    });

    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return /optimal|stopped early|searched in/.test(s.text)
        && !/finding more/.test(s.text);
    }, 240000);

    const status = await session.cdp.evaluate(PROBE);

    // On slow/loaded CI runners phase ONE can itself exhaust the budget and
    // report "stopped early". That is a different (and correctly disclosed)
    // state, not the truncation bug this test guards -- treat it as a skip
    // rather than a failure, so the assertion below never silently weakens.
    if (/stopped early/.test(status.text)) {
      t.skip(`phase one did not finish within budget on this machine: ${status.text}`);
      return;
    }

    // This search proves an optimum but cannot enumerate all ~20k boards, so
    // the user must be told the list below row 1 is a sample.
    assert.match(status.text, /optimal/,
      'phase one still proves the top board optimal');
    assert.match(status.text, /truncated|incomplete/,
      `a budget-truncated list must disclose truncation, got: ${status.text}`);
  } finally {
    await session.cleanup();
  }
});

// The counterpart to the truncation test: a search small enough to enumerate
// completely must NOT show the badge. Without this, "always truncated" would
// pass the test above while being just as misleading as "always optimal".
test('a search that completes does not claim truncation', { timeout: 300000 }, async () => {
  const session = await launchBrowser();
  try {
    // Tiny board + a hard unit requirement collapses the search space enough
    // that phase two can exhaust it within budget.
    await session.cdp.call('Page.navigate', {
      url: `http://127.0.0.1:${session.appPort}/traits/?l=3`,
    });

    await waitFor(async () => {
      const s = await session.cdp.evaluate(PROBE);
      return /optimal|stopped early|searched in/.test(s.text)
        && !/finding more/.test(s.text);
    }, 240000);

    const status = await session.cdp.evaluate(PROBE);
    assert.doesNotMatch(status.text, /truncated/,
      `a fully enumerated search must not claim truncation, got: ${status.text}`);
  } finally {
    await session.cleanup();
  }
});
