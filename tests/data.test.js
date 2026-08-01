const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the application contains only Set 18', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'build_data.py')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'web', 'data-set18.json')), false);

  const data = JSON.parse(read('web/data.json'));
  const html = read('web/index.html');
  const app = read('web/app.js');
  const readme = read('README.md');

  assert.equal(data.set, 'set18');
  assert.match(html, /Set 18/);
  assert.doesNotMatch(html + app + readme, /Set 17|set17|data-set18/);
  assert.doesNotMatch(html, /id="setSel"/);
  assert.match(app, /descResolved \|\| a\.desc/);
});

test('the generated data and checked-in roster are internally consistent', () => {
  const data = JSON.parse(read('web/data.json'));
  const roster = JSON.parse(read('set18-roster.json'));
  const champions = new Map(data.champions.map(champion => [champion.key, champion]));

  assert.equal(roster.length, data.champions.length);
  for (const source of roster) {
    const key = source.apiName.replace(/^TFT18_/, '');
    const champion = champions.get(key);
    assert.ok(champion, `missing generated champion ${key}`);
    assert.equal(champion.cost, source.cost);
    assert.ok(champion.icon, `${key} has no icon`);
    assert.ok(champion.stats, `${key} has no stats`);
    assert.ok(champion.ability?.descResolved, `${key} has no resolved ability text`);
    assert.deepEqual(champion.manaReveal || champion.mana, source.mana);
    assert.deepEqual(champion.traits.map(trait => data.traits[trait].name), source.traits);
    for (const trait of champion.traits) {
      assert.ok(data.traits[trait], `${key} references missing trait ${trait}`);
    }
  }
  for (const trait of Object.values(data.traits)) {
    assert.ok(trait.icon, `${trait.name} has no icon`);
    assert.ok(trait.bp.length, `${trait.name} has no breakpoints`);
  }
});
