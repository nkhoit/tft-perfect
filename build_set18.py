#!/usr/bin/env python3
"""Build Set 18 (Enchanted Wilds) data.json for the TFT Trait Explorer.

This stitches:
  - champion roster (cost + traits)  <- checked-in reveal capture
  - trait breakpoints + display names <- CommunityDragon **pbe** branch (TFTSet18)
  - icons                             <- CommunityDragon pbe game assets, path-verified
                                         against cdragon/files.exported.txt

Usage: python3 build_set18.py [--out web/data.json]
"""
import argparse, json, os, re, sys, urllib.request, urllib.error, datetime, hashlib, concurrent.futures, html, tempfile
import xxhash

HERE = os.path.dirname(os.path.abspath(__file__))
REVEAL = os.path.join(HERE, "set18-roster.json")
OUT = os.path.join(HERE, "web", "data.json")

UA = {"User-Agent": "Mozilla/5.0 (kuro-tft-perfect)"}
PBE = "https://raw.communitydragon.org/pbe"
CD_TFT = PBE + "/cdragon/tft/en_us.json"
CD_FILES = PBE + "/cdragon/files.exported.txt"
TEAM_PLANNER = PBE + "/plugins/rcp-be-lol-game-data/global/default/v1/tftchampions-teamplanner.json"
ASSET = PBE + "/"
STRINGTABLE = PBE + "/game/en_us/data/menu/en_us/tft.stringtable.json"
BUILD_CACHE = os.path.join(tempfile.gettempdir(), "tft-trait-explorer")
STRINGTABLE_CACHE = os.path.join(BUILD_CACHE, "tft-pbe-en_us.stringtable.json")
LOLCHESS = "https://lolchess.gg/champions/set18/yorick?hl=en-US"
LOLCHESS_CACHE = os.path.join(BUILD_CACHE, "lolchess-set18-champions.html")
LOLCHESS_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/131.0 Safari/537.36"}

# Riot's style enum is NOT a 1..n colour ramp. Verified against Blossom, whose
# in-game pips are 3 bronze / 5 silver / 7+9 gold / 11 prismatic and whose raw
# values are 1,3,5,5,6. Int 2 never appears anywhere in Set 18, which is the
# tell that the naive 1=bronze,2=silver,3=gold reading is wrong: it renders
# every silver tier as gold and every gold as prismatic.
STYLE_NAMES = {1: "bronze", 2: "silver", 3: "silver", 4: "unique",
               5: "gold", 6: "prismatic"}

# The pre-PBE reveal capture used names Riot has since changed on PBE.
TRAIT_ALIAS = {"Eldritch": "Blackthorn"}

# Structured board-capacity rules are kept explicit instead of parsed from
# player-facing trait text.
TRAIT_TEAM_SIZE = {
    "Riftbeast": [{"min": 10, "slots": 2}],
}

UNIT_ROLES = {
    f"{damage}{role}"
    for damage in ("AD", "AP", "Hybrid")
    for role in ("Carry", "Caster", "Fighter", "Reaper", "Specialist", "Tank")
}

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


