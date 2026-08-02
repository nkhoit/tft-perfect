const crypto = require('node:crypto');

const BoardScore = require('../../generated/board-score.js');
const data = require('../../generated/data.json');
const SearchUtils = require('../../generated/search-utils.js');

const tables = BoardScore.tables(data);

function strings(value, limit) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').slice(0, limit)
    : [];
}

function expandedEmblems(state) {
  const emblems = [];
  for (const entry of Array.isArray(state.e) ? state.e.slice(0, 35) : []) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, count] = entry;
    const trait = data.traits[key];
    if (!trait || !Number.isFinite(SearchUtils.scoreFloor(trait))
        || SearchUtils.antiStack(trait)
        || !Number.isInteger(count) || count < 1) continue;
    for (let i = 0; i < Math.min(count, 20 - emblems.length); i++) emblems.push(key);
    if (emblems.length >= 20) break;
  }
  return emblems;
}

function teamProfile(champions) {
  const profile = { tanks: 0, AD: 0, AP: 0, Hybrid: 0 };
  for (const champion of champions) {
    const role = champion.role || '';
    if (role.endsWith('Tank')) profile.tanks++;
    else if (champion.traits.includes('Adaptor') || role.startsWith('Hybrid')) profile.Hybrid++;
    else if (role.startsWith('AD')) profile.AD++;
    else if (role.startsWith('AP')) profile.AP++;
  }
  return profile;
}

function previewState(state) {
  const size = Number.isInteger(state.l) && state.l >= 2 && state.l <= 10 ? state.l : 8;
  const emblems = expandedEmblems(state);
  const muted = strings(state.m, 35)
    .filter(key => data.traits[key] && Number.isFinite(SearchUtils.scoreFloor(data.traits[key])))
    .map(key => tables.traitIndex.get(key));
  const selected = [];
  let dropped = 0;
  const seen = new Set();
  for (const roster of Array.isArray(state.sel) ? state.sel.slice(0, 12) : []) {
    const validated = BoardScore.validateRoster(data, tables, roster, {
      size, emblems, muted,
    });
    if (validated.error) {
      dropped++;
      continue;
    }
    const signature = validated.indexes.slice().sort((a, b) => a - b).join(',');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const champions = validated.indexes.map(index => data.champions[index]);
    selected.push({
      keys: roster.slice(),
      champions,
      profile: teamProfile(champions),
      row: validated.row,
      traits: validated.row.active.slice(0, 10).map(([trait, count]) => ({
        count,
        name: data.traits[tables.traitKeys[trait]].name,
      })),
    });
  }
  return {
    dataBuiltAt: data.builtAt,
    dropped,
    emblems,
    featured: selected[0] || null,
    otherCount: Math.max(0, selected.length - 1),
    selected,
    size,
  };
}

function etag(token) {
  return '"' + crypto.createHash('sha256')
    .update(data.builtAt)
    .update('\0portraits-profile-v1')
    .update('\0')
    .update(token)
    .digest('base64url')
    .slice(0, 24) + '"';
}

module.exports = { data, etag, previewState, tables };
