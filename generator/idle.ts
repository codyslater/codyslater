import type { Cell, Rect, World } from './types.js';
import {
  ACCENTS, FINGERS, FINGER_W, GRID_H, GRID_W, NAME_COLOR, PLATE, TEXT_ZONES, COLORS,
} from './layout.js';
import { mulberry32, randInt, type Rng } from './rng.js';
import { DENDRITE_COLOUR, type Recording } from './tissue.js';

// ---------------------------------------------------------------------------
// idle.ts — the board's idle life as PURE DATA: no canvas. A renderer paints what these return.
//
//   SPROUTS  thin tissue creeping onto the board at the connector (calm: a handful, short), the
//            same dendrite colour as the neurons'; three have a tip that breathes, and a recording
//            lifts the ones near its finger for a moment.
//   HEART    the CPU's centre block brightens in three steps in a lub-dub double beat.
//   LEDS     6-8 single cells beside real chips, each blinking on its own period.
//   BUS      a 2-cell bright bar sweeping each DIMM slot's contact column.
//   FAN      only the blade phase (`fanStepAt`); the renderer draws the blades.
//   PLATE    the name, on a small dot-matrix display module (owner, 2026-11-19).
//
// Everything is a pure function of t mod T; nothing keeps per-frame state. Every period divides 288.
// ---------------------------------------------------------------------------

export interface IdleCell { x: number; y: number; color: string }
export interface IdleSprout {
  /** the board cell the sprout is rooted beside (its first cell) */
  root: Cell;
  /** static cells `[0, base)`, then the breathing tip's cells (empty unless `period > 0`) */
  cells: Cell[];
  base: number;
  /** the tip's period in frames, 0 for a sprout with no tip */
  period: number;
  phase: number;
}
export interface IdleLed { x: number; y: number; color: string; period: number; phase: number }
/** `x` is the contact column, `y` the first row the bar can reach, `len` how many rows it travels. */
export interface IdleDimm { x: number; y: number; len: number; period: number; phase: number }
export interface Idle {
  /** painted into the static board: the sprouts at rest and the LEDs off */
  staticCells: IdleCell[];
  sprouts: IdleSprout[];
  leds: IdleLed[];
  dimms: IdleDimm[];
  /** the CPU's centre block the heartbeat lights */
  heart: Rect;
  recordings: { frame: number; finger: number }[];
  /** every period this layer runs on, all dividing 288 */
  periods: number[];
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const hexOf = (r: number, g: number, b: number): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** the accent at `a` on the board substrate (the same blend as render.mixOnBg, which this module does not import) */
function onBg(hex: string, a: number): string {
  const [r, g, b] = rgb(hex), [br, bg, bb] = rgb(COLORS.bg);
  const m = (c: number, d: number): number => Math.round(c * a + d * (1 - a));
  return hexOf(m(r, br), m(g, bg), m(b, bb));
}
const lift = (hex: string, k: number): string => {
  const [r, g, b] = rgb(hex);
  const up = (c: number): number => Math.round(c + (255 - c) * k);
  return hexOf(up(r), up(g), up(b));
};

// ---------------------------------------------------------------- colours
export const SPROUT_REST = DENDRITE_COLOUR;
/** one step brighter than a sprout at rest */
export const SPROUT_LIT = lift(DENDRITE_COLOUR, 0.4);
/** the heartbeat's fixed three-step gray-white ramp; the bus bar is its top step */
export const HEART_RAMP: readonly string[] = ['#5c5c5c', '#a4a4a4', '#f0f0f0'];
const BUS_BAR = HEART_RAMP[2];
/** LEDs wear the four accents that are not neural green (green is the tissue's and the name's). */
const LED_ACCENTS: readonly string[] = Object.values(ACCENTS).filter(a => a !== ACCENTS.neural);
const LED_DIM = 0.25;
/** EVERY colour this module's idle cells can emit (the plate has its own list): 2 + 3 + 4 + 4 = 13. */
export const IDLE_COLOURS: readonly string[] =
  [SPROUT_REST, SPROUT_LIT, ...HEART_RAMP, ...LED_ACCENTS, ...LED_ACCENTS.map(a => onBg(a, LED_DIM))];

// ---------------------------------------------------------------- geometry: what is bare substrate
const idx = (x: number, y: number): number => y * GRID_W + x;
const inGrid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;

/** Every cell the static board paints in ink (conservative: label and designator text boxes are padded). */
function inkMap(world: World): Uint8Array {
  const ink = new Uint8Array(GRID_W * GRID_H);
  const rect = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inGrid(x, y)) ink[idx(x, y)] = 1;
  };
  for (const c of world.components) rect(c.rect.x, c.rect.y, c.rect.w, c.rect.h);
  for (const n of world.nets) for (const c of n.cells) if (inGrid(c.x, c.y)) ink[idx(c.x, c.y)] = 1;
  for (const c of world.fabric) if (inGrid(c.x, c.y)) ink[idx(c.x, c.y)] = 1;
  for (const f of FINGERS) rect(f.x, f.y, FINGER_W, f.h);
  for (const z of TEXT_ZONES) rect(z.x, z.y, z.w, z.h);
  for (const f of world.dressing.features) {
    rect(f.rect.x - 1, f.rect.y - 1, f.rect.w + 2, f.rect.h + 2);
    // the designator is 8 px text hung just above the rect
    if (f.designator) rect(f.rect.x, f.rect.y - 3, 2 + Math.ceil(f.designator.length * 1.2), 3);
  }
  // a mount hole's rings reach 10 px (2.5 cells) from its cell's centre
  for (const h of world.mountHoles) rect(h.x - 3, h.y - 3, 7, 7);
  for (const s of world.sections) {
    if (s.outline !== false && s.rect.w > 0 && s.rect.h > 0) {
      rect(s.rect.x, s.rect.y, s.rect.w, 1); rect(s.rect.x, s.rect.y + s.rect.h - 1, s.rect.w, 1);
      rect(s.rect.x, s.rect.y, 1, s.rect.h); rect(s.rect.x + s.rect.w - 1, s.rect.y, 1, s.rect.h);
    }
    if (s.label) rect(s.rect.x + 1, s.rect.y - 3, 2 + Math.ceil(s.label.length * 1.2), 4);
  }
  // the board edge (2 px, cell 2) and the keep-out line (cell 4 / 225 / 75), padded
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++) if (x <= 4 || x >= 225 || y <= 4 || y >= 75) ink[idx(x, y)] = 1;
  return ink;
}

