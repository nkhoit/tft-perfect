# Coven Cashout Calculator Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** A standalone `/coven/` page that answers "what cashout can I actually afford, and will I survive getting there?"

**Architecture:** A pure-logic UMD module (`web/coven/coven-model.js`) holding verified game constants and a round-by-round simulator, plus a thin page (`web/coven/index.html` + `app.js`) with two modes. Node unit tests cover the model; a browser test covers the page. No build step, matching the rest of tftkit.

**Tech Stack:** Vanilla JS (UMD), `node --test`, existing CDP browser harness.

---

## Current context / assumptions

### Verified data (from patch notes screenshot + lolchess + CDragon)

Essence rates per Coven tier — **from the latest patch notes screenshot supplied by the user**, which supersede both CDragon and MetaTFT:

| Coven | per kill | per loss |
|---|---|---|
| 3 | 1 | 20 |
| 4 | 2 | 25 |
| 5 | 3 | 30 |
| 7 | 10 | 80 |

Cashout thresholds (cumulative essence), from https://x.com/TheTruexy/status/2085154566526693831/photo/2 :

```
40 · 85 · 130 · 185 · 250 · 365 · 500 · 650 · 800
```

Player loss damage (confirmed lolchess.gg/guide/damage, unchanged from Set 17):

```
damage = base(stage) + surviving_enemy_units
base: stage2=0, stage3=2, stage4=6, stage5=7, stage6=10, stage7=12
each surviving unit = 1 damage
```

### Known-stale data in the repo

`web/traits/data.json` has Coven tier 7 as `7 per kill, 70 per loss`. Both numbers are wrong (should be `10` and `80`). Task 1 fixes this independently.

### Assumptions that MUST be encoded as overridable inputs, never hardcoded

