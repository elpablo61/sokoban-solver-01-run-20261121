// Sokoban solver: each level is a hallway with rooms off it, and a box never leaves
// its room, so the level is solved room by room, each room push-optimally, and the
// pushes add up to the level's optimum. A room is searched breadth-first over
// pushes: a state is its boxes plus the player's reachable region (named by its
// lowest square), so walking is free and only pushes cost. Two deadlocks are
// pruned: a box on a square from which no push can ever reach a goal, and a
// frozen 2 x 2 block of walls and boxes with a box off its goal. No clock, no
// randomness: the same input always writes the same bytes.
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// The most states one room's search keeps: a work budget, never the clock.
const MAX_STATES = 250_000;

type Dir = { dx: number; dy: number; walk: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
};

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, goalSet: setOf(w * h, goals), boxes: boxes.sort((a, b) => a - b), player };
}

function setOf(size: number, cells: number[]): Uint8Array {
  const s = new Uint8Array(size);
  for (const c of cells) s[c] = 1;
  return s;
}

/** The squares a box can be pushed from onto some goal, found by pulling back from the goals. */
function liveSquares(w: number, h: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(w * h);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cell = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const from = cell - step;
      const behind = from - step;
      if (from < 0 || from >= w * h || behind < 0 || behind >= w * h) continue;
      if (!wall[from] && !wall[behind] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/** The shortest walk from `from` to `to` around walls and boxes, as lower-case LURD, or '' when already there. */
function shortestWalk(w: number, h: number, wall: Uint8Array, blocked: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const how: string[] = new Array(w * h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (q < 0 || q >= w * h || wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Apply a move string to a (boxes, player) pair on a board; returns the new boxes and player. */
function applyMoves(w: number, wall: Uint8Array, boxes: number[], player: number, moves: string): { boxes: number[]; player: number } {
  const boxAt = new Map<number, number>();
  boxes.forEach((b, i) => boxAt.set(b, i));
  const next = boxes.slice();
  let p = player;
  for (const ch of moves) {
    const d = DIRS.find((x) => x.walk === ch.toLowerCase());
    if (!d) continue;
    const step = d.dy * w + d.dx;
    const q = p + step;
    if (wall[q]) continue;
    const bi = boxAt.get(q);
    if (bi !== undefined) {
      const beyond = q + step;
      if (wall[beyond] || boxAt.has(beyond)) continue;
      boxAt.delete(q);
      boxAt.set(beyond, bi);
      next[bi] = beyond;
    }
    p = q;
  }
  return { boxes: next.sort((a, b) => a - b), player: p };
}

type Room = {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;
  approach: number;
};

/**
 * Split a level into its rooms: cut the hallway row's squares a box can never
 * leave (they reach no goal), and each remaining part holding a box is a room.
 * The door is the room cell touching the hallway; the approach is the hallway
 * square beside it, where the player stands to walk in.
 */
function findRooms(b: Board, live: Uint8Array): Room[] | null {
  const { w, h, wall, goals, boxes, player } = b;
  const hallRow = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = hallRow * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((box) => cut[box])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (const d of DIRS) {
        const q = cells[i] + d.dy * w + d.dx;
        if (q < 0 || q >= w * h || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        cells.push(q);
      }
    }
    rooms.push({ cells, boxes: [], goals: [], door: -1, approach: -1 });
  }
  for (const box of boxes) {
    const c = part[box];
    if (c >= 0) rooms[c].boxes.push(box);
  }
  for (const g of goals) {
    const c = part[g];
    if (c >= 0) rooms[c].goals.push(g);
  }
  if (goals.some((g) => part[g] < 0)) return null;
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  if (withBoxes.some((r) => r.boxes.length !== r.goals.length)) return null;
  for (const r of withBoxes) {
    for (const cell of r.cells) {
      const y = Math.floor(cell / w);
      if (Math.abs(y - hallRow) !== 1) continue;
      const approach = hallRow * w + (cell % w);
      if (!wall[approach]) {
        r.door = cell;
        r.approach = approach;
        break;
      }
    }
    if (r.door < 0) return null;
  }
  return withBoxes;
}

/**
 * One room, push-optimally: breadth-first over pushes from the approach square.
 * Returns the moves (lower-case walks, upper-case pushes) and their push count.
 */
function solveRoom(
  w: number,
  h: number,
  wall: Uint8Array,
  goalSet: Uint8Array,
  startBoxes: number[],
  startPlayer: number,
): { pushes: number; moves: string } | null {
  const size = w * h;
  const goals: number[] = [];
  for (let i = 0; i < size; i++) if (goalSet[i]) goals.push(i);
  const live = liveSquares(w, h, wall, goals);
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b] === 1);
  if (startBoxes.some((b) => !live[b])) return null;
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // Scratch arrays for the flood fills: `seen` holds the current state's region,
  // `mark` the candidate's, so one never overwrites the other. No reallocation.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let seenStamp = 0;
  let markStamp = 0;
  const blocked = new Uint8Array(size);
  /** Flood from `from` around walls and `blocked` into `into` with `stamp`; returns the region's lowest square. */
  const floodInto = (into: Int32Array, stamp: number, from: number): number => {
    let low = from;
    let n = 0;
    stack[n++] = from;
    into[from] = stamp;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      const x = p % w;
      const y = Math.floor(p / w);
      if (y > 0) {
        const q = p - w;
        if (!wall[q] && !blocked[q] && into[q] !== stamp) {
          into[q] = stamp;
          stack[n++] = q;
        }
      }
      if (y < h - 1) {
        const q = p + w;
        if (!wall[q] && !blocked[q] && into[q] !== stamp) {
          into[q] = stamp;
          stack[n++] = q;
        }
      }
      if (x > 0) {
        const q = p - 1;
        if (!wall[q] && !blocked[q] && into[q] !== stamp) {
          into[q] = stamp;
          stack[n++] = q;
        }
      }
      if (x < w - 1) {
        const q = p + 1;
        if (!wall[q] && !blocked[q] && into[q] !== stamp) {
          into[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  };
  /** Whether the box just pushed to `t` sits in a frozen 2 x 2 block with a box off its goal. */
  const frozenBlock = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      const filled = (i: number): boolean => i >= 0 && i < size && (wall[i] === 1 || blocked[i] === 1);
      if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
      const offGoal = (i: number): boolean => blocked[i] === 1 && goalSet[i] !== 1;
      if (offGoal(a) || offGoal(b) || offGoal(c) || offGoal(d)) return true;
    }
    return false;
  };

  const keyOf = (bs: number[], low: number): string => bs.join(',') + '|' + low;
  const boxes0 = startBoxes.slice().sort((a, b) => a - b);
  for (const b of boxes0) blocked[b] = 1;
  const low0 = floodInto(seen, ++seenStamp, startPlayer);
  for (const b of boxes0) blocked[b] = 0;
  // The states in the order found: boxes, the player's square after the push that made it, parent, and the push.
  const sBoxes: number[][] = [boxes0];
  const sPlayer: number[] = [startPlayer];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const index = new Map<string, number>([[keyOf(boxes0, low0), 0]]);
  let found = -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head];
    for (const b of boxes) blocked[b] = 1;
    const here = ++seenStamp;
    floodInto(seen, here, sPlayer[head]);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di];
        const step = d.dy * w + d.dx;
        const dest = b + step;
        const behind = b - step;
        if (behind < 0 || behind >= size || dest < 0 || dest >= size) continue;
        if (seen[behind] !== here) continue;
        if (wall[dest] || blocked[dest] || !live[dest]) continue;
        blocked[b] = 0;
        blocked[dest] = 1;
        const frozen = frozenBlock(dest);
        let key = '';
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = dest;
          next.sort((a, b) => a - b);
          key = keyOf(next, floodInto(mark, ++markStamp, b));
        }
        blocked[dest] = 0;
        blocked[b] = 1;
        if (frozen || next === null || index.has(key)) continue;
        if (sBoxes.length >= MAX_STATES) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(head);
        sFrom.push(b);
        sTo.push(dest);
        sDir.push(di);
        if (solved(next)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;
  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = boxes0;
  for (const s of path) {
    const from = sFrom[s];
    const to = sTo[s];
    const d = DIRS[sDir[s]];
    const step = d.dy * w + d.dx;
    for (const b of boxes) blocked[b] = 1;
    const walk = shortestWalk(w, h, wall, blocked, player, from - step);
    for (const b of boxes) blocked[b] = 0;
    if (walk === null) return null;
    moves += walk + d.push;
    const next = boxes.slice();
    next[next.indexOf(from)] = to;
    next.sort((a, b) => a - b);
    boxes = next;
    player = from;
  }
  return { pushes: path.length, moves };
}

/** Solve one level's text into its move string, or '' when it gives up. */
function solve(text: string): string {
  const b = parseLevel(text);
  const live = liveSquares(b.w, b.h, b.wall, b.goals);
  const rooms = findRooms(b, live);
  if (rooms === null || rooms.length === 0) return '';
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const room of rooms) {
    // Walk to the room's approach square in the level as it stands.
    const blocked = setOf(b.w * b.h, boxes);
    const walk = shortestWalk(b.w, b.h, b.wall, blocked, player, room.approach);
    if (walk === null) return '';
    moves += walk;
    player = room.approach;
    // The room alone: its cells plus the approach square walkable, the rest wall.
    const roomWall = new Uint8Array(b.w * b.h).fill(1);
    for (const c of room.cells) roomWall[c] = 0;
    roomWall[room.approach] = 0;
    const roomGoalSet = setOf(b.w * b.h, room.goals);
    const solved = solveRoom(b.w, b.h, roomWall, roomGoalSet, room.boxes, room.approach);
    if (solved === null) return '';
    moves += solved.moves;
    const updated = applyMoves(b.w, b.wall, boxes, player, solved.moves);
    boxes = updated.boxes;
    player = updated.player;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