def clean_lolchess(s, keep_icons=False, keep_breaks=False):
    s = html.unescape(s or "")
    if keep_breaks:
        s = re.sub(r"(?:\s*<br\s*/?>\s*){2,}", "\n\n", s, flags=re.I)
        s = re.sub(r"\s*<br\s*/?>\s*", "\n", s, flags=re.I)
    else:
        s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    if not keep_icons:
        s = re.sub(r"%i:\w+%", "", s, flags=re.I)
        # Icons often sit inside parens ("320(%i:scaleAD%)"); stripping the
        # icon alone would leave bare "()" litter in player-facing text.
        s = re.sub(r"\(\s*\)", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    if keep_breaks:
        s = re.sub(r"[^\S\n]+", " ", s)
        s = re.sub(r" *\n *", "\n", s)
        return re.sub(r"\n{3,}", "\n\n", s).strip()
    return re.sub(r"\s+", " ", s).strip()


def adaptor_ability_sections(s):
    """Preserve LoLChess's ordered shared, AD, and AP ability paragraphs."""
    sections = []
    for part in re.split(r"(?:\s*<br\s*/?>\s*){2,}", s or "", flags=re.I):
        match = re.match(
            r"^\s*Adaptor\s*\(\s*%i:scale(AD|AP)%\s*\)\s*:\s*(.*)$",
            part, re.I | re.S)
        body = match.group(2) if match else part
        desc = clean_lolchess(body, keep_icons=True)
        if not desc:
            continue
        section = {"desc": desc}
        if match:
            section["mode"] = match.group(1).upper()
        sections.append(section)
    modes = {section["mode"] for section in sections if section.get("mode")}
    return sections if modes == {"AD", "AP"} else []


def lolchess_champions():
    """Load one cached Next.js payload; fetched HTML is parsed only as data."""
    if not os.path.exists(LOLCHESS_CACHE):
        os.makedirs(os.path.dirname(LOLCHESS_CACHE), exist_ok=True)
        req = urllib.request.Request(LOLCHESS, headers=LOLCHESS_UA)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            retry = e.headers.get("Retry-After")
            if e.code == 429:
                raise RuntimeError("LoLChess rate limited the single request"
                                   + (f" (Retry-After: {retry})" if retry else "")) from e
            raise
        tmp = LOLCHESS_CACHE + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, LOLCHESS_CACHE)

    raw = open(LOLCHESS_CACHE, encoding="utf-8").read()
    match = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
                      raw, re.S | re.I)
    if not match:
        raise RuntimeError("LoLChess __NEXT_DATA__ payload not found")
    queries = (json.loads(match.group(1))["props"]["pageProps"]
               ["dehydratedState"]["queries"])
    for query in queries:
        key = query.get("queryKey") or []
        if "championRefs" in key and "en" in key:
            data = query.get("state", {}).get("data", {})
            return data.get("champions") or []
    raise RuntimeError("LoLChess English championRefs query not found")


def rst_hash(key):
    """PBE uses RST v5: lowercase XXH3-64, retaining the low 38 bits."""
    return "{%010x}" % (xxhash.xxh3_64_intdigest(key.lower()) & ((1 << 38) - 1))


def stringtable():
    # This file is ~25MB. Cache it outside the repo so repeated builds do not
    # punish CommunityDragon (or us) with another download.
    if not os.path.exists(STRINGTABLE_CACHE):
        os.makedirs(os.path.dirname(STRINGTABLE_CACHE), exist_ok=True)
        req = urllib.request.Request(STRINGTABLE, headers=UA)
        tmp = STRINGTABLE_CACHE + ".tmp"
        with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
            f.write(r.read())
        os.replace(tmp, STRINGTABLE_CACHE)
    with open(STRINGTABLE_CACHE, encoding="utf-8") as f:
        return json.load(f)["entries"]


def ability_from(doc, strings):
    """Find the castable SpellObject, then resolve its generated RST keys."""
    spells = []
    for v in (doc or {}).values():
        if not isinstance(v, dict) or v.get("__type") != "SpellObject":
            continue
        script = v.get("mScriptName") or ""
        spell = v.get("mSpell") or {}
        tip = ((spell.get("mClientData") or {}).get("mTooltipData") or {})
        if tip and script.lower().endswith("spell"):
            spells.append((script, spell))
    if not spells:
        return None

    # Missile/helper SpellObjects can also have tooltip metadata. The player
    # ability is the shortest script ending in exactly "Spell".
    script, spell = min(spells, key=lambda x: len(x[0]))
    base = "generatedtip_spelltft_" + script.lower()
    name = strings.get(rst_hash(base + "_displayname"))
    raw = strings.get(rst_hash(base + "_tooltip"))
    if not name or not raw:
        return None

    m = re.search(r"<mainText>(.*?)</mainText>", raw, re.S | re.I)
    text = m.group(1) if m else raw
    values = {v.get("name", "").lower(): (v.get("values") or [])[1:4]
              for v in spell.get("DataValues") or []}

    def sub(match):
        token = match.group(1)
        mm = re.fullmatch(r"([A-Za-z0-9_]+)(?:\*(\d+(?:\.\d+)?))?", token)
        if not mm:
            return match.group(0)
        vals = values.get(mm.group(1).lower())
        if vals and len(vals) == 3:
            mult = float(mm.group(2) or 1)
            return "/".join(fmt_num(v * mult) for v in vals)
        # Runtime-only values are intentionally left visible; app.js renders
        # them as a '?' rather than inventing live PBE balance numbers.
        if token == "SpellModifierDescriptionAppend":
            return ""
        return match.group(0)

    text = re.sub(r"@([^@]+)@", sub, text)
    text = re.sub(r"%i:[^%]+%", "", text)
    # Stringtable JSON sometimes preserves Riot's literal "\\n" markup.
    text = text.replace("\\r", " ").replace("\\n", " ")
    text = html.unescape(text)
    return {"name": clean(name), "desc": clean(text)}


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
    if name == "Gnar":
        out.append("da_18_gnarsmall")       # big form owns stats; small owns the real tooltip
    if name.startswith("Lux") and name != "Lux":
        art = LUX_BIN.get(name[3:], name[3:].lower())
        out += [f"da_18_lux_{art}", f"da_lux18_{art}"]
    st = name.lower()
    out += [f"da_18_{st}", f"tft18_{st}", f"da_18_{st}_ad",
            f"da_{st}18", f"da_{st}18_ad", f"da_{st}18_ap"]
    return out


