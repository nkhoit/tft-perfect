const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { decode, encode } = require('../web/traits/team-code.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'traits', 'data.json'), 'utf8'));
const byName = new Map(data.champions.flatMap(champion => [
  [champion.name.toLowerCase(), champion],
  [champion.key.toLowerCase(), champion],
]));

const samples = [
  {
    code: '023f742942040043742841242c000000TFTSet18',
    names: ['Cinderling', 'Pebbles', 'Rakan', 'Fiddlesticks', 'Vi', 'AncientSentinel', 'Lillia', 'Sivir'],
  },
  {
    code: '023ef43c4224283fa4033f3430000000TFTSet18',
    names: ['Aphelios', 'Zyra', 'Raptor', 'AncientSentinel', 'Diana', 'Hecarim', 'Brambleback', 'Taric'],
  },
  {
    code: '0242e3e93f13ed43b43a42b412400000TFTSet18',
    names: ['Soraka', 'Ahri', 'Azir', 'Amumu', 'Yunara', 'Yorick', 'Shen', 'Lillia', 'Fiddlesticks'],
  },
];

for (const sample of samples) {
  test(`decodes and re-encodes ${sample.code.slice(0, 8)}...`, () => {
    const champions = sample.names.map(name => byName.get(name.toLowerCase()));
    assert.ok(champions.every(Boolean));
    assert.deepEqual(decode(sample.code), champions.map(champion => champion.teamPlannerCode));
    assert.equal(encode(champions), sample.code);
  });
}

test('rejects a champion without an authoritative planner code', () => {
  assert.throws(() => encode([{ key: 'Missing', name: 'Missing' }]), /No team-planner code/);
});

test('rejects malformed and wrong-set codes', () => {
  assert.throws(() => decode('not-a-code'), /Invalid TFTSet18/);
  assert.throws(() => decode(samples[0].code.replace('TFTSet18', 'TFTSet17')), /Invalid TFTSet18/);
});
