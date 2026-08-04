import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const output = path.join(root, 'deployment-manifest.json');

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(absolute) : [absolute];
    });
}

const files = {};
for (const absolute of filesUnder(root).sort()) {
  if (absolute === output) continue;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  files[relative] = crypto.createHash('sha256')
    .update(fs.readFileSync(absolute))
    .digest('hex');
}

const commit = process.env.GITHUB_SHA
  || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(output, JSON.stringify({ commit, files }));