def join_lolchess(names, refs):
    """Join Riot bin stems first; only Raptor needs a key-based escape hatch."""
    by_ingame = {(c.get("ingameKey") or "").lower(): c for c in refs
                 if c.get("ingameKey")}
    by_key = {c.get("key"): c for c in refs}
    joined, failures = {}, {}
    for name in names:
        candidates = bin_candidates(name)
        if name.startswith("Lux") and name != "Lux":
            # LoLChess keys the art variant by its display name (Lux_Lunar),
            # while Riot's bin stem uses the VFX name (moonbeam) -- try both.
            candidates.append("tft18_lux_" + LUX_BIN.get(
                name[3:], name[3:].lower()))
            candidates.append("tft18_lux_" + name[3:].lower())
        ref = next((by_ingame.get(stem.lower()) for stem in candidates
                    if by_ingame.get(stem.lower())), None)
        if not ref and name == "Raptor":
            # This hidden summon alone ships ingameKey=null on LoLChess.
            ref = by_key.get("CrimsonRaptorMini")
        if ref:
            joined[name] = ref
        else:
            failures[name] = "no LoLChess ingameKey matched bin candidates"
    return joined, failures


def join_team_planner(names, refs):
    """Join Riot's stable 12-bit planner IDs through the internal character name."""
    by_character = {(c.get("character_id") or "").lower(): c for c in refs
                    if c.get("character_id")}
    joined, failures = {}, {}
    for name in names:
        candidates = bin_candidates(name)
        if name.startswith("Lux"):
            candidates.append("da_lux18_base")
        ref = next((by_character.get(stem.lower()) for stem in candidates
                    if by_character.get(stem.lower())), None)
        code = (ref or {}).get("team_planner_code")
        if isinstance(code, int) and 0 < code <= 0xfff:
            joined[name] = code
        else:
            failures[name] = "no valid team_planner_code matched bin candidates"
    return joined, failures


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


