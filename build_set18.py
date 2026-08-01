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

# Riot's style enum is NOT a 1..n colour ramp. Verified against Blossom, whose
# in-game pips are 3 bronze / 5 silver / 7+9 gold / 11 prismatic and whose raw
# values are 1,3,5,5,6. Int 2 never appears anywhere in Set 18, which is the
# tell that the naive 1=bronze,2=silver,3=gold reading is wrong: it renders
# every silver tier as gold and every gold as prismatic.
STYLE_NAMES = {1: "bronze", 2: "silver", 3: "silver", 4: "unique",
               5: "gold", 6: "prismatic"}

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


def fnv1a(s):
    """Riot hashes most variable names in PBE data: `variables` keys arrive as
    "{a9a813e7}" instead of "BonusDamagePercentBase". It's FNV-1a 32-bit over
    the lowercased name, so the numbers were never missing -- just locked."""
    h = 0x811c9dc5
    for c in s.encode():
        h ^= c
        h = (h * 0x01000193) & 0xffffffff
    return h


def fmt_num(v):
    if isinstance(v, float):
        r = round(v, 4)
        return str(int(r)) if abs(r - int(r)) < 1e-6 else str(round(r, 2))
    return str(v)


def render_row(text, eff):
    """Substitute @Var@ / @Var*100@ / @MinUnits@ using this effect's variables.
    Unknown tokens stay as-is so the UI can render its own "?" marker; we never
    invent a number."""
    vals = {k.lower(): v for k, v in (eff.get("variables") or {}).items()}

    def sub(m):
        expr = m.group(1)
        mm = re.fullmatch(r"([A-Za-z0-9_]+)(?:\*(\d+(?:\.\d+)?))?", expr)
        if not mm:
            return m.group(0)
        key = mm.group(1).lower()
        if key == "minunits":
            return str(eff.get("minUnits"))
        val = vals.get(key)
        if val is None:
            val = vals.get("{%08x}" % fnv1a(key))
        if val is None:
            return m.group(0)
        if isinstance(val, list):
            val = val[0] if val else None
            if val is None:
                return m.group(0)
        if mm.group(2):
            val = val * float(mm.group(2))
        return fmt_num(val)

    return re.sub(r"@([^@]+)@", sub, text)


def clean(s):
    s = re.sub(r"<br\s*/?>", " ", s or "")
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s).strip()


# Champion stats live in the raw character bins, NOT in cdragon/tft/en_us.json.
# That feed's Set 18 block only carries the 19 mock/encounter units. The real
# roster is filed under DA_18_<name> (plus a pile of one-off stems), which is
# why a TFT18_ prefix search finds nothing but art.
LUX_BIN = {"Blossom": "blossom", "Coven": "coven", "Elderwood": "elderwood",
           "Eldritch": "blackthorn", "Fae": "fae", "Inferno": "inferno",
           "Lunar": "moonbeam", "Primal": "primal", "Solar": "sunbeam"}
BIN_OVERRIDE = {
    "Pebbles": "da_18_sentry",          # internally a Sentry, not a krug
    "AncientSentinel": "da_sentinel18",
    "KogMaw": "da_kogmaw18_ad",
    "Raptor": "da_crimsonraptor18",
    "Gnar": "da_18_gnarbig",            # small Gnar is a separate record
    "Krug": "da_krug18",
    "Akali": "da_18_akali_ad",
}


def bin_candidates(name):
    """Every stem Riot has used for a Set 18 champion record, best guess first."""
    out = []
    if name in BIN_OVERRIDE:
        out.append(BIN_OVERRIDE[name])
    if name.startswith("Lux") and name != "Lux":
        art = LUX_BIN.get(name[3:], name[3:].lower())
        out += [f"da_18_lux_{art}", f"da_lux18_{art}"]
    st = name.lower()
    out += [f"da_18_{st}", f"tft18_{st}", f"da_18_{st}_ad",
            f"da_{st}18", f"da_{st}18_ad", f"da_{st}18_ap"]
    return out


def char_record(doc):
    for v in (doc or {}).values():
        if isinstance(v, dict) and v.get("__type") == "TFTCharacterRecord":
            return v
    return None


def stats_from(rec):
    """Pull the handful of numbers a player actually reads off a unit card."""
    def mod(key):
        v = rec.get(key + "Modifiable")
        if isinstance(v, dict):
            return v.get("baseValue")
        return v if isinstance(v, (int, float)) else None

    def plain(key):
        v = rec.get(key)
        if isinstance(v, dict):          # baseMR arrives as a ModifiableFloat
            return v.get("baseValue")
        return v if isinstance(v, (int, float)) else None

    out = {
        "hp": mod("baseHP"),
        "ad": mod("baseDamage"),
        "armor": mod("baseArmor"),
        "mr": plain("baseMR"),
        "as": mod("attackSpeed"),
        "range": mod("attackRange"),
        "crit": plain("baseCritChance"),
    }
    # Attack range is in game units; 180 = melee, one hex is ~180.
    if out["range"]:
        out["hexRange"] = round(out["range"] / 180.0)
    return {k: v for k, v in out.items() if v is not None}


def fetch_stats(names):
    """Resolve + download every champion bin in parallel. Returns {name: stats}."""
    import concurrent.futures

    def one(name):
        for stem in bin_candidates(name):
            url = f"{PBE}/game/characters/{stem}.cdtb.bin.json"
            try:
                rec = char_record(get(url, timeout=120))
            except Exception:
                continue
            if rec:
                return name, stats_from(rec)
        return name, None

    out = {}
    with concurrent.futures.ThreadPoolExecutor(10) as ex:
        for name, st in ex.map(one, names):
            if st:
                out[name] = st
    return out


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
        styles, bp, effs = [], [], []
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
            effs.append(e)

        # Riot splits the per-breakpoint text into <row> tags, one per effect,
        # in breakpoint order. Render each row against its own effect so the
        # numbers land on the right tier. If the counts don't line up we emit
        # nothing rather than risk pairing 5-unit numbers with the 3-unit text.
        rows = re.findall(r"<row>(.*?)</row>", t.get("desc") or "", re.S)
        tiers = []
        if len(rows) == len(effs):
            # Each row opens with its own "(5)" which the UI already prints as
            # the breakpoint pip -- strip it so it isn't shown twice.
            tiers = [re.sub(r"^\s*\(\d+\)\s*", "", clean(render_row(r, e)))
                     for r, e in zip(rows, effs)]

        # The lead paragraph is everything before the first <row>.
        lead = clean(render_row(
            re.split(r"<row>", t.get("desc") or "", 1)[0],
            effs[0] if effs else {}))

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
                       "lead": lead, "tiers": tiers,
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

        # Riot ships Lux's nine Origin forms as one concatenated token
        # ("LuxBlossom"). Split the Origin back out so the UI can read
        # "Lux (Blossom)" instead of a run-on word.
        disp = c["name"]
        if disp.startswith("Lux") and disp != "Lux":
            disp = f"Lux ({disp[3:]})"

        champions.append({"key": api.replace("TFT18_", ""), "name": disp,
                          "cost": c["cost"], "traits": keys, "icon": icon,
                          "mana": c.get("mana")})

    print("fetching champion stat bins (73 requests) ...")
    stats = fetch_stats([c["key"] for c in champions])
    for c in champions:
        st = stats.get(c["key"])
        if st:
            c["stats"] = st
    print(f"  stats resolved for {len(stats)}/{len(champions)} champions")
    nostats = [c["key"] for c in champions if "stats" not in c]
    if nostats:
        print("  ! no stat bin found:", nostats)

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
