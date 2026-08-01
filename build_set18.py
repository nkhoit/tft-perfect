#!/usr/bin/env python3
"""Build Set 18 (Enchanted Wilds) data.json for the TFT Trait Explorer.

Set 18 is not on dakgg yet (dakgg currentSeason == set17), so this stitches:
  - champion roster (cost + traits)  <- local reveal capture, refs/tft-moltbot/set18
  - trait breakpoints + display names <- CommunityDragon **pbe** branch (TFTSet18)
  - icons                             <- CommunityDragon pbe game assets, path-verified
                                         against cdragon/files.exported.txt

Once dakgg publishes set18, `build_data.py --set set18` supersedes this.

Usage: python3 build_set18.py
"""
import json, os, re, sys, urllib.request, datetime, hashlib, concurrent.futures

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.abspath(os.path.join(HERE, "..", ".."))
REVEAL = os.path.join(WS, "refs", "tft-moltbot", "set18", "champions.json")
OUT = os.path.join(HERE, "web", "data-set18.json")

UA = {"User-Agent": "Mozilla/5.0 (kuro-tft-perfect)"}
PBE = "https://raw.communitydragon.org/pbe"
CD_TFT = PBE + "/cdragon/tft/en_us.json"
CD_FILES = PBE + "/cdragon/files.exported.txt"
ASSET = PBE + "/"

STYLE_NAMES = {1: "bronze", 2: "silver", 3: "gold", 4: "unique", 5: "prismatic", 6: "prismatic"}

# The pre-PBE reveal capture used names Riot has since changed on PBE.
TRAIT_ALIAS = {"Eldritch": "Blackthorn"}

# Units whose art doesn't follow the tft18_<name>/tft18_<name>_square.png rule.
ICON_OVERRIDE = {
    # Pebbles is internally DA_18_Sentry, NOT a krug. Its ability is "Azure Laser".
    # The krugmini guess was wrong art AND cost us the ability join.
    "TFT18_Pebbles": "game/assets/characters/tft18_sentry/tft18_sentry_square.png",
    "TFT18_AncientSentinel": "game/assets/characters/tft18_sentinel/tft18_sentinel_square.png",
}
# Lux has one form per Origin; PBE art uses its own suffixes.
LUX_ART = {"Blossom": "blossom", "Coven": "coven", "Elderwood": "elderwood",
           "Eldritch": "blackthorn", "Fae": "fae", "Inferno": "inferno",
           "Lunar": "moonbeam", "Primal": "primal", "Solar": "sunbeam"}
for _origin, _art in LUX_ART.items():
    ICON_OVERRIDE[f"TFT18_Lux{_origin}"] = f"game/assets/characters/tft18_lux/tft18_lux_{_art}_square.png"


def get(url, raw=False, timeout=300):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
    return b if raw else json.loads(b)


def clean(s):
    s = re.sub(r"<br\s*/?>", " ", s or "")
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


