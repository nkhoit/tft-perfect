// Coven cashout calculator UI.
//
// Two ways in, one engine. "Plan from a stage" answers "I am running Coven 3
// from 2-5, what can I get?" and starts from full health. "I am mid-game"
// answers the sharper question -- take the cashout in front of me, or push for
// the next one -- and starts from whatever essence and health you actually have.
(function () {
  "use strict";

  var DATA = window.CovenData;
  var SIM = window.CovenSim;
  var $ = function (id) { return document.getElementById(id); };

  var KILL_BAND = [0, 2, 4];
  var planMode = true;

  function roundLabel(r) { return r.stage + "-" + r.round; }

  function fillRounds(sel, chosen) {
    SIM.ROUNDS.forEach(function (r) {
      var o = document.createElement("option");
      o.value = roundLabel(r);
      o.textContent = roundLabel(r);
      if (o.value === chosen) o.selected = true;
      sel.appendChild(o);
    });
  }

  function parseRound(text) {
    var bits = String(text).split("-");
    return { stage: Number(bits[0]), round: Number(bits[1]) };
  }

  // The simulator wants an ORDERED ARRAY of {stage, round, level} steps, not a
  // map keyed by level. An object silently reads as length 0, which pins every
  // round at level 4 and quietly produces a different game.
  function curve() {
    return [
      { stage: 2, round: 1, level: 4 },
      { stage: 2, round: 5, level: 5 },
      lvl(6), lvl(7), lvl(8), lvl(9)
    ];
  }

  function lvl(n) {
    var r = parseRound($("lv" + n).value);
    return { stage: r.stage, round: r.round, level: n };
  }

  // One row per cashout level. The health column is a BAND, not a number:
  // kill essence cannot be predicted (a lobby that stacks items on one tank
  // gives you nothing, a weak board gives you several), so the honest output
  // is the range it produces rather than a false-precision single figure.
  function render() {
    var tierSel = Number($("tier").value) || 0;
    var start = {
      hp: Number($("hp").value) || 1,
      essence: planMode ? 0 : (Number($("essence").value) || 0),
      from: parseRound($("from").value),
      tier: tierSel || null,
      curve: curve()
    };

    var startEssence = start.essence;
    var band = SIM.band(start, KILL_BAND);
    var body = $("rows");
    body.innerHTML = "";

    var best = null;
    band.forEach(function (row, i) {
      var tr = document.createElement("tr");
      var lvl = i + 1;
      var th = DATA.THRESHOLDS[i];

      if (!row || row.unreached) {
        tr.className = "dead";
        tr.innerHTML = "<td>L" + lvl + "</td><td>" + th + "e</td>" +
          "<td colspan=\"4\">" +
          (row && row.fatal
            ? "you die before reaching this"
            : "not reachable before the game ends") +
          "</td>";
        body.appendChild(tr);
        return;
      }

      var lands = row.earliest === row.latest
        ? row.earliest
        : row.earliest + " - " + row.latest;
      var hp = row.hpWorst === row.hpBest
        ? row.hpWorst
        : row.hpWorst + " - " + row.hpBest;

      var tag, cls;
      if (!row.alive) { tag = "lethal"; cls = "dead"; }
      else if (row.risky) { tag = "on fumes"; cls = "risky"; }
      else { tag = "affordable"; cls = "ok"; best = lvl; }

      tr.className = cls;
      tr.innerHTML =
        "<td>L" + lvl + "</td>" +
        "<td>" + th + "e</td>" +
        "<td>" + (row.need - startEssence > 0 ? (row.need - startEssence) + "e" : "banked") + "</td>" +
        "<td>" + lands + "</td>" +
        "<td>" + (row.alive ? hp : "dead") + "</td>" +
        "<td class=\"tag\">" + tag + "</td>";
      body.appendChild(tr);
    });

    var rate = DATA.RATES[SIM.maxTier(9)];
    var tierNow = tierSel || "auto";
    $("verdict").textContent = best
      ? "Deepest cashout you can afford: L" + best
      : "No cashout is safely reachable from here.";
    $("verdict").className = "verdict " + (best ? "ok" : "dead");

    $("assump").textContent =
      "Health shown as a range across 0-4 kills per round, because kill essence " +
      "depends on whether you can break the boards you face. Loss damage is " +
      "stage base plus surviving units, using your level curve. Tier " + tierNow +
      ". Rates and thresholds: " + DATA.PATCH + ".";
  }

  function setMode(plan) {
    planMode = plan;
    $("modePlan").className = "modebtn" + (plan ? " on" : "");
    $("modeNow").className = "modebtn" + (plan ? "" : " on");
    $("fldEssence").style.display = plan ? "none" : "";
    if (plan) { $("hp").value = 100; $("essence").value = 0; }
    render();
  }

  fillRounds($("from"), "2-5");
  fillRounds($("lv6"), "3-2");
  fillRounds($("lv7"), "3-6");
  fillRounds($("lv8"), "4-2");
  fillRounds($("lv9"), "5-1");
  $("patchLabel").textContent = DATA.PATCH;

  ["tier", "from", "essence", "hp", "lv6", "lv7", "lv8", "lv9"].forEach(function (id) {
    $(id).addEventListener("change", render);
    $(id).addEventListener("input", render);
  });
  $("modePlan").addEventListener("click", function () { setMode(true); });
  $("modeNow").addEventListener("click", function () { setMode(false); });

  setMode(true);
}());
