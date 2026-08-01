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
  const css = read('web/style.css');
  const readme = read('README.md');

  assert.equal(data.set, 'set18');
  assert.equal(data.teamPlannerSet, 'TFTSet18');
  assert.match(html, /Set 18/);
  assert.doesNotMatch(html + app + readme, /Set 17|set17|data-set18/);
  assert.doesNotMatch(html, /id="setSel"/);
  assert.match(app, /ability\.descResolved \|\| ability\.desc/);
  assert.match(app, /aria-label="Copy TFT Team Planner code"/);
  assert.match(app, /class="copyicon"/);
  assert.doesNotMatch(app, />Copy team code<\/button>/);
  assert.match(app, /`<div class="compmeta">` \+\s*copyCodeButton\(r\.units\)/);
  assert.match(css, /\.compmeta>\.copycode\{[^}]*margin:0/);
  assert.match(css, /\.comp>\.vlist\{[^}]*grid-column:1\/-1/);
  assert.match(css, /#traitGrid\{grid-template-columns:repeat\(5,1fr\)\}/);
  assert.match(css, /#embGrid\{grid-template-columns:repeat\(6,1fr\)\}/);
  assert.match(app, /function unitPortrait/);
  assert.match(app, /class="un"/);
  assert.match(app, /<button type="button" class="vtag" aria-expanded="false"/);
  assert.match(app, /alternate\$\{nv > 1 \? 's' : ''\}/);
  assert.match(app, /vt\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(css, /\.vchev\{/);
  assert.match(app, /STAT_ICON_BASE/);
  assert.match(app, /class="si"/);
  assert.match(css, /\.si\{/);
  assert.match(app, /function abilityDescription/);
  assert.match(app, /class="amode /);
  assert.match(app, /class="amodekey"><b>Adaptor<\/b>/);
  assert.match(app, /class="amodestat"/);
  assert.match(css, /\.amode\{/);
  assert.match(app, /THREE_STAR_ICON/);
  assert.match(app, /class="tupgrade"/);
  assert.match(css, /\.tupgrade\{/);
  assert.doesNotMatch(app, /class="kc"/);
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
    assert.ok(Number.isInteger(champion.teamPlannerCode), `${key} has no team-planner code`);
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
  const duplicatePlannerCodes = [...Map.groupBy(data.champions, champion => champion.teamPlannerCode)]
    .filter(([, champions]) => champions.length > 1);
  assert.equal(duplicatePlannerCodes.length, 1);
  assert.equal(duplicatePlannerCodes[0][0], 0x413);
  assert.ok(duplicatePlannerCodes[0][1].every(champion => champion.key.startsWith('Lux')));

  const elderDragon = champions.get('ElderDragon');
  assert.equal(elderDragon.slots, 2);
  assert.equal(elderDragon.traitPoints.Riftbeast, 3);

  const luxForms = data.champions.filter(champion => champion.key.startsWith('Lux'));
  assert.equal(luxForms.length, 9);
  for (const lux of luxForms) {
    const origin = lux.traits.find(trait => trait !== 'Avatar');
    assert.equal(lux.group, 'Lux');
    assert.equal(lux.traitPoints[origin], 2);
  }
  assert.deepEqual(data.traits.Riftbeast.teamSize, [{ min: 10, slots: 2 }]);
  assert.deepEqual(data.traits.Riftbeast.teamSize, [{ min: 10, slots: 2 }]);
  assert.ok(data.traits.Adaptor.tiers.every(tier =>
    tier.includes('%i:scaleAD%') && tier.includes('%i:scaleAP%')));
  assert.ok(data.traits.Defender.tiers.every(tier =>
    tier.includes('%i:scaleArmor%') && tier.includes('%i:scaleMR%')));
  assert.deepEqual(data.traits.Solar.upgrades.map(upgrade => upgrade.count), [1, 3, 5, 8]);
  assert.doesNotMatch(data.traits.Solar.tiers[0], /\b1\s*:/);

  const adaptors = data.champions.filter(champion => champion.traits.includes('Adaptor'));
  assert.equal(adaptors.length, 5);
  for (const adaptor of adaptors) {
    const modes = adaptor.ability.sections.filter(section => section.mode)
      .map(section => section.mode).sort();
    assert.deepEqual(modes, ['AD', 'AP'], `${adaptor.key} is missing an Adaptor ability mode`);
  }
});