def main():
    print("loading Set 18 reveal roster ...")
    reveal = json.load(open(REVEAL))

    print("fetching CommunityDragon PBE (TFTSet18) ...")
    cd = get(CD_TFT)
    s18 = cd["sets"]["18"]

    print("fetching exported-file manifest (~58MB, verifies icon paths) ...")
    files = set(get(CD_FILES, raw=True).decode("utf-8", "replace").split("\n"))

    # ---- traits: real breakpoints from PBE -----------------------------
    traits = {}
    bykey = {}
    for t in s18["traits"]:
        name = t["name"]
        key = re.sub(r"[^A-Za-z0-9]", "", name)
        effects = sorted(t.get("effects") or [], key=lambda e: e.get("minUnits", 0))
        styles, bp = [], []
        for e in effects:
            mn = e.get("minUnits")
            if not mn:
                continue
            mx = e.get("maxUnits")
            if mx and mx >= 25000:
                mx = None
            styles.append({"style": STYLE_NAMES.get(e.get("style"), "bronze"),
                           "min": mn, "max": mx})
            bp.append(mn)

        icon = None
        # CommunityDragon gives the authoritative asset path in `icon`; the
        # name-derived guesses only cover the cases where it's missing.
        cd_icon = (t.get("icon") or "").lower().replace(".tex", ".png")
        stem = re.sub(r"[^a-z0-9]", "", name.lower())
        for cand in (f"game/{cd_icon}" if cd_icon else None,
                     f"game/assets/ux/traiticons/trait_icon_18_{stem}.png",
                     f"game/assets/ux/traiticons/trait_icon_18_{t['apiName'].split('_')[-1].lower()}.png"):
            if cand and cand in files:
                icon = ASSET + cand
                break

        traits[key] = {"key": key, "name": name, "icon": icon,
                       "bp": bp or [1], "styles": styles,
                       "desc": clean(t.get("desc"))}
        bykey[key] = key
        bykey[name] = key
        bykey[re.sub(r"[^A-Za-z0-9]", "", t["apiName"].split("_")[-1])] = key

    # ---- champions: reveal roster, resolve trait keys + icons ----------
    champions, unresolved = [], set()
    for c in reveal:
        api = c["apiName"]                      # TFT18_Akali
        stem = api.lower()                      # tft18_akali
        keys = []
        for t in c["traits"]:
            t = TRAIT_ALIAS.get(t, t)
            k = bykey.get(t) or bykey.get(re.sub(r"[^A-Za-z0-9]", "", t))
            if not k:
                unresolved.add(t)
                k = re.sub(r"[^A-Za-z0-9]", "", t)
                traits.setdefault(k, {"key": k, "name": t, "icon": None,
                                      "bp": [2], "styles": [], "desc": ""})
            keys.append(k)

        icon = None
        for cand in (ICON_OVERRIDE.get(api),
                     f"game/assets/characters/{stem}/{stem}_square.png",
                     f"game/assets/characters/{stem}/hud/{stem}_square.png"):
            if not cand:
                continue
            if cand in files:
                icon = ASSET + cand
                break
        if not icon:
            pre = f"game/assets/characters/{stem}/skins/base/images/"
            tiles = sorted(f for f in files if f.startswith(pre) and "_splash_tile_" in f and f.endswith(".png"))
            if tiles:
                icon = ASSET + tiles[0]

        champions.append({"key": api.replace("TFT18_", ""), "name": c["name"],
                          "cost": c["cost"], "traits": keys, "icon": icon,
                          "mana": c.get("mana")})

    champions.sort(key=lambda c: (c["cost"], c["name"]))

    used = {t for c in champions for t in c["traits"]}
    traits = {k: v for k, v in traits.items() if k in used}

    missing_icon = [c["name"] for c in champions if not c["icon"]]
    missing_bp = [t["name"] for t in traits.values() if t["bp"] == [1] and not t["styles"]]

    # ---- integrity checks ---------------------------------------------
    # Pebbles shipped with Krug's art for a while because the icon guess
    # (tft18_krugmini) resolved to a real, valid, *wrong* file. A 200 OK
    # proves the path exists, not that it belongs to this unit -- so also
    # compare image bytes and flag any two units sharing one portrait.
    print("verifying icon uniqueness ...")

    def digest(c):
        try:
            return c["name"], hashlib.md5(get(c["icon"], raw=True, timeout=60)).hexdigest()
        except Exception as e:
            return c["name"], f"ERROR {e}"

    dupes, errs = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for name, h in ex.map(digest, [c for c in champions if c["icon"]]):
            if h.startswith("ERROR"):
                errs.append(f"{name}: {h}")
            else:
                dupes.setdefault(h, []).append(name)
    shared = [v for v in dupes.values() if len(v) > 1]

    # A unit with no ability text is usually a bad name guess on our side,
    # not missing upstream data -- that's exactly how Pebbles hid.
    no_ability = [c["name"] for c in champions if not c.get("ability")]


    out = {"set": "set18", "setName": "Enchanted Wilds",
           "gameBuild": "PBE TFTSet18",
           "source": "reveal roster + CommunityDragon PBE TFTSet18",
           "note": "PBE data — breakpoints are live-PBE and may shift before 18.1 launch (2026-08-12).",
           "builtAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "traits": traits, "champions": champions}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"wrote {OUT}: {len(champions)} champions, {len(traits)} traits")
    if unresolved:
        print("  ! unresolved trait names:", sorted(unresolved))
    if missing_icon:
        print(f"  ! {len(missing_icon)} champions without icons:", missing_icon[:12])
    if missing_bp:
        print(f"  ! {len(missing_bp)} traits without breakpoints:", missing_bp[:12])
    if shared:
        print(f"  !! {len(shared)} icon(s) shared by multiple units -- likely a bad")
        print("     icon guess; a valid path is not proof of the right unit:")
        for grp in shared:
            print("      ", " == ".join(grp))
    if errs:
        print(f"  ! {len(errs)} icon(s) failed to fetch:", errs[:6])
    if no_ability:
        print(f"  ! {len(no_ability)} champions without ability text", end="")
        print(" (check for a wrong bin/spell-stem guess before blaming PBE):")
        print("      ", no_ability)


if __name__ == "__main__":
    main()
