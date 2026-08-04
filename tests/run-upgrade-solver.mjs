import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--test', 'tests/upgrade.test.js', 'tests/lp-model.test.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_SOLVER: '1' },
  });

process.exitCode = result.status ?? 1;
