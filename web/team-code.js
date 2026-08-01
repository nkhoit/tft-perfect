(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TeamCode = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const VERSION = '02';
  const SLOT_COUNT = 10;
  const SLOT_HEX_LENGTH = 3;

  function encode(champions, setId = 'TFTSet18') {
    if (champions.length > SLOT_COUNT) throw new Error(`Team codes support at most ${SLOT_COUNT} units.`);
    const slots = champions.map(champion => {
      const code = champion.teamPlannerCode;
      if (!Number.isInteger(code) || code <= 0 || code > 0xfff) {
        throw new Error(`No team-planner code for ${champion.name || champion.key}.`);
      }
      return code.toString(16).padStart(SLOT_HEX_LENGTH, '0');
    });
    while (slots.length < SLOT_COUNT) slots.push('000');
    return VERSION + slots.join('') + setId;
  }

  function decode(code, setId = 'TFTSet18') {
    const match = String(code).trim().match(/^02([0-9a-f]{30})(TFTSet\d+(?:_Act\d+)?)$/i);
    if (!match || match[2].toLowerCase() !== setId.toLowerCase()) {
      throw new Error(`Invalid ${setId} team code.`);
    }
    return match[1].match(/.{3}/g)
      .map(slot => parseInt(slot, 16))
      .filter(Boolean);
  }

  return { decode, encode };
});
