// Coven cashout data. Everything Riot can tune in a patch lives HERE, in one
// file with a patch label, so the next balance change is a data edit rather
// than a hunt through logic.
//
// Sourced from the 8/5 PBE patch notes (@TheTruexy). CDragon and MetaTFT both
// still reported the previous 7-Coven rates when this was written, so the
// patch notes win -- see PATCH_TRAIT_TIERS in build_set18.py for the same
// conflict on the trait tooltip.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CovenData = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PATCH = "PBE 8/5";

  // Cumulative essence required for each cashout level.
  var THRESHOLDS = [40, 85, 130, 185, 250, 365, 500, 650, 800];

  // Essence per kill and per player-combat loss, by Coven breakpoint.
  var RATES = {
    3: { kill: 1, loss: 20 },
    4: { kill: 2, loss: 25 },
    5: { kill: 3, loss: 30 },
    7: { kill: 10, loss: 80 }
  };

  var BREAKPOINTS = [3, 4, 5, 7];

  // Player damage = base(stage) + surviving enemy units. Confirmed unchanged
  // from Set 17. Stage 7+ is effectively lethal and clamps to the last value.
  var STAGE_BASE = { 2: 0, 3: 2, 4: 6, 5: 7, 6: 10, 7: 12 };

  return {
    PATCH: PATCH,
    THRESHOLDS: THRESHOLDS,
    RATES: RATES,
    BREAKPOINTS: BREAKPOINTS,
    STAGE_BASE: STAGE_BASE
  };
}));
