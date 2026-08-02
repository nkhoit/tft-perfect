const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'web', 'traits');
const target = path.join(root, 'api', 'generated');
const files = ['search-utils.js', 'board-score.js', 'data.json'];

fs.mkdirSync(target, { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
}
