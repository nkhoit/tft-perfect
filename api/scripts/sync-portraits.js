const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const data = require(path.join(root, 'web', 'traits', 'data.json'));
const target = path.join(root, 'api', 'assets', 'champions');
const expected = new Set();

function validateChampion(champion) {
  if (!/^[A-Za-z0-9_-]+$/.test(champion.key)) {
    throw new Error(`Unsafe champion key: ${champion.key}`);
  }
  const url = new URL(champion.icon);
  if (url.protocol !== 'https:' || url.hostname !== 'raw.communitydragon.org') {
    throw new Error(`Unexpected portrait source for ${champion.key}: ${champion.icon}`);
  }
  return url;
}

async function download(champion) {
  const url = validateChampion(champion);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download ${champion.key}: HTTP ${response.status}`);
  }
  const portrait = Buffer.from(await response.arrayBuffer());
  if (portrait.length > 2_000_000 || portrait.subarray(1, 4).toString() !== 'PNG') {
    throw new Error(`Invalid portrait for ${champion.key}`);
  }
  const filename = `${champion.key}.png`;
  const output = path.join(target, filename);
  fs.writeFileSync(`${output}.tmp`, portrait);
  fs.renameSync(`${output}.tmp`, output);
  expected.add(filename);
}

async function main() {
  fs.mkdirSync(target, { recursive: true });
  const queue = data.champions.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) await download(queue.shift());
  });
  await Promise.all(workers);
  for (const filename of fs.readdirSync(target)) {
    if (filename.endsWith('.png') && !expected.has(filename)) {
      fs.unlinkSync(path.join(target, filename));
    }
  }
  console.log(`Synced ${expected.size} champion portraits.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
