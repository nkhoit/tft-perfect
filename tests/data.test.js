const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the application contains only Set 18', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'build_data.py')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'web', 'traits', 'data-set18.json')), false);

  const data = JSON.parse(read('web/traits/data.json'));
  const html = read('web/traits/index.html');
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');
  const readme = read('README.md');

  assert.equal(data.set, 'set18');
  assert.equal(data.teamPlannerSet, 'TFTSet18');
  assert.match(html, /Set 18/);
  assert.match(html, /id="effort"/);
  assert.match(html, /id="refine"/);
  assert.match(html, /id="share"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /twitter:card/);
  assert.match(html, /id="saveSearch"/);
  assert.match(html, /id="savedList"/);
  assert.match(html, /src="saved-searches\.js\?v=milp-hybrid-v7"/);
  assert.match(html, /src="share-state\.js\?v=milp-hybrid-v7"/);
  assert.doesNotMatch(html + app + readme, /Set 17|set17|data-set18/);
  assert.doesNotMatch(html, /id="setSel"/);
  assert.match(app, /ability\.descResolved \|\| ability\.desc/);
  assert.match(app, /aria-label="Copy TFT Team Planner code"/);
  assert.match(app, /class="copyicon"/);
  assert.doesNotMatch(app, />Copy team code<\/button>/);
  assert.match(app, /`<div class="comphead"><div class="tline">/);
  assert.match(css, /\.comprow>\.copycode\{[^}]*margin:0/);
  assert.match(css, /\.comp>\.vlist\{[^}]*margin-top:0/);
  assert.match(css, /#traitGrid\{grid-template-columns:repeat\(5,1fr\)\}/);
  assert.match(css, /#embGrid\{grid-template-columns:repeat\(6,1fr\)\}/);
  assert.match(app, /function unitPortrait/);
  assert.match(app, /class="un"/);
  assert.match(app, /<button type="button" class="vtag" aria-expanded="false"/);
  assert.match(app, /alternate\$\{count > 1 \? 's' : ''\}/);
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
  assert.match(app, /ROLE_ICON_BASE/);
  assert.match(app, /function roleBadge/);
  assert.match(app, /class="crole"/);
  assert.match(app, /scaleDA:/);
  assert.match(css, /\.crole\{/);
  assert.match(app, /function abilityText/);
  assert.match(app, /class="alabel"/);
  assert.match(css, /\.apara\{/);
  assert.match(app, /class="tdetails"/);
  assert.match(css, /\.tdetail\{/);
  assert.match(app, /class="stars"/);
  assert.match(css, /\.stars\{/);
  assert.match(app, /function traitUnitStrip/);
  assert.match(app, /class="tunits"/);
  assert.match(css, /\.tunit\{/);
  assert.match(app, /function teamProfile/);
  assert.match(app, /class="teamprofile/);
  assert.match(app, /endsWith\('Tank'\)/);
  assert.match(css, /\.profilepart\{/);
  assert.match(app, /function portraitRoleBadge/);
  assert.match(app, /class="rtype /);
  assert.match(app, /traits\.includes\('Adaptor'\)/);
  assert.match(css, /\.rtype\{/);
  assert.match(app, /DEBOUNCE_MS/);
  assert.match(app, /indexedDB/);
  assert.match(app, /TFTSearchMetrics/);
  assert.match(app, /recordMetric\('cancellations'\)/);
  assert.match(app, /function showPrecomputedLanding/);
  assert.match(app, /const EFFORTS/);
  assert.match(app, /function updateRefineButton/);
  assert.match(app, /timeBudgetMs/);
  assert.match(app, /cached: 'precomputed'/);
  assert.match(app, /function sharedSearchState/);
  assert.match(app, /function applySharedSearchState/);
  assert.match(app, /function previewShareUrl/);
  assert.match(app, /fetch\('\/api\/shorten'/);
  assert.match(app, /fetch\(payload\.prewarm/);
  assert.match(app, /keepalive: true/);
  assert.match(app, /fetch\('\/api\/ready'/);
  assert.match(app, /Falling back to the stateless share URL/);
  assert.match(app, /shared\.sel/);
  assert.match(app, /const SHARE_SCHEMA_VERSION = 2/);
  assert.match(app, /shared\.v < 1 \|\| shared\.v > SHARE_SCHEMA_VERSION/);
  assert.match(app, /class="previewcomp"/);
  assert.match(app, /class="previewicon"/);
  assert.match(app, /function renderSavedSearches/);
  assert.match(app, /function restoreSavedEntry/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /function reconcileResultCards/);
  assert.match(app, /list\.insertBefore\(card, cursor\)/);
  assert.match(app, /function syncVariants/);
  assert.match(css, /\.savedlist\{/);
  assert.match(css, /\.comp\.entering\{animation:comp-enter/);
  assert.doesNotMatch(app, /class="kc"/);
});

test('required units use check badges without replacing cost borders', () => {
  const css = read('web/traits/style.css');

  assert.doesNotMatch(css, /\.u\.req\{[^}]*(?:border|box-shadow)/);
  assert.doesNotMatch(css, /\.uc\.req\{[^}]*(?:border|box-shadow)/);
  assert.match(css, /\.u\.req::before,\.uc\.req::before\{[^}]*content:"\\2713"/);
  assert.match(css, /\.u\.req::before,\.uc\.req::before\{[^}]*top:[^;]+;right:/);
});

test('featured preview controls only render in the selected section', () => {
  const app = read('web/traits/app.js');

  assert.match(app,
    /function compCard\(r, \{ selected = false, showPreview = false, upgrade = false \} = \{\}\)/);
  assert.match(app, /const previewButton = showPreview/);
  assert.match(app, /compCard\(r, \{ selected: true, showPreview: true \}\)/);
  assert.match(app, /card\.querySelector\('\.previewcomp'\)\?\.remove\(\)/);
});

test('result cards expose isolated desktop and mobile upgrade paths', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  assert.match(app, /class="upgradepath"/);
  assert.match(app, /class="upgradepanel"/);
  assert.match(app, /keepIdx: \[\.\.\.upgradeState\.source\.units\]/);
  assert.match(app, /resultMode: 'roster'/);
  assert.match(app, /if \(e\.target\.closest\('\.upgradepanel'\)\) return/);
  assert.match(app, /openSheet\(upgradePanelMarkup\(upgradeState\), 'upgrade'/);
  assert.match(app, /if \(kind === 'upgrade'\) return ''/);
  assert.match(app, /No board that keeps exactly \$\{upgradeState\.keep\}/);
  assert.match(app, /class="upchamp \$\{kind\}"/);
  assert.match(app, /class="upchampmark"/);
  assert.match(app, /class="uptrait \$\{kind\}"/);
  assert.match(css, /\.upchamp\.add\{[^}]*border-color:var\(--acc\)/);
  assert.match(css, /\.upchamp\.remove\{[^}]*border-color:var\(--red\)/);
  assert.match(css, /\.uptrait\.add\{[^}]*color:var\(--acc\)/);
  assert.match(css, /\.uptrait\.remove\{[^}]*color:var\(--red\)/);
  assert.match(css, /\.sheetfoot\[hidden\]\{display:none\}/);
});

test('v7 assets revalidate without weakening immutable vendor caching', () => {
  const html = read('web/traits/index.html');
  const app = read('web/traits/app.js');
  const config = JSON.parse(read('staticwebapp.config.json'));
  const routes = config.routes.map(route => route.route);

  assert.match(html, /style\.css\?v=milp-hybrid-v7/);
  assert.match(html, /search-utils\.js\?v=milp-hybrid-v7/);
  assert.match(html, /solver-scheduler\.js\?v=milp-hybrid-v7/);
  assert.match(html, /app\.js\?v=milp-hybrid-v7/);
  assert.match(app, /solver-worker\.js\?v=milp-hybrid-v7/);
  assert.ok(routes.indexOf('/traits/vendor/*') < routes.indexOf('/traits/*'));
  assert.equal(
    config.routes.find(route => route.route === '/traits/vendor/*')
      .headers['Cache-Control'],
    'public, max-age=31536000, immutable');
  assert.equal(
    config.routes.find(route => route.route === '/traits/*')
      .headers['Cache-Control'],
    'no-cache');
});

test('filters collapse responsively and remember the user preference', () => {
  const html = read('web/traits/index.html');
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  assert.match(html, /id="filtersToggle"[^>]*aria-controls="filtersContent"[^>]*aria-expanded="true"/);
  assert.match(html, /id="filtersContent"/);
  assert.match(app, /const FILTERS_STORAGE_KEY/);
  assert.match(app, /matchMedia\('\(max-width: 820px\)'\)\.matches/);
  assert.match(app, /localStorage\.setItem\(FILTERS_STORAGE_KEY/);
  assert.match(app, /function setFiltersCollapsed/);
  assert.match(css, /\.wrap\.filters-collapsed\{grid-template-columns:/);
  assert.match(css, /\.sidecontent\[hidden\]\{display:none\}/);
  assert.match(css, /@media\(max-width:820px\)\{[\s\S]*\.wrap\.filters-collapsed\{grid-template-columns:1fr\}/);
});

test('selection badges contrast with role badge styling', () => {
  const css = read('web/traits/style.css');
  const badge = css.match(/\.u\.req::before,\.uc\.req::before\{([^}]*)\}/)?.[1];

  assert.ok(badge, 'missing selection badge styling');
  assert.match(badge, /top:2px;right:2px/);
  assert.match(badge, /width:16px;height:16px/);
  assert.match(badge, /border:1px solid #b7f7cb/);
  assert.match(badge, /border-radius:50%/);
  assert.match(badge, /background:var\(--acc\);color:#fff/);
  assert.match(badge, /box-shadow:0 1px 3px #000b/);
  assert.match(css,
    /\.(?:vrow|comprow\.alternate) \.uc\.req::before\{[^}]*transform:scale\(\.85\);transform-origin:top right/);
});

test('unit picker portraits include role badges', () => {
  const app = read('web/traits/app.js');
  const addUnit = app.match(
    /function addUnit\(el, c, group\) \{([\s\S]*?)\r?\n\}\r?\n\r?\nfunction applyFilter/);

  assert.ok(addUnit, 'missing unit picker renderer');
  assert.match(addUnit[1], /\$\{portraitRoleBadge\(c\)\}/);
});

test('result unit portraits toggle required state', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  assert.match(app, /e\.target\.closest\('\.uc\[data-key\]'\)/);
  assert.match(app,
    /setUnitState\(unit\.dataset\.key, state\.get\(unit\.dataset\.key\) === 1 \? 0 : 1\)/);
  assert.match(app, /querySelectorAll\('\.u\[data-key\], \.uc\[data-key\]'\)/);
  assert.match(css, /\.uc\{[^}]*cursor:pointer/);
});

test('unit picker switches between cost, origin, and class groups', () => {
  const html = read('web/traits/index.html');
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  assert.match(html, /id="poolViewCost"/);
  assert.match(html, /id="poolViewOrigin"/);
  assert.match(html, /id="poolViewClass"/);
  assert.doesNotMatch(html, /id="poolViewTrait"/);
  assert.doesNotMatch(html + app + css, /traitLens|traitlens|unitTraitLens|traitdim/);
  assert.match(app, /const POOL_VIEWS = new Set\(\['cost', 'origin', 'class'\]\)/);
  assert.match(app, /let poolView = 'cost'/);
  assert.match(app, /function buildPoolByCost\(/);
  assert.match(app, /function buildPoolByCategory\(/);
  assert.match(app, /trait\.category === category/);
  assert.match(app, /section\.className = 'traitgroup'/);
  assert.match(app, /unitGrid\.className = 'traitunits'/);
  assert.match(app, /function setUnitState\(/);
  assert.match(app, /querySelectorAll\('\.u\[data-key\]'\)/);
  assert.match(app, /d\.dataset\.group = group/);
  assert.match(app, /shown\.set\(d\.dataset\.group/);
  assert.match(app, /closest\('\.traitgroup'\)/);
  assert.match(app, /if \(poolView !== 'cost'\) shared\.g = poolView/);
  assert.match(app, /POOL_VIEWS\.has\(shared\.g\)/);
  assert.match(css, /\.pooltabs\{/);
  assert.match(css, /\.traithdr\{/);
  assert.match(css, /\.picker\{[^}]*container-type:inline-size/);
  assert.match(css, /@container \(min-width:620px\)\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@container \(min-width:930px\)\{[^}]*repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.traitunits\{[^}]*repeat\(auto-fill,minmax\(64px,1fr\)\)/);
});

test('group exclusions collapse all champion forms into one control', () => {
  const data = JSON.parse(read('web/traits/data.json'));
  const html = read('web/traits/index.html');
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');
  const luxForms = data.champions.filter(champion => champion.group === 'Lux');

  assert.equal(luxForms.length, 9);
  assert.match(html, /id="groupExclusions"/);
  assert.match(html, /id="groupExclusionList"/);
  assert.match(app, /const excludedGroups = new Set\(\)/);
  assert.match(app, /function formGroups\(/);
  assert.match(app, /function buildGroupExclusions\(/);
  assert.match(app, /function setGroupExcluded\(/);
  assert.match(app, /function isGroupExcluded\(/);
  assert.match(app, /else if \(s === 2 \|\| isGroupExcluded\(c\)\) return/);
  // group exclusions now surface as chips in the active filter bar
  assert.match(app, /chipHtml\('group', group, group \+ ' forms'/);
  assert.match(app, /shared\.xg = \[\.\.\.excludedGroups\]\.sort\(\)/);
  assert.match(app, /strings\(shared\.xg,/);
  assert.match(css, /\.groupex\{/);
  assert.match(css, /\.selc\.group\{/);
});

test('main and alternate compositions share the roster row layout', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  assert.match(app, /class="comprow primary"/);
  assert.match(app, /class="comprow alternate"/);
  assert.match(app, /class="active"><b>\$\{r\.live\}<\/b> traits active/);
  assert.match(app, /class="unique">\+\$\{r\.uniqN\} unique/);
  assert.doesNotMatch(app, /class="u">\+\$\{r\.uniqN\} unique/);
  assert.match(app, /class="w"><b>\$\{r\.waste\}<\/b> wasted/);
  assert.match(app, /teamProfile\(r\.units, true\)/);
  assert.match(app, /class="vg"[^>]*>\$\{r\.gold\}g/);
  assert.doesNotMatch(app + css, /compmeta/);
  assert.match(css, /\.comphead\{/);
  assert.match(css, /\.comprow\{/);
  assert.match(css, /\.score \.unique,\.score \.slots\{/);
});

test('team composition renders as one segmented strip', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');
  const profile = app.match(/function teamProfile\(units, compact = false\) \{[\s\S]*?\n\}/)?.[0];

  assert.ok(profile, 'missing team profile renderer');
  assert.match(profile, /class="profilepart tank"/);
  assert.match(profile, /class="profilepart ad"/);
  assert.match(profile, /class="profilepart ap"/);
  assert.match(profile, /class="profilepart hybrid"/);
  assert.doesNotMatch(profile, /\bothers?\b/i);
  assert.doesNotMatch(app + css, /profilepill/);
  assert.match(css, /\.profilepart\+\.profilepart\{[^}]*border-left:/);
});

test('roster summary controls fill the available row height', () => {
  const css = read('web/traits/style.css');
  const app = read('web/traits/app.js');

  assert.match(css, /\.teamprofile\{[^}]*font-size:11px/);
  assert.match(css, /\.profilepart\{[^}]*padding:3px 8px/);
  assert.match(css, /\.profilepart \.si\{[^}]*width:13px;height:13px/);
  assert.match(css, /\.profilepart b\{[^}]*font-size:11px/);
  assert.match(css, /\.comprow>\.copycode\{[^}]*width:30px;height:30px/);
  assert.match(css, /\.vg\{font-size:12px/);
  // The footer used to live inside .comprow, so its position depended on
  // how many portraits wrapped: with 8 units the gold/copy/pin cluster sat
  // beside the last row, with 6 it dropped below. Pin it to its own row.
  assert.match(app, /class="compfoot"/);
  assert.doesNotMatch(app, /class="comprow primary">\$\{units\}\$\{varTag\}\$\{profile\}/);
  assert.match(css, /\.compfoot\{/);
});

test('hover cards stay out of the way on touch devices', () => {
  const app = read('web/traits/app.js');
  // Touch taps synthesise mouseover on iOS, which raced the sheet and
  // produced the small hover card instead. The listener must opt out
  // whenever the device has no true hover.
  const handler = app.slice(app.indexOf("addEventListener('mouseover'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /canHover\(\)/);
});

test('the sheet can be dismissed without tapping outside it', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');
  // An explicit close button, not just a scrim tap.
  assert.match(app, /class="sheetx"[^>]*aria-label="Close"/);
  assert.match(css, /\.sheetx\{/);
  // The grip implied a drag, so make the drag real rather than decorative.
  assert.match(app, /touchstart/);
  assert.match(app, /touchmove/);
  assert.match(app, /closeSheet\(\)/);
});

test('trait breakpoints carry no duplicate unit counts', () => {
  const data = JSON.parse(read('web/traits/data.json'));
  // Riot encodes a label row and the real effect at the same minUnits for
  // Rival (1/25000 with empty variables, then 1/1 with the payload), so a
  // naive read stored bp [1, 1, 2]. The duplicate never reached scoring --
  // breakpoints() dedupes -- but it leaked into the sheet and the tooltips.
  for (const [key, trait] of Object.entries(data.traits)) {
    const bp = trait.bp || [];
    const uniq = [...new Set(bp)];
    assert.deepEqual(bp, uniq, `${key} has duplicate breakpoints: ${bp}`);
    const sorted = [...bp].sort((x, y) => x - y);
    assert.deepEqual(bp, sorted, `${key} breakpoints out of order: ${bp}`);
  }
});

test('a style range exists for every breakpoint', () => {
  const data = JSON.parse(read('web/traits/data.json'));
  // The phantom effect also added a styles entry, so Rival claimed gold at
  // 1 while the real capped bronze tier sat behind it.
  for (const [key, trait] of Object.entries(data.traits)) {
    const mins = (trait.styles || []).map(s => s.min);
    assert.deepEqual(mins, [...new Set(mins)],
      `${key} has duplicate style minimums: ${mins}`);
  }
});
test('touch can remove emblems, not just add them', () => {
  const app = read('web/traits/app.js');
  // Emblems stack, so the sheet needs add/remove rather than a toggle.
  assert.match(app, /openSheet\(traitCard\(t\.key\), 'emblem', t\.key\)/);
  assert.match(app, /data-act="embminus"/);
  assert.match(app, /data-act="embplus"/);
  // and the count has to be visible while adjusting it
  assert.match(app, /sheetcount/);
});
test('the sheet shares the desktop hover card styling', () => {
  const css = read('web/traits/style.css');
  // The sheet renders the very same markup unitCard()/traitCard() produce,
  // so the card rules must target it too rather than being duplicated.
  for (const cls of ['.chd', '.csub', '.clead', '.tunit', '.crow', '.cbp', '.cab']) {
    assert.ok(css.includes('.sheetbody ' + cls),
      'card rule ' + cls + ' is not shared with the sheet');
  }
  // Cost colours ride on .tunit.kN -- every cost tier needs the border.
  for (let n = 1; n <= 5; n++) {
    assert.ok(css.includes('.sheetbody .tunit.k' + n),
      'cost ' + n + ' portrait border is not shared with the sheet');
  }
  // .csub is an inline span next to the name; it must break onto its own
  // line in the sheet or it collides with the trait name.
  assert.match(css, /\.sheetbody \.csub\{[^}]*display:block/);
});
test('touch devices pick trait breakpoints from a sheet', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');

  // tapping a trait opens the sheet instead of cycling
  assert.match(app, /if \(isTouch\(\)\) return openSheet\(traitCard\(t\.key\), 'trait', t\.key\)/);

  // every scoring breakpoint is its own button, so no repeat tapping
  assert.match(app, /scoringBreakpoints\(DB\.traits\[key\]\)/);
  assert.match(app, /data-act="bp" data-n=/);

  // mute is reachable and uses plain wording rather than jargon
  assert.match(app, /Ignore for scoring/);
  assert.doesNotMatch(app, /Mute trait/);

  // and the sheet can clear the requirement outright
  assert.match(app, /data-act="clr"/);

  // acting on a breakpoint sets it directly rather than stepping
  assert.match(app, /setTraitReq\(/);

  assert.match(css, /\.sheetbp\{/);
});
test('the active filter bar summarises every non-default filter', () => {
  const app = read('web/traits/app.js');
  const html = read('web/traits/index.html');
  const css = read('web/traits/style.css');
  // One bar, mounted above the results it explains.
  assert.match(html, /id="activeFilters"/);
  assert.ok(html.indexOf('id="activeFilters"') < html.indexOf('class="results"'),
    'the bar must render above the results');
  // The old duplicate strip is absorbed, not left behind.
  assert.doesNotMatch(html, /id="selReqC"/);
  assert.doesNotMatch(html, /id="selExcC"/);
  // Every filter family is represented, not just units.
  for (const kind of ['unit', 'trait', 'emblem', 'cost', 'size', 'waste', 'group', 'mute']) {
    assert.ok(app.includes("'" + kind + "'"), 'no chip kind: ' + kind);
  }
  assert.match(app, /function renderActiveFilters/);
  // Defaults stay silent: a chip only appears once a value moves off default.
  assert.match(app, /DEFAULT_SIZE/);
  assert.match(app, /DEFAULT_WASTE/);
  // Removable only -- no click-to-jump machinery.
  assert.match(app, /function clearChip/);
  assert.match(css, /\.afbar\{/);
});

test('both clear buttons reset every filter surfaced in the active filter bar', () => {
  const app = read('web/traits/app.js');

  assert.match(app, /function clearAllFilters\(\)/);
  assert.match(app, /costOn\.clear\(\)/);
  assert.match(app, /for \(let cost = 1; cost <= 5; cost\+\+\) costOn\.add\(cost\)/);
  assert.match(app, /\$\('size'\)\.value = DEFAULT_SIZE/);
  assert.match(app, /\$\('waste'\)\.value = DEFAULT_WASTE/);
  assert.match(app, /\$\('clear'\)\.onclick = clearAllFilters/);
  assert.match(app, /\$\('afClear'\)\.addEventListener\('click', clearAllFilters\)/);
});
test('touch devices can preview a unit without applying a filter', () => {
  const app = read('web/traits/app.js');
  const css = read('web/traits/style.css');
  // Hover cards are mouseover-only, so touch users had no way to read a
  // unit's ability text: tapping a tile immediately required the unit.
  // A bottom sheet gives them the same content plus explicit actions.
  assert.match(app, /function openSheet/);
  assert.match(app, /function closeSheet/);
  // Must be gated on a coarse pointer, or desktop clicks would open it too.
  assert.match(app, /\(pointer:\s*coarse\)/);
  // The sheet reuses the desktop card renderer rather than duplicating copy.
  assert.match(app, /openSheet\(unitCard\(/);
  // Explicit actions replace the tap-to-filter shortcut on touch.
  assert.match(app, /data-act="req"/);
  assert.match(app, /data-act="exc"/);
  // Capped height with internal scroll: a full-height sheet is just a modal
  // and loses the context the sheet exists to preserve.
  assert.match(css, /\.sheet\{/);
  assert.match(css, /\.sheetbody\{[^}]*overflow-y:auto/);
  assert.match(css, /\.sheetbody\{[^}]*overscroll-behavior:contain/);
});
test('the generated data and checked-in roster are internally consistent', () => {
  const data = JSON.parse(read('web/traits/data.json'));
  const roster = JSON.parse(read('set18-roster.json'));
  const builder = read('build_set18.py');
  const champions = new Map(data.champions.map(champion => [champion.key, champion]));

  assert.equal(roster.length, data.champions.length);
  for (const source of roster) {
    const key = source.apiName.replace(/^TFT18_/, '');
    const champion = champions.get(key);
    assert.ok(champion, `missing generated champion ${key}`);
    assert.equal(champion.cost, source.cost);
    assert.ok(champion.icon, `${key} has no icon`);
    assert.ok(champion.stats, `${key} has no stats`);
    assert.equal(champion.stats.hpStars?.length, 3, `${key} has no star-level Health`);
    assert.equal(champion.stats.adStars?.length, 3, `${key} has no star-level Attack Damage`);
    assert.ok(champion.role, `${key} has no unit role`);
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
    assert.ok(['origin', 'class'].includes(trait.category),
      `${trait.name} has no origin/class category`);
  }
  assert.equal(Object.values(data.traits).filter(trait => trait.category === 'origin').length, 23);
  assert.equal(Object.values(data.traits).filter(trait => trait.category === 'class').length, 12);
  assert.equal(data.traits.Blackthorn.category, 'origin');
  assert.equal(data.traits.Ravager.category, 'class');
  assert.match(builder, /TRAIT_CATEGORIES = \{/);
  assert.match(builder, /"Blackthorn": "origin"/);
  assert.match(builder, /OUT = os\.path\.join\(HERE, "web", "traits", "data\.json"\)/);
  assert.doesNotMatch(builder, /OUT = os\.path\.join\(HERE, "web", "data\.json"\)/);
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
    assert.equal(lux.ability.name, 'Final Spark');
  }
  assert.equal(champions.get('Raptor').ability.name, 'Flock Family');
  assert.match(builder, /ABILITY_NAME_OVERRIDES = \{/);
  assert.match(builder, /"Raptor": "Flock Family"/);
  assert.deepEqual(data.traits.Riftbeast.teamSize, [{ min: 10, slots: 2 }]);
  assert.deepEqual(data.traits.Riftbeast.teamSize, [{ min: 10, slots: 2 }]);
  assert.ok(data.traits.Adaptor.tiers.every(tier =>
    tier.includes('%i:scaleAD%') && tier.includes('%i:scaleAP%')));
  assert.ok(data.traits.Defender.tiers.every(tier =>
    tier.includes('%i:scaleArmor%') && tier.includes('%i:scaleMR%')));
  assert.deepEqual(data.traits.Solar.upgrades.map(upgrade => upgrade.count), [1, 3, 5, 8]);
  assert.doesNotMatch(data.traits.Solar.tiers[0], /\b1\s*:/);
  assert.equal(champions.get('Shen').role, 'APTank');
  assert.match(champions.get('Shen').ability.descResolved, /%i:scaleAP%/);
  assert.equal(data.champions.filter(champion => champion.role).length, 73);
  assert.match(champions.get('Teemo').ability.descResolved, /\n\nEach cast/);
  assert.match(champions.get('Teemo').ability.descResolved, /\nGreen:/);
  assert.deepEqual(data.traits.Primal.tiers,
    ['Choose a blessing.', 'Choose a second blessing.']);
  assert.equal(data.traits.Summoner.lead, 'Summoners empower their summons in different ways.');
  assert.deepEqual(data.traits.Summoner.details, [
    'Yorick: +30% Health',
    'Azir: +45% Damage',
    'Mama Beak: +45% Damage',
    'Zyra: +4 Plant Attacks',
  ]);
  assert.deepEqual(champions.get('Shen').stats.hpStars, [900, 1620, 2916]);
  assert.deepEqual(champions.get('Shen').stats.adStars, [50, 75, 113]);

  const adaptors = data.champions.filter(champion => champion.traits.includes('Adaptor'));
  assert.equal(adaptors.length, 5);
  for (const adaptor of adaptors) {
    const modes = adaptor.ability.sections.filter(section => section.mode)
      .map(section => section.mode).sort();
    assert.deepEqual(modes, ['AD', 'AP'], `${adaptor.key} is missing an Adaptor ability mode`);
  }
});
