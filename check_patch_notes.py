#!/usr/bin/env python3
"""Diff patch-note values against the built data so drift is caught, not assumed.

Patch notes are the only first-party numbers we get for Set 18 while the PBE
bins ship placeholders, so they are the accuracy oracle for the LoLChess scrape.
"""
import argparse, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "web", "data.json")

# Patch notes use display names; our roster uses bin-ish keys.
ALIAS = {"Elder Dragon": "ElderDragon", "Mama Beak": "MamaBeak",
         "Kha'Zix": "KhaZix", "Murkwolf": "Murkwolf"}


def blob(c):
    a = c.get("ability") or {}
    return " | ".join([a.get("descResolved") or ""] + (a.get("stats") or []))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("notes", help="directory or glob containing patch-note JSON files")
    ap.add_argument("--data", default=DATA, help="generated data file")
    args = ap.parse_args()

    pattern = os.path.join(args.notes, "*.json") if os.path.isdir(args.notes) else args.notes
    paths = sorted(glob.glob(pattern))
    if not paths:
        ap.error(f"no patch-note JSON files matched {args.notes!r}")

    with open(args.data, encoding="utf-8") as f:
        d = json.load(f)
    ch = {c["name"]: c for c in d["champions"]}
    ch.update({c["key"]: c for c in d["champions"]})
    traits = {}
    for key, trait in (d.get("traits") or {}).items():
        traits[key] = trait
        traits[trait["name"]] = trait
    drift = False

    for path in paths:
        with open(path, encoding="utf-8") as f:
            pn = json.load(f)
        print(f"\n=== {pn['label']} ({os.path.basename(path)}) ===")
        for e in pn.get("champions", []):
            name = ALIAS.get(e["name"], e["name"])
            c = ch.get(name) or ch.get(e["name"])
            if not c:
                print(f"  ? {e['name']:14s} not in roster")
                drift = True
                continue
            b = blob(c)
            for chg in e["changes"]:
                to = chg["to"]
                if chg["field"] == "Mana":
                    m = c.get("mana") or {}
                    ours = f"{m.get('start')}/{m.get('max')}"
                    tag = "MATCH" if ours == to else "DRIFT"
                    drift |= tag == "DRIFT"
                    print(f"  {tag} {e['name']:14s} Mana patch={to:12s} ours={ours}")
                    continue
                # Only slash-triples are directly greppable in our text.
                for n in re.findall(r"\d+(?:/\d+)+", to):
                    tag = "found" if n in b else "ABSENT"
                    drift |= tag == "ABSENT"
                    print(f"  {tag:6s} {e['name']:14s} {chg['field'][:26]:26s} {n}")
        for e in pn.get("traits", []):
            t = traits.get(e["name"])
            mark = "" if t else "  (trait not in data)"
            drift |= not t
            for chg in e["changes"]:
                print(f"  trait  {e['name']:14s} {chg['field'][:26]:26s} "
                      f"-> {chg['to']}{mark}")

    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
