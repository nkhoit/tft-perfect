# TFT Perfect Traits Explorer

Find Teamfight Tactics boards where every trait actually does something.

Like [datatft.com/tracker/perfect](https://www.datatft.com/tracker/perfect), but with a
**wasted-traits slider** instead of perfect-only, trait requirements (`Invoker 4`),
live re-evaluation, and real game icons.

Currently built for **Set 18 · Enchanted Wilds** (PBE data), with Set 17 available
from the header dropdown.

## Features

- **Board size** 2–10 and **wasted trait slots** 0–8 sliders, re-running live.
- **Require traits** — click a trait to demand it, click again to step up its
  breakpoints (`Invoker 2 → 3 → 4 → 5 → off`). Trait badges in the results are
  clickable too, so you can pin what you see.
- Click a unit to **require** it (green), again to **exclude** (red), third clears.
- Cost filter, emblems (free trait, no board slot), unit/trait search.
- Sort by most active traits, highest trait tiers, fewest wasted, or cheapest board.
- Unique 1-unit traits are shown but **not counted** toward the active-trait score,
  so they don't drown out genuinely wide boards.

### What counts as "wasted"

Waste is measured in **trait contributions that buy nothing** — not units. A unit
overshooting one trait can still fully earn its slot through another.

- below a trait's first breakpoint → every carrier counts (2/3 Sprykin = 2 wasted)
- past a breakpoint → only the overshoot (4/5 Riftbeast = 1 wasted)

`0` = datatft's "perfect" mode.

## Run locally

```bash
python3 serve.py            # http://localhost:8808  (TFT_PORT to override)
```

No build step, no dependencies — it's static HTML/CSS/JS. The search runs in a Web
Worker so slider drags stay smooth, and requests are coalesced so only the latest
one renders.

## Data

| Set | Source | Script |
|---|---|---|
| 18 Enchanted Wilds | reveal roster + CommunityDragon `pbe` `TFTSet18` | `python3 build_set18.py` |
| 17 Space Gods | [dakgg.io](https://tft.dakgg.io) | `python3 build_data.py --set set17` |

Set 18 is PBE data — breakpoints can shift before 18.1 goes live. Re-run
`build_set18.py` to refresh.

**Once dakgg publishes set18**, switch to the cleaner single-source path:

```bash
python3 build_data.py --set set18 --out web/data-set18.json
```

### Set 18 data caveats

The pre-PBE reveal capture drifted from what shipped to PBE; `build_set18.py` patches this:

- `Eldritch` was renamed **Blackthorn**
- Solar/Lunar Lux use `sunbeam`/`moonbeam` art internally
- `Pebbles` uses the `krugmini` asset; `AncientSentinel` uses `sentinel`

Icon paths are verified against CommunityDragon's `files.exported.txt` manifest, so a
missing asset fails loudly at build time instead of rendering a broken image.

## Deploy

Pushes to `main` deploy to Azure Static Web Apps via
[`.github/workflows/azure-static-web-apps.yml`](.github/workflows/azure-static-web-apps.yml).
The deployment token lives in the `AZURE_STATIC_WEB_APPS_API_TOKEN` repo secret.

## Credits

Game data and icons belong to Riot Games, retrieved via
[CommunityDragon](https://communitydragon.org) and [dakgg](https://dakgg.io).
Not endorsed by Riot Games.
