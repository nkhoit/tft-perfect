const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'traits');

// Mirrors the shipped solver-worker enumeration loop and its stop-reason
// bookkeeping. Phase 2 stops for two reasons -- the time budget and the
// `want` row cap -- and BOTH mean boards below the cut were never scored.
function enumerate({ candidates, want, budgetHit = false }) {
  let solvedRosters = 1;
  let exhausted = false;
  let rowsComplete = true;
  let stopReason = null;
  while (solvedRosters < want) {
    if (budgetHit) { rowsComplete = false; stopReason = 'budget'; break; }
    if (solvedRosters >= candidates) { exhausted = true; break; }
    solvedRosters++;
  }
  // The shipped check.
  if (!exhausted) {
    rowsComplete = false;
    stopReason = stopReason || 'cap';
  }
  return { rowsComplete, stopReason, solvedRosters };
}

test('hitting the row cap is reported as truncation', () => {
  // 50 boards available, only 8 slots: ranks 9..50 are never scored.
  const r = enumerate({ candidates: 50, want: 8 });
  assert.equal(r.solvedRosters, 8);
  assert.equal(
    r.rowsComplete, false,
    'stopping at the row cap leaves boards unscored, so the list is truncated');
  assert.equal(r.stopReason, 'cap');
});

test('a genuinely exhausted search is still reported complete', () => {
  // Only 3 boards exist and 8 slots: enumeration ran out of candidates.
  const r = enumerate({ candidates: 3, want: 8 });
  assert.equal(r.rowsComplete, true, 'exhausting the space is not truncation');
  assert.equal(r.stopReason, null);
});

test('the time budget is still reported as truncation', () => {
  const r = enumerate({ candidates: 50, want: 8, budgetHit: true });
  assert.equal(r.rowsComplete, false);
  assert.equal(r.stopReason, 'budget');
});