/** A cell is usable when it and its 8 neighbours are all free of ink. */
function clearMap(ink: Uint8Array): Uint8Array {
  const clear = new Uint8Array(GRID_W * GRID_H);
  for (let y = 1; y < GRID_H - 1; y++)
    for (let x = 1; x < GRID_W - 1; x++) {
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (ink[idx(x + dx, y + dy)]) { ok = 0; break; }
      clear[idx(x, y)] = ok;
    }
  return clear;
}

const DIRS8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ADJ4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SPROUT_X0 = 204, SPROUT_X1 = 226;
/** a sprout's recording reach, in cells from the finger */
const REACH = 10;
const LIFT_FRAMES = 6;
const TIP_PERIODS = [72, 96, 144];

/** Chebyshev distance from a cell to a rect (0 inside it). */
const distToRect = (c: Cell, r: Rect): number =>
  Math.max(r.x - c.x, 0, c.x - (r.x + r.w - 1), r.y - c.y, 0, c.y - (r.y + r.h - 1));
const fingerRect = (fi: number): Rect => ({ x: FINGERS[fi].x, y: FINGERS[fi].y, w: FINGER_W, h: FINGERS[fi].h });

function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- sprouts
function buildSprouts(rng: Rng, clear: Uint8Array): IdleSprout[] {
  const usable = (x: number, y: number): boolean =>
    inGrid(x, y) && x >= SPROUT_X0 && x <= SPROUT_X1 && clear[idx(x, y)] === 1;
  // rooted next to a gold finger or the board rim
  const rooted = (x: number, y: number): boolean =>
    FINGERS.some((_, fi) => distToRect({ x, y }, fingerRect(fi)) <= 8) || x >= 218 || y <= 9 || y >= 70;
  const roots: Cell[] = [];
  for (let y = 0; y < GRID_H; y++)
    for (let x = SPROUT_X0; x <= SPROUT_X1; x++) if (usable(x, y) && rooted(x, y)) roots.push({ x, y });
  shuffle(rng, roots);

  const owner = new Map<number, number>();
  const target = randInt(rng, 8, 12);
  interface Grown { root: Cell; path: Cell[]; base: number }
  const grown: Grown[] = [];

  const tryGrow = (root: Cell, want: number, id: number): Cell[] => {
    const own = new Set<number>();
    const path: Cell[] = [];
    const room = (x: number, y: number, prev?: Cell): boolean => {
      if (!usable(x, y) || own.has(idx(x, y))) return false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const o = owner.get(idx(x + dx, y + dy));
        if (o !== undefined && o !== id) return false;
      }
      // thin: not 4-touching its own body, except the cell it grows from
      for (const [dx, dy] of ADJ4) {
        if (prev && prev.x === x + dx && prev.y === y + dy) continue;
        if (own.has(idx(x + dx, y + dy))) return false;
      }
      return true;
    };
    if (!room(root.x, root.y)) return [];
    path.push(root); own.add(idx(root.x, root.y));
    let dir = 4 + randInt(rng, -1, 1);               // creeping west, onto the board
    while (path.length < want) {
      const cur = path[path.length - 1];
      const opts: { d: number; w: number }[] = [];
      for (const rot of [0, 1, -1, 2, -2]) {
        const d = mod(dir + rot, 8), [dx, dy] = DIRS8[d];
        if (!room(cur.x + dx, cur.y + dy, cur)) continue;
        opts.push({ d, w: (rot === 0 ? 3 : Math.abs(rot) === 1 ? 2.2 : 0.6) * (dx < 0 ? 1.4 : dx > 0 ? 0.5 : 1) });
      }
      if (!opts.length) break;
      let r = rng() * opts.reduce((s, o) => s + o.w, 0), choice = opts[0];
      for (const o of opts) { r -= o.w; if (r <= 0) { choice = o; break; } }
      dir = choice.d;
      path.push({ x: cur.x + DIRS8[dir][0], y: cur.y + DIRS8[dir][1] });
      own.add(idx(path[path.length - 1].x, path[path.length - 1].y));
    }
    return path;
  };

  // denser toward the board's right edge: a root's chance climbs with x
  for (let pass = 0; pass < 3 && grown.length < target; pass++)
    for (const root of roots) {
      if (grown.length >= target) break;
      if (owner.has(idx(root.x, root.y))) continue;
      const dens = pass === 2 ? 1 : (0.1 + 0.9 * ((root.x - SPROUT_X0) / (SPROUT_X1 - SPROUT_X0)) ** 1.5) * (pass === 0 ? 0.5 : 1);
      if (rng() > dens) continue;
      // keep roots apart so the growth reads as a few separate sprouts, not one mat
      if (grown.some(g => g.path.some(c => Math.max(Math.abs(c.x - root.x), Math.abs(c.y - root.y)) < 3))) continue;
      const base = randInt(rng, 3, 8);
      const id = grown.length;
      const path = tryGrow(root, base + 3, id);          // room for a tip, trimmed below if it goes unused
      if (path.length < 3) continue;
      for (const c of path) owner.set(idx(c.x, c.y), id);
      grown.push({ root, path, base: Math.min(base, path.length) });
    }

  // the first three sprouts that grew at least two cells past their base get a breathing tip
  const out: IdleSprout[] = [];
  let tips = 0;
  for (const g of grown) {
    const extra = g.path.length - g.base;
    if (tips < 3 && extra >= 2) {
      const period = TIP_PERIODS[tips++];
      out.push({ root: g.root, cells: g.path.slice(0, g.base + Math.min(extra, 3)), base: g.base, period, phase: randInt(rng, 0, period - 1) });
    } else out.push({ root: g.root, cells: g.path.slice(0, g.base), base: g.base, period: 0, phase: 0 });
  }
  return out;
}