- **Level curve.** Default preset from the user: lv4 by 2-1, lv6 by 3-2, lv7 by 3-6, lv8 by 4-2, lv9 by 5-1. Rationale: players spend gold above 50 on XP rather than rolling.
- **Coven tier is capped by level.** You cannot field 7 Coven at level 4. An earlier draft of this model produced fantasy output (7 Coven active at 2-1) precisely because tier was treated as a free input.
- **Kills per round is genuinely unmodelable** (user's words). A lose-streaking board is deliberately weakened; against a lobby that stacks all items on one tank you may get 0 kills, against weaker boards 2-3. Therefore the model NEVER predicts kills — it takes a kills-per-round input and the UI shows a **band** across the plausible range.

### Why the band is honest rather than lazy

Measured spread in HP-remaining across kills-per-round 0..6, full lose-streak from 2-1:

```
L1 ( 40e): spread  0 HP
L3 (130e): spread 12 HP
L5 (250e): spread 25 HP
L7 (500e): spread 28 HP
L9 (800e): spread 58 HP
```

Kill variance is invisible at low cashouts and only dominates deep — exactly where the verdict is already "you will die." So a band communicates the real uncertainty without inventing precision.

---

## Proposed approach

### Two modes, both requested by the user

1. **Plan mode** — "I'm running Coven 3 starting 2-5, what cashout can I get?" Simulates from a chosen start round to end of game.
2. **Decision mode** — "I'm here now with this essence and HP; is the next cashout reachable or do I take the one in front of me?" This is the primary in-game use.

Both call the same simulator; they differ only in starting inputs.

### Worked example of the target output (decision mode)

Inputs: 3-5, Coven 5, 186 essence, 68 HP. Simulator output across kills 0/2/4:

```
0 kills: L5 @3-7, 42 HP | L6 @4-3,  0 HP
2 kills: L5 @3-6, 51 HP | L6 @4-2, 14 HP
4 kills: L5 @3-6, 51 HP | L6 @4-2, 14 HP
```

Rendered as:

```
L5  250e   need  64e   reachable 3-6..3-7    HP left 42-51   safe
L6  365e   need 179e   reachable 4-2..4-3    HP left  0-14   lethal risk
L7  500e   need 314e   not reachable alive
```

---

## Step-by-step plan

### Task 1: Fix the stale Coven rates in traits data

**Objective:** Correct `7 per kill, 70 per loss` to `10 per kill, 80 per loss` — wrong on the live site today.

**Files:**
- Modify: `web/traits/data.json` (Coven trait `tiers` array)
- Check: whatever script generates it (search for the generator before hand-editing)

**Step 1:** Search for the generator so the fix is not overwritten on next rebuild:

```
search_files(pattern="tiers", path=".", file_glob="*.py")
```

**Step 2:** If a generator owns this field, fix the source there. If the string is derived from CDragon `effects` variables, note that **CDragon itself is stale** (it reports 7/100) and the patch-note values must be applied as an override table keyed by trait+tier.

**Step 3:** Update `data.json` so the Coven tier-4 (7-unit) entry reads `10 per kill, 80 per loss`.

**Step 4:** Verify:

```bash
node -e "const d=require('./web/traits/data.json');console.log(d.traits.Coven.tiers)"
```

Expected: last entry contains `10 per kill, 80 per loss`.

**Step 5:** Commit.

```bash
git add web/traits/data.json
git commit -m "fix: correct Coven 7 essence rates to match latest patch"
```

---

### Task 2: Create the model module with constants only

**Objective:** Stand up `web/coven/coven-model.js` as a UMD module exporting verified constants.

**Files:**
- Create: `web/coven/coven-model.js`
- Create: `tests/coven-model.test.js`

**Step 1: Write failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import Coven from '../web/coven/coven-model.js';

test('exposes the cashout thresholds from the current patch', () => {
  assert.deepEqual(Coven.THRESHOLDS, [40, 85, 130, 185, 250, 365, 500, 650, 800]);
});

test('exposes essence rates per Coven tier', () => {
  assert.deepEqual(Coven.RATES[3], { kill: 1, loss: 20 });
  assert.deepEqual(Coven.RATES[7], { kill: 10, loss: 80 });
});
```

**Step 2: Run to verify failure**

```bash
node --test tests/coven-model.test.js
```

Expected: FAIL — cannot find module.

**Step 3: Implement** — UMD wrapper exporting `THRESHOLDS`, `RATES`, `STAGE_BASE`, following the existing pattern in `web/traits/comp-quality.js` (see its `root.CompQuality` tail).

**Step 4: Run to verify pass.** Expected: 2 passed.

**Step 5: Commit.**

---

### Task 3: Loss damage as a function, not a constant

**Objective:** `lossDamage(stage, survivors)` implementing `base(stage) + survivors`.

**Step 1: Write failing test**

```js
test('loss damage is stage base plus surviving enemy units', () => {
  assert.equal(Coven.lossDamage(2, 4), 4);   // 0 + 4
  assert.equal(Coven.lossDamage(3, 6), 8);   // 2 + 6
  assert.equal(Coven.lossDamage(4, 8), 14);  // 6 + 8
  assert.equal(Coven.lossDamage(5, 9), 16);  // 7 + 9
});

test('an early loss costs a fraction of a late one', () => {
  assert.ok(Coven.lossDamage(2, 4) * 3 < Coven.lossDamage(4, 8),
    'stage 2 losses must be far cheaper than stage 4 losses');
});
```

**Step 2-5:** RED, implement, GREEN, commit.

**Note for implementer:** the second test is the whole reason this is a function. Do not replace it with a constant.

---

### Task 4: Level curve preset with override

**Objective:** `levelAt(stage, round, curve)` returning player level, defaulting to the user's standard curve.

**Step 1: Write failing test**

```js
test('the default curve matches common play', () => {
  assert.equal(Coven.levelAt(2, 1), 4);
  assert.equal(Coven.levelAt(3, 2), 6);
  assert.equal(Coven.levelAt(3, 6), 7);
  assert.equal(Coven.levelAt(4, 2), 8);
});

test('a custom curve overrides the preset', () => {
  const fast8 = { 6: [3, 1], 7: [3, 5], 8: [4, 1] };
  assert.equal(Coven.levelAt(4, 1, fast8), 8);
  assert.equal(Coven.levelAt(4, 1), 8);
});
```

**Step 2-5:** RED, implement, GREEN, commit.

---

### Task 5: Coven tier capped by level

**Objective:** `maxTier(level)` — prevents the fantasy output an earlier draft produced.

**Step 1: Write failing test**

```js
test('Coven tier is capped by board size', () => {
  assert.equal(Coven.maxTier(4), 3, 'level 4 cannot field more than 3 Coven');
  assert.equal(Coven.maxTier(6), 5);
  assert.equal(Coven.maxTier(8), 7);
});

test('7 Coven is unreachable before level 8', () => {
  for (let lv = 4; lv < 8; lv++) {
    assert.ok(Coven.maxTier(lv) < 7, `level ${lv} must not reach 7 Coven`);
  }
});
```

**Step 2-5:** RED, implement, GREEN, commit.

---

### Task 6: The round-by-round simulator

**Objective:** `simulate({ start, essence, hp, covenCount, killsPerRound, curve })` returning, for each threshold, the round it is reached and HP remaining.

**Step 1: Write failing test** — use the verified decision-mode scenario:

```js
test('projects when each cashout lands and what HP is left', () => {
  const out = Coven.simulate({
    start: [3, 5], essence: 186, hp: 68, covenCount: 5, killsPerRound: 2,
  });
  const l5 = out.find(r => r.threshold === 250);
  assert.deepEqual(l5.round, [3, 6]);
  assert.equal(l5.hpLeft, 51);

  const l6 = out.find(r => r.threshold === 365);
  assert.deepEqual(l6.round, [4, 2]);
  assert.equal(l6.hpLeft, 14);
});

test('stops projecting once the player would be dead', () => {
  const out = Coven.simulate({
    start: [3, 5], essence: 186, hp: 68, covenCount: 5, killsPerRound: 2,
  });
  assert.ok(out.every(r => r.hpLeft > 0 || r.lethal),
    'a cashout past 0 HP must be flagged lethal, never silently listed as reachable');
});
```

**Step 2-5:** RED, implement, GREEN, commit.

**Note:** the essence rate must be recomputed each round from the *current* level (via `maxTier`), because hitting level 8 flips the rate to 80/loss mid-path. A linear projection is wrong.

---

### Task 7: The HP band across kill uncertainty

**Objective:** `band({ ...inputs, killRange: [0, 6] })` returning min/max HP-left per threshold.

**Step 1: Write failing test**

```js
test('kill uncertainty widens as cashouts get deeper', () => {
  const b = Coven.band({ start: [2, 1], essence: 0, hp: 100, covenCount: 3 });
  const l1 = b.find(r => r.threshold === 40);
  const l7 = b.find(r => r.threshold === 500);
  assert.ok(l1.spread <= 4, 'early cashouts are insensitive to kills');
  assert.ok(l7.spread > 20, 'deep cashouts swing hard on kills');
});
```

**Step 2-5:** RED, implement, GREEN, commit.

---

### Task 8: The page

**Objective:** `/coven/` with both modes.

**Files:**
- Create: `web/coven/index.html`, `web/coven/app.js`, reuse `web/traits/style.css` tokens
- Modify: site nav

**Requirements:**
- Decision mode default: current stage/round, essence, HP, Coven count.
- Plan mode toggle: simulate from a start round.
- Kills preset buttons: `unkillable (0)` / `typical (2)` / `good board (4)`.
- Level curve shown as preset text with an "edit" toggle.
- Each row: threshold, essence needed, reachable round range, HP-left band, verdict.
- Mobile: verify at 390x844, no horizontal overflow.

**Commit.**

---

### Task 9: Browser guard test

**Objective:** `tests/coven-browser.mjs` proving the page computes, not just renders.

Assert the worked scenario end-to-end: entering 3-5 / Coven 5 / 186e / 68 HP shows L5 as safe and L6 as lethal-risk. Add to `package.json` `test:browser`.

**Guard requirement:** prove RED by breaking `lossDamage` to a constant 11 and confirming the test fails. A test that passes with a hardcoded damage constant is vacuous.

**Commit.**

---

### Task 10: Reward table (second page, separate commit)

**Objective:** Show what each cashout actually contains.

**Source:** MetaTFT https://www.metatft.com/tables/coven — the best available, but **not** first-party. Transcribe contents and label the source in the UI. Do not present MetaTFT's gold-value estimates as fact; either omit them or attribute them.

**Risk:** this data goes stale every patch, as CDragon already did here. Store it in one JSON file with a `patch` field so staleness is visible.

---

## Files likely to change

- `web/traits/data.json` (Task 1)
- `web/coven/coven-model.js`, `web/coven/index.html`, `web/coven/app.js` (new)
- `tests/coven-model.test.js`, `tests/coven-browser.mjs` (new)
- `package.json` (`test:browser` list)
- `web/coven/rewards.json` (Task 10)

## Tests / validation

```bash
npm run check
npm test
env -u CHROME_PATH npm run test:browser
```

Gate: check 0, all unit tests pass, browser suite passes with 0 unexplained skips. Then push, watch CI, hash-verify `coven-model.js` live, and exercise the page in a real browser at both desktop and 390x844.

## Risks, tradeoffs, open questions

1. **Thresholds and rates are patch-volatile.** Three sources disagreed while planning this (CDragon 7/100, MetaTFT 7/100, patch notes 10/80). Keep every constant in one file with a patch label.
2. **Kills are not modelable.** Handled via band, not prediction. Do not let a future change quietly replace the band with a point estimate.
3. **The level curve is a heuristic**, not a rule. It must stay overridable.
4. **Reward values are MetaTFT's model**, not measured. Attribute them.
5. **Open:** does starting HP default to 100, or should decision mode always require current HP? Current plan: decision mode requires it, plan mode defaults to 100.
6. **Open:** are there augments (Coven Acolyte heals 2 HP per pass, Essence Theft +50% essence) worth modeling in v1? Currently out of scope — they change the arithmetic materially and should be a v2 toggle.
