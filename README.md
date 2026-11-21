[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun](https://make.fun/badge/entries/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun](https://make.fun/badge/reward/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban Solver

A push-optimal Sokoban solver for the [sokoban-solver-01-run-20261121 bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

Each level is a hallway with rooms off it, and a box pushed through a door into the hallway can never be pushed back — so a box never leaves its room, and the level is solved room by room, each room push-optimally. The pushes add up to the level's optimum.

- **Room decomposition:** cut the hallway row's squares a box can never leave (they reach no goal), and each remaining part holding a box is a room. The door is the room cell touching the hallway; the approach is the hallway square beside it, where the player stands to walk in.
- **Per room:** breadth-first search over pushes from the approach square. A state is its boxes plus the player's reachable region (named by its lowest square), so walking is free and only pushes cost.
- **Deadlock pruning:** a box on a square from which no push can ever reach a goal (found by pulling back from the goals), and a frozen 2×2 block of walls and boxes with a box off its goal.
- **Deterministic:** no clock, no randomness — the same input always writes the same bytes. A work budget (250,000 states per room), never the clock.

## Verification

- **Practice set: 1,000,000 (the maximum)** — all 5 instances solved at exactly P* pushes (13, 16, 29, 47, 60), in ~1.1 s for the whole set.
- **5 freshly generated sets (25 unseen instances): 1,000,000 on every set** — each instance at exactly P*, ~0.6–0.8 s per set.
- **Deterministic:** two runs write byte-identical outputs.
- The house baseline (plain A* over moves) scores 200,000 on the practice set; this solver scores 1,000,000.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` (XSB) and writes `/output/<id>/solution.txt` (LURD moves, upper-case pushes), creating each `/output/<id>/` itself.