// ---------------------------------------------------------------- LEDs
const LED_PERIODS = [12, 16, 24, 36, 48, 72, 96, 144];
const LED_NEAR = new Set(['qfp', 'dipIC', 'header', 'pcieSlot', 'coinCell', 'choke', 'cpuSocket', 'heatsink', 'capBig', 'crystal']);

function buildLeds(rng: Rng, world: World, clear: Uint8Array): IdleLed[] {
  const chips = world.components.filter(c => LED_NEAR.has(c.kind));
  const near = (x: number, y: number): boolean => chips.some(c => distToRect({ x, y }, c.rect) <= 5);
  const cand: Cell[] = [];
  for (let y = 6; y < 66; y++)
    for (let x = 8; x < SPROUT_X0; x++) if (clear[idx(x, y)] && near(x, y)) cand.push({ x, y });
  shuffle(rng, cand);
  const accents = world.accents.filter(a => LED_ACCENTS.includes(a));
  const leds: IdleLed[] = [];
  for (const sep of [24, 18, 14, 10, 6]) {
    for (const c of cand) {
      if (leds.length >= 8) break;
      if (leds.some(l => Math.max(Math.abs(l.x - c.x), Math.abs(l.y - c.y)) < sep)) continue;
      const i = leds.length, period = LED_PERIODS[i % LED_PERIODS.length];
      leds.push({ x: c.x, y: c.y, color: accents[i % accents.length], period, phase: randInt(rng, 0, period - 1) });
    }
    if (leds.length >= 8) break;
  }
  return leds;
}

