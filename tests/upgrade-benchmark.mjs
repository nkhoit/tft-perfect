import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

import { launchBrowser, loadExplorer, waitFor } from './browser-harness.mjs';

const fixtures = JSON.parse(fs.readFileSync(
  new URL('./fixtures/upgrade-benchmarks.json', import.meta.url), 'utf8'));
const data = JSON.parse(fs.readFileSync(
  new URL('../web/traits/data.json', import.meta.url), 'utf8'));
const precomputed = JSON.parse(fs.readFileSync(
  new URL('../web/traits/precomputed-default.json', import.meta.url), 'utf8'));
const fixture = fixtures[0];
assert.equal(fixture.dataBuiltAt, data.builtAt);
assert.equal(fixture.queryKey, precomputed.queryKey);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

const session = await launchBrowser();
const samples = [];
const observed = [];
try {
  await loadExplorer(session);
  for (let iteration = 0; iteration < 3; iteration++) {
    const started = performance.now();
    await session.cdp.evaluate(
      `document.querySelector('#list .comp .upgradepath').click()`);
    try {
      await waitFor(() => session.cdp.evaluate(`(() => {
        const panel = document.querySelector('#list .upgradepanel');
        return Boolean(panel && !panel.textContent.includes('Finding')
          && panel.querySelector('.uplist[data-proved="true"] .upmove')
          && !panel.querySelector('.upempty'));
      })()`), 60000);
    } catch (error) {
      const text = await session.cdp.evaluate(
        `document.querySelector('#list .upgradepanel')?.textContent`);
      throw new Error(`${error.message}: ${text}`);
    }
    observed.push(await session.cdp.evaluate(`(() => {
      const move = document.querySelector('#list .upgradepanel .upmove');
      return { units: move.dataset.units.split(','), kept: Number(move.dataset.kept) };
    })()`));
    samples.push(Math.round(performance.now() - started));
    if (iteration < 2) await loadExplorer(session);
  }
} finally {
  await session.cleanup();
}

const result = {
  fixture: fixture.name,
  browserSamplesMs: samples,
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  selectedRows: 3,
  platform: process.platform,
  cpu: os.cpus()[0]?.model,
  passed: percentile(samples, 0.95) <= 5000,
};

for (const move of observed) {
  assert.equal(move.kept, fixture.keep);
  assert.deepEqual([...move.units].sort(), [...fixture.knownBetter].sort());
}

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