def fetch_champion_data(names, strings):
    """Resolve every champion bin once. Returns {name: {stats, ability}}."""
    import concurrent.futures

    def one(name):
        stats = ability = None
        for stem in bin_candidates(name):
            url = f"{PBE}/game/characters/{stem}.cdtb.bin.json"
            try:
                doc = get(url, timeout=120)
                rec = char_record(doc)
            except Exception:
                continue
            if rec and not stats:
                stats = stats_from(rec)
            candidate = ability_from(doc, strings)
            if candidate and (not ability or ability["name"] == "Placeholder Name"):
                ability = candidate
            if stats and ability and ability["name"] != "Placeholder Name":
                break
        # Lux's nine Origin records contain stats only; one shared base bin
        # owns the spell and localization keys.
        if not ability and name.startswith("Lux"):
            try:
                doc = get(f"{PBE}/game/characters/da_lux18_base.cdtb.bin.json", timeout=120)
                ability = ability_from(doc, strings)
            except Exception:
                pass
        return name, {"stats": stats, "ability": ability}

    out = {}
    with concurrent.futures.ThreadPoolExecutor(10) as ex:
        for name, data in ex.map(one, names):
            out[name] = data
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    os.makedirs(BUILD_CACHE, exist_ok=True)

    print("loading Set 18 reveal roster ...")
    with open(REVEAL, encoding="utf-8") as f:
        reveal = json.load(f)

    print("fetching CommunityDragon PBE (TFTSet18) ...")
    cd = get(CD_TFT)
    s18 = cd["sets"]["18"]

    print("fetching exported-file manifest (~58MB, verifies icon paths) ...")
    files = set(get(CD_FILES, raw=True).decode("utf-8", "replace").split("\n"))
    print("fetching Riot team-planner champion IDs ...")
    planner_refs = get(TEAM_PLANNER).get("TFTSet18") or []

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
        upgrades = []
        if len(rows) == len(effs):
            # Each row opens with its own "(5)" which the UI already prints as
            # the breakpoint pip -- strip it so it isn't shown twice.
            tiers = [re.sub(r"^\s*\(\d+\)\s*", "", clean(render_row(r, e)))
                     for r, e in zip(rows, effs)]

        # Solar has one trait breakpoint followed by four three-star upgrade
        # thresholds separated with <br> tags inside that same row.
        if key == "Solar" and len(rows) == 1 and effs:
            parts = [clean(part) for part in
                     re.split(r"<br\s*/?>", render_row(rows[0], effs[0]),
                              flags=re.I)]
            parts = [part for part in parts if part]
            parsed = []
            for part in parts[1:]:
                match = re.match(r"^(\d+)\s*:\s*(.*)$", part)
                if match:
                    parsed.append({"count": int(match.group(1)),
                                   "desc": match.group(2)})
            if [upgrade["count"] for upgrade in parsed] == [1, 3, 5, 8]:
                tiers = [re.sub(r"^\s*\(\d+\)\s*", "", parts[0])]
                upgrades = parsed

        # The lead paragraph is everything before the first <row>.
        lead = clean(render_row(
            re.split(r"<row>", t.get("desc") or "", maxsplit=1)[0],
            effs[0] if effs else {}))
        desc = clean(t.get("desc"))

        # PBE's Adaptor rows contain a bare "OR" where the client renders the
        # AD and AP text icons. Restore the transport tokens for the web card.
        if key == "Adaptor":
            stat_choice = "%i:scaleAD% or %i:scaleAP%"
            tiers = [re.sub(r"\bOR\b", stat_choice, tier) for tier in tiers]
            desc = re.sub(r"\bOR\b", stat_choice, desc)
        elif key == "Defender":
            resist_icons = "%i:scaleArmor%%i:scaleMR%"
            tiers = [f"{tier} {resist_icons}" for tier in tiers]
            desc = desc.replace(
                "@DefenderDefenseGain@",
                f"@DefenderDefenseGain@ {resist_icons}")

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

        trait = {"key": key, "name": name, "icon": icon,
                 "bp": bp or [1], "styles": styles,
                 "lead": lead, "tiers": tiers,
                 "desc": desc}
        if upgrades:
            trait["upgrades"] = upgrades
        if key in TRAIT_TEAM_SIZE:
            trait["teamSize"] = TRAIT_TEAM_SIZE[key]
        traits[key] = trait
        bykey[key] = key
        bykey[name] = key
        bykey[re.sub(r"[^A-Za-z0-9]", "", t["apiName"].split("_")[-1])] = key

    # ---- champions: reveal roster, resolve trait keys + icons ----------
    champions, unresolved, mechanic_errors = [], set(), []
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

        champion = {"key": api.replace("TFT18_", ""), "name": disp,
                    "cost": c["cost"], "traits": keys, "icon": icon,
                    "mana": c.get("mana")}
        slots = c.get("slots", 1)
        if not isinstance(slots, int) or slots < 1:
            mechanic_errors.append(f"{api} has invalid slot cost {slots!r}")
        elif slots != 1:
            champion["slots"] = slots
        if c.get("group"):
            champion["group"] = c["group"]

        trait_points = {}
        for raw_name, points in (c.get("traitPoints") or {}).items():
            trait_name = TRAIT_ALIAS.get(raw_name, raw_name)
            trait_key = (bykey.get(trait_name)
                         or bykey.get(re.sub(r"[^A-Za-z0-9]", "", trait_name)))
            if not trait_key or trait_key not in keys:
                mechanic_errors.append(
                    f"{api} traitPoints references unowned trait {raw_name!r}")
                continue
            if not isinstance(points, int) or points < 1:
                mechanic_errors.append(
                    f"{api} has invalid {raw_name} trait points {points!r}")
                continue
            if points != 1:
                trait_points[trait_key] = points
        if trait_points:
            champion["traitPoints"] = trait_points
        champions.append(champion)

    print("loading cached PBE string table (~25MB) ...")
    strings = stringtable()
    print("fetching champion stat + ability bins (73 requests) ...")
    champion_data = fetch_champion_data([c["key"] for c in champions], strings)

    print("loading cached LoLChess Set 18 champion payload ...")
    lol_refs = lolchess_champions()
    lol_joined, lol_failures = join_lolchess(
        [c["key"] for c in champions], lol_refs)
    mana_disagreements = []
    for c in champions:
        data = champion_data.get(c["key"]) or {}
        if data.get("stats"):
            c["stats"] = data["stats"]
        if data.get("ability"):
            c["ability"] = data["ability"]
            c["ability"]["source"] = "communitydragon"

        ref = lol_joined.get(c["key"])
        skill = (ref or {}).get("skill") or {}
        role = (ref or {}).get("role")
        if role:
            if role in UNIT_ROLES:
                c["role"] = role
            else:
                mechanic_errors.append(f"{c['key']} has unknown unit role {role!r}")
        resolved = clean_lolchess(
            skill.get("desc"), keep_icons=True, keep_breaks=True)
        if resolved:
            ability = c.setdefault("ability", {"name": skill.get("name") or "",
                                                "desc": ""})
            # Name and desc remain first-party even while PBE spell values are
            # placeholders; numeric fields are explicitly third-party.
            ability.update({"descResolved": resolved,
                            "stats": [clean_lolchess(x)
                                      for x in skill.get("stats") or []],
                            "startingMana": skill.get("startingMana"),
                            "skillMana": skill.get("skillMana"),
                            "source": "lolchess"})
            sections = adaptor_ability_sections(skill.get("desc"))
            if sections:
                ability["sections"] = sections
            expected = ((c.get("mana") or {}).get("start"),
                        (c.get("mana") or {}).get("max"))
            actual = (skill.get("startingMana"), skill.get("skillMana"))
            if None not in actual and actual != expected:
                mana_disagreements.append((c["key"], expected, actual))
                # The reveal capture is a fixed Jul-12 snapshot while mana is
                # tuned heavily through PBE, so prefer the live scrape and keep
                # the stale pair as provenance rather than silently dropping it.
                c["manaReveal"] = c.get("mana")
                c["mana"] = {"start": actual[0], "max": actual[1]}
                c["manaSource"] = "lolchess"

    nstats = sum("stats" in c for c in champions)
    nability = sum("ability" in c for c in champions)
    nresolved = sum(bool((c.get("ability") or {}).get("descResolved"))
                    for c in champions)
    adaptor_mode_failures = [
        c["key"] for c in champions if "Adaptor" in c["traits"]
        and {section["mode"] for section in
             (c.get("ability") or {}).get("sections", [])
             if section.get("mode")} != {"AD", "AP"}
    ]
    print(f"  stats resolved for {nstats}/{len(champions)} champions")
    print(f"  abilities resolved for {nability}/{len(champions)} champions")
    print(f"  LoLChess numeric descriptions for {nresolved}/{len(champions)} champions")
    if lol_failures:
        for name, reason in sorted(lol_failures.items()):
            print(f"  ! LoLChess join failed: {name}: {reason}")
    if mana_disagreements:
        print("  ! mana disagreements (roster start/max vs LoLChess start/max):")
        for name, expected, actual in mana_disagreements:
            print(f"      {name}: {expected} vs {actual}")
    nostats = [c["key"] for c in champions if "stats" not in c]
    missing_roles = [c["key"] for c in champions if "role" not in c]
    if nostats:
        print("  ! no stat bin found:", nostats)

    champions.sort(key=lambda c: (c["cost"], c["name"]))

    planner_joined, planner_failures = join_team_planner(
        [c["key"] for c in champions], planner_refs)
    for c in champions:
        if c["key"] in planner_joined:
            c["teamPlannerCode"] = planner_joined[c["key"]]

    used = {t for c in champions for t in c["traits"]}
    traits = {k: v for k, v in traits.items() if k in used}

    missing_icon = [c["name"] for c in champions if not c["icon"]]
    missing_trait_icon = [t["name"] for t in traits.values() if not t["icon"]]
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
    duplicate_champions = sorted({c["key"] for c in champions
                                  if sum(x["key"] == c["key"] for x in champions) > 1})


    out = {"set": "set18", "setName": "Enchanted Wilds",
           "teamPlannerSet": "TFTSet18",
           "gameBuild": "PBE TFTSet18",
           "source": ("checked-in reveal roster + CommunityDragon PBE TFTSet18 "
                      "+ Riot team planner + LoLChess"),
           "note": "PBE data — breakpoints are live-PBE and may shift before 18.1 launch (2026-08-12).",
           "abilityNote": ("Ability numbers and structured stat lines sourced from "
                           "LoLChess championRefs en/set18 on "
                           f"{datetime.date.today().isoformat()}; bin-derived ability "
                           "name and token-placeholder desc are retained."),
           "builtAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "traits": traits, "champions": champions}

    errors = []
    if unresolved:
        errors.append(f"unresolved trait names: {sorted(unresolved)}")
    if missing_icon:
        errors.append(f"{len(missing_icon)} champions without icons: {missing_icon[:12]}")
    if missing_trait_icon:
        errors.append(f"{len(missing_trait_icon)} traits without icons: {missing_trait_icon[:12]}")
    if missing_bp:
        errors.append(f"{len(missing_bp)} traits without breakpoints: {missing_bp[:12]}")
    if shared:
        errors.append(f"{len(shared)} shared champion icons: " +
                      "; ".join(" == ".join(group) for group in shared))
    if errs:
        errors.append(f"{len(errs)} icons failed to fetch: {errs[:6]}")
    if no_ability:
        errors.append(f"{len(no_ability)} champions without ability text: {no_ability}")
    if duplicate_champions:
        errors.append(f"duplicate champion keys: {duplicate_champions}")
    if nostats:
        errors.append(f"{len(nostats)} champions without stats: {nostats}")
    if missing_roles:
        errors.append(f"{len(missing_roles)} champions without roles: {missing_roles}")
    if lol_failures:
        errors.append(f"{len(lol_failures)} LoLChess joins failed: {lol_failures}")
    if planner_failures:
        errors.append(f"{len(planner_failures)} team-planner joins failed: {planner_failures}")
    if nresolved != len(champions):
        errors.append(f"numeric ability descriptions resolved for only {nresolved}/{len(champions)} champions")
    if adaptor_mode_failures:
        errors.append(f"Adaptor ability modes missing: {adaptor_mode_failures}")
    solar_upgrades = (traits.get("Solar") or {}).get("upgrades", [])
    if [upgrade.get("count") for upgrade in solar_upgrades] != [1, 3, 5, 8]:
        errors.append("Solar three-star upgrades are missing or malformed")
    errors.extend(mechanic_errors)
    for trait_key, tiers in TRAIT_TEAM_SIZE.items():
        trait = traits.get(trait_key)
        if not trait:
            errors.append(f"team-size rule references missing trait {trait_key}")
            continue
        invalid = [tier for tier in tiers if tier["min"] not in trait["bp"]
                   or not isinstance(tier["slots"], int) or tier["slots"] < 1]
        if invalid:
            errors.append(f"invalid team-size rule for {trait_key}: {invalid}")

    if errors:
        print("data validation failed; existing output was not changed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        raise SystemExit(1)

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, out_path)
    print(f"wrote {out_path}: {len(champions)} champions, {len(traits)} traits")


if __name__ == "__main__":
    main()