// ---------------------------------------------------------------- the build
const BEAT_PERIOD = 24;
/** the lub-dub, level 0..3 per frame of the beat */
const BEAT = [1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const FAN_PERIOD = 12;
const DIMM_PERIODS = [36, 48, 72, 96];

export function buildIdle(world: World, recordings: readonly Recording[]): Idle {
  const rng = mulberry32(world.seed ^ 0x1d1e);
  const clear = clearMap(inkMap(world));

  const sprouts = buildSprouts(rng, clear);
  const leds = buildLeds(rng, world, clear);

  const dimms: IdleDimm[] = world.components.filter(c => c.kind === 'dimmSlot').map((c, i) => {
    const period = DIMM_PERIODS[i % DIMM_PERIODS.length];
    return { x: c.body.x + 1, y: c.body.y + 2, len: c.body.h - 4, period, phase: randInt(rng, 0, period - 1) };
  });

  const cpu = world.components.find(c => c.kind === 'cpuSocket');
  const heart: Rect = cpu
    ? { x: cpu.body.x + Math.floor((cpu.body.w - 6) / 2), y: cpu.body.y + Math.floor((cpu.body.h - 5) / 2), w: 6, h: 5 }
    : { x: 0, y: 0, w: 0, h: 0 };

  const staticCells: IdleCell[] = [];
  for (const s of sprouts) for (const c of s.cells.slice(0, s.base)) staticCells.push({ x: c.x, y: c.y, color: SPROUT_REST });
  for (const l of leds) staticCells.push({ x: l.x, y: l.y, color: onBg(l.color, LED_DIM) });

  const periods = [BEAT_PERIOD, FAN_PERIOD, ...sprouts.filter(s => s.period).map(s => s.period),
    ...dimms.map(d => d.period), ...leds.map(l => l.period)];
  return {
    staticCells, sprouts, leds, dimms, heart,
    recordings: recordings.map(r => ({ frame: r.frame, finger: r.finger })),
    periods,
  };
}

/** The fan's blade phase, 0..3, advancing every 3 frames (period 12). */
export function fanStepAt(t: number): number {
  return Math.floor(mod(Math.floor(t), FAN_PERIOD) / 3);
}

/** What differs from the static idle cells at frame t (a pure function of t mod T). Each cell at most once. */
export function idleCellsAt(idle: Idle, t: number, T: number): IdleCell[] {
  const f = mod(Math.round(t), T);
  const out: IdleCell[] = [];

  // sprouts: lifted for LIFT_FRAMES after a recording on a finger within REACH; tips breathe
  for (const s of idle.sprouts) {
    const lifted = idle.recordings.some(r =>
      mod(f - r.frame, T) < LIFT_FRAMES && distToRect(s.root, fingerRect(r.finger)) <= REACH);
    const color = lifted ? SPROUT_LIT : SPROUT_REST;
    if (lifted) for (const c of s.cells.slice(0, s.base)) out.push({ x: c.x, y: c.y, color });
    if (s.period) {
      const tri = 1 - Math.abs(2 * (mod(f + s.phase, s.period) / s.period) - 1);
      const n = Math.round((s.cells.length - s.base) * tri);
      for (const c of s.cells.slice(s.base, s.base + n)) out.push({ x: c.x, y: c.y, color });
    }
  }

  // the heartbeat: concentric, brightest at the core
  const lv = BEAT[mod(f, BEAT_PERIOD)];
  if (lv > 0 && idle.heart.w > 0) {
    const { x, y, w, h } = idle.heart;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const depth = Math.min(i, j, w - 1 - i, h - 1 - j);
        out.push({ x: x + i, y: y + j, color: HEART_RAMP[Math.min(lv, depth + 1) - 1] });
      }
  }

  // memory bus
  for (const d of idle.dimms) {
    const pos = Math.floor((mod(f + d.phase, d.period) / d.period) * (d.len + 2)) - 1;
    for (let k = 0; k < 2; k++) {
      const row = pos + k;
      if (row >= 0 && row < d.len) out.push({ x: d.x, y: d.y + row, color: BUS_BAR });
    }
  }

  // LEDs: on for the first half of their period
  for (const l of idle.leds) if (mod(f + l.phase, l.period) < l.period / 2) out.push({ x: l.x, y: l.y, color: l.color });
  return out;
}

