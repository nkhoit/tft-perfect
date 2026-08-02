# TFTKIT

Teamfight Tactics tools, served at **[tftkit.com](https://tftkit.com)**.

| Path | Tool | Status |
|---|---|---|
| `/` | Landing page | live |
| `/traits/` | Trait Explorer | live |

## Layout

```
web/
  index.html      landing page
  home.css        landing styles
  404.html
  shared/
    tokens.css    shared palette — every tool imports this first
  traits/         Trait Explorer (self-contained)
```

Adding a tool: drop it in `web/<tool>/`, import `/shared/tokens.css`,
add a card to `web/index.html`, and add `/<tool>/*` to the
`navigationFallback.exclude` list in `staticwebapp.config.json`.

---

## Trait Explorer

Find Teamfight Tactics boards where every trait actually does something.

Built for **Set 18 · Enchanted Wilds** using PBE data.

## Features

- Board size 2-10 and wasted-trait allowance 0-10, re-running live.
- Required trait breakpoints such as `Invoker 4`.
- Required and excluded units, cost filters, and unit/trait search.
- Stackable emblems that add trait points without using board slots.
- Weighted units and traits, including Avatar, Apex Predator, and Riftbeast 10.
- Debounced, cancellable searches with versioned memory and device caches.
- Quick, Balanced, and Deep search budgets with one-click refinement.
- An instant precomputed result for the default landing search.
- Compact shareable URLs that restore every search control.
- Discord preview links for featured selected compositions.
- Named saved searches stored privately on the current device.
- Sorting by active traits, trait tiers, waste, or board cost.
- Copyable codes for importing any result into TFT's Team Planner.
- Unique one-unit traits remain visible but do not inflate the active-trait score.

### Waste

Waste is measured in trait contributions that buy nothing, not units:

- Below the first breakpoint, every contribution is wasted.
- Past a breakpoint, only the overshoot is wasted.
- Muted traits remain visible but contribute neither score nor waste.

`0` finds perfect boards only.

## Run Locally

```bash
python3 serve.py
```

Open the [local app](http://localhost:8808) — landing page at `/`, explorer at `/traits/`. Set `TFT_PORT` to override port 8808.

The deployed application is static HTML, CSS, and JavaScript with no runtime
dependencies or build step. Searches run across Web Workers to keep the UI responsive.
Complete results are cached in IndexedDB; truncated results stay in the current
session's memory cache. Local counters are available at `window.TFTSearchMetrics`.

### Discord previews

Selecting multiple comps preserves their display order. The first selected comp
is featured in Discord previews; use its star action to move another comp to the
front. **Copy link** emits a managed Azure Function URL that serves Open Graph
HTML and a generated 1200×630 PNG, then redirects browsers back to the client app.
Search itself remains entirely client-side.

To run the static app and managed API together locally:

```bash
npm --prefix api install
npx @azure/static-web-apps-cli start web --api-location api --func-args "--javascript"
```

## Team Planner Codes

Set 18 uses the version 2 team-code format:

```text
02 + ten 3-hex-digit champion IDs + TFTSet18
```

Each champion slot is Riot's 12-bit `team_planner_code`; `000` is an empty slot.
For example, `3f7` is Cinderling and `429` is Pebbles. The builder retrieves these
IDs from Riot's team-planner dataset through CommunityDragon, and result rows encode
them directly for import into the TFT client.

Riot assigns all nine Lux origins the same planner ID (`413`), so importing a code
containing Lux cannot preserve which origin variant was shown.

## Test

```bash
npm test
npm run check
```

## Data

`web/traits/data.json` is generated from the checked-in `set18-roster.json`,
[CommunityDragon](https://communitydragon.org), Riot's team-planner data,
[LoLChess](https://lolchess.gg), and a checked-in origin/class taxonomy sourced
from [Blitz](https://utils.iesdev.com/static/json/tftTest/set18/en_us/traits).
Placeholder PBE ability names are corrected from [MetaTFT](https://www.metatft.com/new-set#Units).

```bash
python3 -m pip install -r requirements.txt
python3 build_set18.py
```

The builder caches large downloads under the operating system's temporary directory.
It validates roster joins, trait breakpoints, icons, champion stats, and abilities before
replacing `web/traits/data.json`. Node.js is also required because the builder regenerates the
versioned default-search snapshot alongside the dataset.

To compare a directory of archived patch-note JSON files with the generated data:

```bash
python3 check_patch_notes.py path/to/patch-notes
```

The checker exits nonzero when values drift or referenced champions/traits are absent.

### Data Caveats

The reveal roster differs from PBE internals in a few places handled by the builder:

- `Eldritch` was renamed `Blackthorn`.
- Solar and Lunar Lux use `sunbeam` and `moonbeam` asset suffixes.
- Pebbles is internally a Sentry; Ancient Sentinel uses a separate sentinel asset.

Set 18 is PBE data and may change before release.

## Deploy

Pushes to `main` deploy to Azure Static Web Apps through
[the deployment workflow](.github/workflows/azure-static-web-apps.yml). The workflow
runs syntax checks and regression tests before staging the static site.

The deployment token is stored in the `AZURE_STATIC_WEB_APPS_API_TOKEN` repository secret.

## Credits

Game data and icons belong to Riot Games and are retrieved through
[CommunityDragon](https://communitydragon.org). Ability values are sourced from
[LoLChess](https://lolchess.gg). Not endorsed by Riot Games.

---

Not affiliated with or endorsed by Riot Games.
