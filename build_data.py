#!/usr/bin/env python3
"""Build data.json for the TFT Perfect Traits explorer.

Pulls champions + traits (incl. icon URLs and real trait breakpoints) from
dakgg.io, which resolves better than CommunityDragon and ships CDN icons.

Usage:  python3 build_data.py [--set set17]
"""
import json, os, sys, urllib.request, datetime, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0 (kuro-tft-perfect)"}
DAK = "https://tft.dakgg.io/api/v1/data/{ep}?hl=en-US&set={s}"
CDRAGON_META = "https://raw.communitydragon.org/latest/content-metadata.json"


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="set17")
    ap.add_argument("--out", default=os.path.join(HERE, "web", "data.json"))
    a = ap.parse_args()
    S = a.set

    print(f"fetching {S} champions + traits from dakgg ...")
    craw = fetch(DAK.format(ep="champions", s=S))
    traw = fetch(DAK.format(ep="traits", s=S))

    if craw.get("season") != S:
        print(f"!! dakgg returned season={craw.get('season')!r}, not {S!r}. "
              f"Data for {S} is not published yet.", file=sys.stderr)
        sys.exit(2)

    # ---- traits: key -> display name, icon, breakpoints ----------------
    traits = {}
    for t in traw["traits"]:
        styles = t.get("styles") or []
        mins = sorted({s["min"] for s in styles if s.get("min")})
        traits[t["key"]] = {
            "key": t["key"],
            "name": t.get("name") or t["key"],
            "icon": t.get("whiteImageUrl") or t.get("imageUrl"),
            # breakpoints: unit counts at which the trait activates / upgrades
            "bp": mins,
            "styles": [{"style": s.get("style"), "min": s.get("min"), "max": s.get("max")}
                       for s in styles],
            "type": t.get("type"),
        }

    # map display name -> key so champion trait lists resolve either way
    byname = {v["name"]: k for k, v in traits.items()}

    champions = []
    for c in craw["champions"]:
        # dakgg's list includes summons/NPCs/PvE units: no traits or no real cost.
        # Playable shop units are cost 1-5 with at least one trait.
        _cost = c.get("cost")
        _cost = _cost[0] if isinstance(_cost, list) else _cost
        if not c.get("traits") or not _cost or not (1 <= _cost <= 5):
            continue
        if not str(c.get("ingameKey", "")).startswith(f"TFT{S[3:]}_"):
            continue
        keys = []
        for t in c.get("traits", []):
            if t in traits:
                keys.append(t)
            elif t in byname:
                keys.append(byname[t])
            else:
                keys.append(t)
                traits.setdefault(t, {"key": t, "name": t, "icon": None,
                                      "bp": [2], "styles": [], "type": None})
        cost = _cost
        champions.append({
            "key": c["key"],
            "name": c.get("name") or c["key"],
            "cost": cost,
            "traits": keys,
            "icon": c.get("imageUrl"),
        })

    champions.sort(key=lambda c: (c["cost"], c["name"]))

    # drop traits nobody has (dakgg ships some unused/unique rows)
    used = {t for c in champions for t in c["traits"]}
    traits = {k: v for k, v in traits.items() if k in used}
    for v in traits.values():
        if not v["bp"]:
            v["bp"] = [1]

    try:
        build = fetch(CDRAGON_META).get("version", "?")
    except Exception:
        build = "?"

    out = {
        "set": S,
        "gameBuild": build,
        "builtAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "traits": traits,
        "champions": champions,
    }

    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {a.out}: {len(champions)} champions, {len(traits)} traits, build {build}")


if __name__ == "__main__":
    main()