// ---------------------------------------------------------------------------
// The name plate (owner, 2026-11-19: "i liked it on a plate too but not as big as the last one you
// showed"). A dot-matrix display module on the board: ONE dot = ONE cell, 5x7 glyphs, a 6-cell pitch.
// ---------------------------------------------------------------------------

const PLATE_BODY = '#111111', PLATE_BEZEL = '#2a2a2a', PLATE_PIN = '#888888', PLATE_UNLIT = '#0e1a0e';
export const PLATE_COLOURS: readonly string[] = [PLATE_BODY, PLATE_BEZEL, PLATE_PIN, PLATE_UNLIT, NAME_COLOR];

const PLATE_TEXT = 'cody_slater';
/** the 66 x 7 dot area sits inside the bezel and one cell of padding; the 65-column text starts at its left */
const DOT_X = PLATE.x + 2, DOT_Y = PLATE.y + 2, DOT_COLS = PLATE.w - 4, DOT_ROWS = PLATE.h - 4;
const PITCH = 6;
/** the classic 5x7 dot font (the GLCD table): five column bytes per glyph, bit 0 the top row */
const GLYPHS: Record<string, readonly number[]> = {
  c: [0x38, 0x44, 0x44, 0x44, 0x20],
  o: [0x38, 0x44, 0x44, 0x44, 0x38],
  d: [0x38, 0x44, 0x44, 0x48, 0x7f],
  y: [0x0c, 0x50, 0x50, 0x50, 0x3c],
  _: [0x40, 0x40, 0x40, 0x40, 0x40],
  s: [0x48, 0x54, 0x54, 0x54, 0x24],
  l: [0x00, 0x41, 0x7f, 0x40, 0x00],
  a: [0x20, 0x54, 0x54, 0x54, 0x78],
  t: [0x04, 0x3f, 0x44, 0x40, 0x20],
  e: [0x38, 0x54, 0x54, 0x54, 0x18],
  r: [0x7c, 0x08, 0x04, 0x04, 0x08],
};
/** frames: lit through 203, cleared 204..206, retyped one character per 3 frames from 207, steady from 240 */
const CLEAR_AT = 204, TYPE_AT = 207, TYPE_STEP = 3, STEADY_AT = 240;

const glyphLit = (col: number, row: number): boolean => {
  const ci = Math.floor(col / PITCH), c = col % PITCH;
  return ci < PLATE_TEXT.length && c < 5 && ((GLYPHS[PLATE_TEXT[ci]][c] >> row) & 1) === 1;
};

/** Body, bezel, pins and every dot in its steady state (the full name lit). */
export function plateStaticCells(): IdleCell[] {
  const out: IdleCell[] = [];
  for (let j = 0; j < PLATE.h; j++)
    for (let i = 0; i < PLATE.w; i++) {
      const edgeX = i === 0 || i === PLATE.w - 1, edgeY = j === 0 || j === PLATE.h - 1;
      let color: string;
      if (edgeX && edgeY) color = PLATE_PIN;
      else if (edgeX || edgeY) color = PLATE_BEZEL;
      else if (i === 1 || i === PLATE.w - 2 || j === 1 || j === PLATE.h - 2) color = PLATE_BODY;
      else color = glyphLit(i - 2, j - 2) ? NAME_COLOR : PLATE_UNLIT;
      out.push({ x: PLATE.x + i, y: PLATE.y + j, color });
    }
  return out;
}

/** Only the dots that differ from the steady state: empty outside frames 204..239. */
export function plateCellsAt(t: number, T: number): IdleCell[] {
  const f = mod(Math.round(t), T);
  if (f < CLEAR_AT || f >= STEADY_AT) return [];
  const shown = f < TYPE_AT ? 0 : Math.min(PLATE_TEXT.length, Math.floor((f - TYPE_AT) / TYPE_STEP) + 1);
  const cursor = f >= TYPE_AT && shown < PLATE_TEXT.length ? shown : -1;
  const out: IdleCell[] = [];
  for (let row = 0; row < DOT_ROWS; row++)
    for (let col = 0; col < DOT_COLS; col++) {
      const ci = Math.floor(col / PITCH), c = col % PITCH;
      const on = (ci < shown && glyphLit(col, row)) || (ci === cursor && c < 5);
      if (on !== glyphLit(col, row)) out.push({ x: DOT_X + col, y: DOT_Y + row, color: on ? NAME_COLOR : PLATE_UNLIT });
    }
  return out;
}
