const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TRAITS = path.join(__dirname, '..', 'web', 'traits');
const db = JSON.parse(fs.readFileSync(path.join(TRAITS, 'data.json'), 'utf8'));
const CompQuality = require('../web/traits/comp-quality.js');
const BoardScore = require('../web/traits/board-score.js');

// Two boards Khoi plays and rates S-tier. They score only live=6, far below
// the solver's live=14 optima -- so trait count cannot be what makes a comp
// good. These are the ground truth the quality model has to agree with.
const APHELIOS = '023fa4034224283ef3f343c430000000TFTSet18';
const AP_BOARD = '023f14003ed41442e43c40b415000000TFTSet18';

function load(code) {
  const decoded = CompQuality.decodeTeamCode(db, code);
  assert.ok(decoded.ok, 'code should decode');
  assert.equal(decoded.unknown.length, 0, 'every id should map to a champion');
  const tables = BoardScore.tables(db);
  const score = BoardScore.scoreRoster(db, tables, decoded.roster, [], []);
  return {
    decoded,
    score,
    tables,
    roster: decoded.roster,
    quality: CompQuality.evaluate(db, decoded.roster, score, tables),
  };
}

test('decodes a team planner code into the right roster', () => {
  const { decoded } = load(APHELIOS);
  const keys = decoded.roster.map(index => db.champions[index].key).sort();
  assert.deepEqual(keys, ['AncientSentinel', 'Aphelios', 'Brambleback', 'Diana',
    'Hecarim', 'Raptor', 'Taric', 'Zyra'].sort());
});

test('declared carries decide the item plan, not the role field', () => {
  const { roster, score, tables } = load(APHELIOS);
  // Zyra and Alune are BOTH top-tier AP casters. On this board Zyra is a body
  // for Summoner; on the level-9 board Alune is the whole game plan. Nothing
  // in the data separates them, so the player declares it.
  const quality = CompQuality.evaluate(db, roster, score, tables, ['Aphelios', 'Brambleback']);
  assert.deepEqual(quality.carries.sort(), ['Aphelios', 'Brambleback']);
  assert.equal(quality.carriesInferred, false);
  assert.deepEqual(quality.damageTypes, ['AD']);
  assert.ok(quality.itemCoherent, 'both carries are AD: ' + quality.notes.join('; '));
  assert.equal(quality.itemPlan, 'AD package');
  assert.ok(!quality.carries.includes('Zyra'), 'undeclared units never hold items');
});

test('declaring Zyra a carry DOES report the split it would cause', () => {
  const { roster, score, tables } = load(APHELIOS);
  // Guard: the previous test must pass because of the declaration, not because
  // the model is blind to Zyra. Itemizing her really would cost a 2nd package.
  const quality = CompQuality.evaluate(db, roster, score, tables, ['Aphelios', 'Zyra']);
  assert.deepEqual(quality.damageTypes.sort(), ['AD', 'AP']);
  assert.equal(quality.itemCoherent, false);
  assert.equal(quality.itemPlan, 'split -- two packages');
});

test('the all-AP board is item-coherent too', () => {
  const { quality } = load(AP_BOARD);
  assert.ok(quality.itemCoherent, quality.notes.join('; '));
  assert.ok(quality.frontline >= 3, 'has a real frontline');
});

// Guards: a model that calls every board good is worthless. These prove the
// checks can actually fail.
test('flags a board whose carries split AD and AP', () => {
  const byKey = key => db.champions.findIndex(c => c.key === key);
  // Aphelios (ADCarry) and Morgana (APCaster) are both 4-costs and NEITHER is
  // an Adaptor, so their damage types really are locked -- itemizing both needs
  // Shred AND Sunder. (Nidalee would NOT work here: she is Adaptor, so she
  // flexes to whichever package you already build.)
  const roster = ['Aphelios', 'Morgana', 'Malphite', 'Taric'].map(byKey);
  assert.ok(roster.every(index => index >= 0), 'fixture units must exist');
  const quality = CompQuality.evaluate(db, roster, null);
  assert.equal(quality.itemCoherent, false);
  assert.deepEqual(quality.damageTypes.sort(), ['AD', 'AP']);
  assert.ok(quality.notes.some(note => /Shred and Sunder/.test(note)));
});

test('flags an all-tank board as having no carry', () => {
  const byKey = key => db.champions.findIndex(c => c.key === key);
  const roster = ['Malphite', 'Taric', 'AncientSentinel'].map(byKey);
  const quality = CompQuality.evaluate(db, roster, null);
  assert.equal(quality.itemCoherent, false);
  assert.ok(quality.notes.some(note => /no itemized carry/.test(note)));
});

test('flags a backline-only board as a thin frontline', () => {
  const byKey = key => db.champions.findIndex(c => c.key === key);
  const roster = ['Aphelios', 'Zyra', 'Soraka'].map(byKey);
  const quality = CompQuality.evaluate(db, roster, null);
  assert.ok(quality.notes.some(note => /thin frontline/.test(note)));
});

// Kog'Maw's Caustic trait Shreds and Sunders for free, which is exactly what
// lets a board run split-damage carries without building both packages.
test('a free shred/sunder source lifts the split-damage penalty', () => {
  const byKey = key => db.champions.findIndex(c => c.key === key);
  // Use a genuinely locked pair (neither is an Adaptor) so the baseline really
  // is a conflict; Kog'Maw's Caustic trait is what lifts it.
  const split = ['Aphelios', 'Morgana', 'Malphite', 'Taric'].map(byKey);
  const freed = [...split, byKey('KogMaw')];
  assert.ok(freed.every(index => index >= 0), 'fixture units must exist');

  const before = CompQuality.evaluate(db, split, null);
  const after = CompQuality.evaluate(db, freed, null);

  assert.equal(before.itemCoherent, false, 'without Kog\'Maw the split is a real cost');
  assert.equal(after.itemCoherent, true, 'Kog\'Maw frees the split');
  assert.deepEqual(after.freeShred, ['KogMaw']);
  assert.ok(after.notes.some(note => /freed by KogMaw/.test(note)));
});

// Adaptor units read whichever stat is higher, so how you itemize them decides
// their damage type. They must never be reported as an item conflict.
test('an Adaptor carry flexes instead of splitting the item package', () => {
  const byKey = key => db.champions.findIndex(c => c.key === key);
  // Nidalee is listed APCarry but has Adaptor, so pairing her with the AD
  // Aphelios is fine -- you simply build her AD.
  const roster = ['Aphelios', 'Nidalee', 'Malphite', 'Taric'].map(byKey);
  assert.ok(roster.every(index => index >= 0), 'fixture units must exist');
  const quality = CompQuality.evaluate(db, roster, null);
  assert.equal(quality.itemCoherent, true, 'Adaptor must not force a 2nd package');
  assert.ok(quality.notes.some(note => /Adaptor/.test(note)), 'flexibility should be surfaced');
});
