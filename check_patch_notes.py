#!/usr/bin/env python3
"""Diff patch-note values against the built data so drift is caught, not assumed.

Patch notes are the only first-party numbers we get for Set 18 while the PBE
bins ship placeholders, so they are the accuracy oracle for the LoLChess scrape.
"""
import json, os, re, glob

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.abspath(os.path.join(HERE, "..", ".."))
NOTES = os.path.join(WS, "refs", "tft-moltbot", "set18", "patch-notes")
DATA = os.path.join(HERE, "web", "data-set18.json")

# Patch notes use display names; our roster uses bin-ish keys.
ALIAS = {"Elder Dragon": "ElderDragon", "Mama Beak": "MamaBeak",
         "Kha'Zix": "KhaZix", "Murkwolf": "Murkwolf"}


def blob(c):
    a = c.get("ability") or {}
    return " | ".join([a.get("descResolved") or ""] + (a.get("stats") or []))


def main():
    d = json.load(open(DATA))
    ch = {c["name"]: c for c in d["champions"]}
    ch.update({c["key"]: c for c in d["champions"]})
    # traits is keyed by name, not a list.
    traits = d.get("traits") or {}

    for path in sorted(glob.glob(os.path.join(NOTES, "*.json"))):
        pn = json.load(open(path))
        print(f"\n=== {pn['label']} ({os.path.basename(path)}) ===")
        for e in pn.get("champions", []):
            name = ALIAS.get(e["name"], e["name"])
            c = ch.get(name) or ch.get(e["name"])
            if not c:
                print(f"  ? {e['name']:14s} not in roster")
                continue
            b = blob(c)
            for chg in e["changes"]:
                to = chg["to"]
                if chg["field"] == "Mana":
                    m = c.get("mana") or {}
                    ours = f"{m.get('start')}/{m.get('max')}"
                    tag = "MATCH" if ours == to else "DRIFT"
                    print(f"  {tag} {e['name']:14s} Mana patch={to:12s} ours={ours}")
                    continue
                # Only slash-triples are directly greppable in our text.
                for n in re.findall(r"\d+(?:/\d+)+", to):
                    tag = "found" if n in b else "ABSENT"
                    print(f"  {tag:6s} {e['name']:14s} {chg['field'][:26]:26s} {n}")
        for e in pn.get("traits", []):
            t = traits.get(e["name"])
            mark = "" if t else "  (trait not in data)"
            for chg in e["changes"]:
                print(f"  trait  {e['name']:14s} {chg['field'][:26]:26s} "
                      f"-> {chg['to']}{mark}")


if __name__ == "__main__":
    main()
