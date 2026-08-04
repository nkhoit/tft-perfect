const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function runChecker(mana) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tft-patch-notes-'));
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    champions: [{
      key: 'Unit',
      name: 'Unit',
      mana: { start: 0, max: 50 },
      ability: { descResolved: 'Deals 10/20/30 damage.', stats: [] },
    }],
    traits: {},
  }));
  fs.writeFileSync(path.join(notes, 'patch.json'), JSON.stringify({
    label: 'test',
    champions: [{
      name: 'Unit',
      changes: [
        { field: 'Mana', to: mana },
        { field: 'Damage', to: '10/20/30' },
      ],
    }],
  }));

  try {
    return spawnSync(PYTHON, [
      path.join(ROOT, 'check_patch_notes.py'),
      notes,
      '--data', path.join(dir, 'data.json'),
    ], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('patch-note checker succeeds when checked values match', () => {
  const result = runChecker('0/50');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MATCH/);
  assert.match(result.stdout, /found/);
});

test('patch-note checker fails when a checked value drifts', () => {
  const result = runChecker('0/60');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /DRIFT/);
});

test('checked-in patch notes match the shipped data', () => {
  // The 2026-08-04 PBE values were hand-applied because CommunityDragon had
  // not shipped that patch. Run the real checker against the real data so a
  // rebuild that reverts them fails here instead of silently shipping.
  const notes = path.join(ROOT, 'patch_notes');
  assert.ok(fs.existsSync(notes), 'patch_notes directory should exist');
  const files = fs.readdirSync(notes).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0, 'expected at least one patch-note file');

  const res = spawnSync(PYTHON, [
    path.join(ROOT, 'check_patch_notes.py'),
    notes,
    '--data', path.join(ROOT, 'web', 'traits', 'data.json'),
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0,
    `patch-note drift against shipped data:\n${res.stdout}${res.stderr}`);
});
