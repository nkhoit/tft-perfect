# Trait Explorer Search Strategy

## Product goal

The opt-in local engine is an anytime sampler for finding good complete boards,
especially at board sizes 10–12. It does not enumerate the search space, prove
optimality, or use the MILP solver. The existing `milp-hybrid-v8` behavior remains
the default; the implementation revision is versioned `milp-hybrid-v9` so result
caches and static assets cannot mix.

The result contract is deliberately narrow:

- every emitted board obeys all hard query constraints;
- final ranking uses the existing exact `SearchUtils.comparator`;
- scoring uses `BoardScore` rather than a second scoring implementation;
- the archive contains distinct exact trait-count signatures;
- results are always described as an experimental sample, never exhaustive or
  optimal.

## State and exact semantics

A search state is a complete unordered roster of champion indexes. Required units
are locked. Optional units come only from the allowed pool. The roster has no duplicate champion or mutually exclusive form, contains no more
champions than its maximum reachable slot capacity, and uses exactly:

```text
base board size + reachable capacity-trait slots
```

`BoardScore.rosterCounts`, `unlockedBonus`, and `scoreRoster` are authoritative for
emblems, weighted trait points, muted traits, unique traits, waste, cost, multi-slot
champions, and capacity unlock order. Required trait counts and maximum waste are
checked before archive insertion. Exploration may retain a complete structural
board that misses those two filters so it can cross a score valley, but such a
board is never returned.

## Algorithm

`web/traits/local-search.js` combines a stochastic local beam with annealed
mutation:

1. A seeded Mulberry32 PRNG makes construction and mutation reproducible.
2. Randomized constructive DFS starts from locked required units and fills a legal
   complete board. Candidate ordering favors trait-bearing and required-trait
   units.
3. A small beam retains strong rosters while reserving space for distinct trait
   signatures.
4. Each generation performs one-unit, two-unit, or occasional three-unit
   ruin/recreate moves. Removing and refilling naturally handles a two-slot unit
   being exchanged for two one-slot units.
5. Some constructors continue past an already complete base-size board. This
   crosses the temporary over-capacity valley needed to activate a capacity trait
   and produce a larger complete board.
6. Worse moves can survive according to a cooling temperature. Query violations
   receive a large smooth penalty; exact result ordering remains authoritative for
   beam and archive ranking.
7. Every eighth generation adds a fresh constructive restart.

The archive is keyed by `SearchUtils.traitSignature`, including inactive trait
counts. It keeps the best representative under the exact comparator and up to 24
roster variants. It is bounded and merged across workers with the existing
`mergeSearchResults`.

Search normally stops at its wall-clock deadline. Tests can supply
`maxIterations` with a fixed seed for deterministic candidate lists. Both limits
are checked; deterministic mode is intended for fixtures, not a claim that timed
runs are byte-for-byte identical across machines.

## Feasibility details

- **Allowed pool:** construction can add only `poolIdx`; required units are allowed
  independently and can never be removed.
- **Required units/forms:** invalid indexes, duplicates, mutually exclusive locked
  forms, and impossible required slot counts fail before sampling.
- **Required traits:** emblem and champion points are read from the exact score
  signature and checked at archive insertion.
- **Emblems and muted traits:** passed unchanged to `BoardScore`; muted points
  remain visible but count toward neither live traits nor waste.
- **Maximum waste:** hard for emitted results, soft during movement.
- **Multi-slot champions:** construction tracks slot cost, and ruin/recreate can
  change roster cardinality.
- **Capacity traits:** a roster is complete only when its used slots equal the
  bonus reachable in `BoardScore.unlockedBonus`; a bonus cannot bootstrap itself.
- **Final validation:** unit tests also pass returned fixtures through
  `BoardScore.validateRoster`.

## Worker and UI flow

`local-worker.js` uses the same `init` / `search` / partial `result` / final
`result` protocol as the DFS worker. Workers receive deterministic shard-derived
seeds and independently contribute signature archives.

The header toggle **Try new experience** is stored in local storage. Switching it
reruns the current query. Search options contain `engine: "local"` or
`engine: "hybrid"`; that field is part of the memory and IndexedDB cache key.

In local mode:

- only `local-worker.js` instances are created for the main search;
- neither `worker.js` nor `solver-worker.js` receives a search;
- MILP-backed upgrade searches are disabled;
- Deep receives a finite 10-second deadline;
- status and result count display “experimental sample” / “sampled”.

Turning the toggle off restores the unchanged DFS + MILP scheduler flow.

## 500 ms comparison

Run:

```bash
npm run benchmark:local-search
npm run benchmark:local-search -- --json
```

The script runs three fixed seeds. Each seed deterministically chooses three
non-unique emblems, then runs a size-10, maximum-waste-10 search sorted by live
traits first and rich board second. Local search and one existing DFS shard each
receive an explicit 500 ms deadline. The script asserts both actually stop for
time and finish within a narrow tolerance, then emits live traits, gold, waste,
unit keys, emblems, elapsed time, evaluations, and seed.

One reference run on 2026-08-06:

| seed | emblems | engine | live | gold | waste | elapsed |
|---:|---|---|---:|---:|---:|---:|
| 1801 | Elderwood, Spellweaver, Lunar | local | 12 | 81 | 6 | 504 ms |
| 1801 | Elderwood, Spellweaver, Lunar | DFS | 9 | 96 | 5 | 502 ms |
| 1818 | Juggernaut, Ravager, Hunter | local | 12 | 84 | 8 | 503 ms |
| 1818 | Juggernaut, Ravager, Hunter | DFS | 9 | 105 | 3 | 501 ms |
| 1842 | Blackthorn, Inferno, Fae | local | 12 | 93 | 8 | 503 ms |
| 1842 | Blackthorn, Inferno, Fae | DFS | 10 | 99 | 2 | 501 ms |

Wall-clock search is intentionally hardware-sensitive. Fixed cases and seeds make
inputs and stochastic choices reproducible, while JSON output makes repeated runs
easy to retain and compare. Gold is the existing 2-star board cost.

## Limitations

- A timed stochastic run can return a different tail as CPU speed changes.
- Construction scores complete intermediate rosters instead of maintaining
  incremental trait deltas. This keeps semantics simple but leaves throughput on
  the table.
- Beam fitness is a search heuristic; only the exact comparator determines output.
- Independent workers do not exchange elites while running. Their archives merge
  only on the main thread.
- Hardly constrained queries can spend substantial time constructing boards that
  fail required traits or waste.

## Future work

Measure incremental score updates against the exact scorer, add trait-directed
repair for restrictive requirements, exchange worker elites, adapt operator
weights from successful moves, and track time-to-best/signature diversity over a
larger fixed fixture suite. Any proof or exhaustive claim must continue to come
from an exact engine, not this sampler.
