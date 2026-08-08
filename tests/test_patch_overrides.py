"""Guard for patch-note values that CDragon reports incorrectly.

CDragon is a mirror, not the patch. When Riot ships a balance change the
mirror can lag or disagree -- while building the
Coven calculator all three available sources disagreed on the 7-Coven rates:
CDragon said 7/kill 100/loss, MetaTFT said the same, and the actual patch
notes said 10/kill 80/loss. data.json had a third answer, 7/70.

PATCH_TRAIT_TIERS is the override applied on top of CDragon, and this test
pins it so a rebuild cannot silently reintroduce stale numbers.
"""

import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


class TestCovenRates(unittest.TestCase):
    def test_data_json_matches_patch_notes(self):
        data = json.loads((ROOT / "web/traits/data.json").read_text())
        tiers = data["traits"]["Coven"]["tiers"]
        self.assertEqual(len(tiers), 4, "Coven has four breakpoints")
        self.assertIn("10 per kill", tiers[3],
                      "7-Coven is 10 essence per kill this patch")
        self.assertIn("80 per loss", tiers[3],
                      "7-Coven is 80 essence per loss this patch")

    def test_build_script_declares_the_override(self):
        src = (ROOT / "build_set18.py").read_text()
        self.assertIn("PATCH_TRAIT_TIERS", src,
                      "the build script must own the override, not a hand edit")


if __name__ == "__main__":
    unittest.main()
