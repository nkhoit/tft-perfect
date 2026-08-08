import assert from 'node:assert/strict';
import test from 'node:test';

import { launchBrowser, waitFor } from './browser-harness.mjs';

// The page must answer the mid-game question: take the cashout in front of me,
// or push for the next one. That means real rows with real health numbers, not
// an empty table -- and the deep cashouts must be marked as the traps they are.
const PROBE = `(() => {
  const rows = [...document.querySelectorAll('#rows tr')].map(tr => ({
    cls: tr.className,
    cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim()),
  }));
  return {
    rows: rows.length,
    ok: rows.filter(r => r.cls === 'ok').length,
    dead: rows.filter(r => r.cls === 'dead').length,
    verdict: document.getElementById('verdict').textContent,
    first: rows[0] ? rows[0].cells : [],
    all: rows,
  };
})()`;

test('the coven page prices a cashout in health', async (t) => {
  const session = await launchBrowser();
  t.after(() => session.cleanup());

  await session.cdp.call('Page.navigate',
    { url: `http://127.0.0.1:${session.appPort}/coven/` });
  await waitFor(async () => (await session.cdp.evaluate(PROBE)).rows > 0, 30000);

  // Mid-game mode: 3-5, Coven 5, 186 essence, 68 health. This is the spot the
  // whole tool exists for -- L5 is safe, L6 lands in single digits.
  await session.cdp.evaluate(`(() => {
    document.getElementById('modeNow').click();
    document.getElementById('tier').value = '5';
    document.getElementById('from').value = '3-5';
    document.getElementById('essence').value = '186';
    document.getElementById('hp').value = '68';
    for (const id of ['tier','from','essence','hp'])
      document.getElementById(id).dispatchEvent(new Event('change'));
  })()`);

  const seen = await session.cdp.evaluate(PROBE);

  assert.equal(seen.rows, 9, 'every cashout level gets a row');
  assert.ok(seen.ok > 0, 'at least one cashout must be affordable here');
  assert.ok(seen.dead > 0, 'the deep cashouts must be marked unreachable');

  // L5 is the recommendation; L6 survives but only just; L7 kills you.
  const l5 = seen.all[4], l6 = seen.all[5], l7 = seen.all[6];
  assert.equal(l5.cls, 'ok', 'L5 is affordable from 186 essence at 68 health');
  assert.equal(l6.cls, 'risky', 'L6 lands on fumes and must not read as safe');
  assert.equal(l7.cls, 'dead', 'L7 cannot be reached alive');
  assert.match(seen.verdict, /L5/, 'the verdict names the deepest safe cashout');

  // The health column must be a real band, not a single fabricated number.
  assert.match(l6.cells[4], /\d+ - \d+/,
    'health is reported as a range across the kill band');

  // Pin the ACTUAL numbers, not just the labels. Class names alone are vacuous:
  // dropping levels 7/8/9 from the curve still yields ok/risky/dead here while
  // silently shifting health by 5-7 per row, because a shorter curve means
  // smaller boards and cheaper losses. The digits are what prove the curve fed
  // through.
  assert.equal(l5.cells[3], '3-6 - 3-7', 'L5 lands late stage 3');
  assert.equal(l5.cells[4], '42 - 51', 'L5 health band on the standard curve');
  assert.equal(l6.cells[3], '4-2 - 4-3', 'L6 lands early stage 4');
  assert.equal(l6.cells[4], '1 - 15', 'L6 really does land on fumes');
});
