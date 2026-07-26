/**
 * proto-portrait.ts — THROWAWAY aesthetic-calibration prototype (Task 1).
 *
 * Renders ONE static full-board portrait (1200x320 PNG) so Cody can pick a
 * visual direction by eye. Not production code: no tests, no determinism
 * audit, no reuse contract. It hand-rolls its own placement + routing and
 * deliberately forks the render logic in generator/render.ts.
 *
 *   npx tsx generator/proto-portrait.ts --variant A|B|C --seed N --out path.png
 *
 * Variants:
 *   A — iconic motherboard: recognizable anatomy (CPU socket, DIMM bank, VRM
 *       choke row, chipset heatsink, coin cell, cap clusters, PCIe slots)
 *       drawn as chunky sprites, wired with parallel bus bundles.
 *   B — abstract but chunkier: today's anonymous-component language scaled up
 *       (hubs 6x8, passives 3x3, 2-cell trunks -> 1-cell branches, denser
 *       dressing, silkscreen section boxes).
 *   C — current-look baseline: production geometry (3x5 pads, 5x7 hubs, 2x2
 *       passives, 1-cell traces) for honest comparison.
 *
 * Palette discipline is binding everywhere: only spec-sanctioned colors, all
 * simulation art on integer 4px cells with hard edges, only text antialiased.
 */

import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGif } from './gif.js';
import { registerFonts } from './fonts.js';
import { mulberry32, pick, randInt, type Rng } from './rng.js';
import {
  ACCENTS, BOARD, BOARD_EDGE, BOARD_KEEPOUT, BOARD_RIGHT, CELL, COLORS, CREDENTIALS,
  DRESSING_COLORS, FINGER_W, FINGERS, GOLD, GOLD_LIT, GRID_H, GRID_W, HEIGHT, NAME,
  NAME_ZONE, REV_ZONE, THESIS, THESIS_FONT_PX, THESIS_ZONE, TEXT_ZONES, VOID_BG, WIDTH,
  revFromSeed,
} from './layout.js';

// ---------------------------------------------------------------------------
// Palette (strict). Every color drawn by this file comes from here.
// ---------------------------------------------------------------------------
export const P = {
  bg: COLORS.bg,             // #0a0a0a  board substrate
  grid: COLORS.grid,         // #111111  fiberglass grid / recessed interiors
  surface: COLORS.surface,   // #1a1a1a  dim body / silkscreen box
  edge: COLORS.edge,         // #222222  component body (populated), outlines
  dim: COLORS.dim,           // #444444  metal: pins, frames, contacts
  muted: COLORS.muted,       // #888888  bright metal: cans, heat spreaders, silkscreen text
  offwhite: COLORS.offwhite, // #f0f0f0  creature eyes
  white: COLORS.white,       // #ffffff  cursor, pulse head
  void: VOID_BG,             // #060606
  gold: GOLD, goldLit: GOLD_LIT,
} as const;

export const ACCENT_LIST = [ACCENTS.rna, ACCENTS.neural, ACCENTS.synbio, ACCENTS.om, ACCENTS.ai];

export function mixOnBg(hex: string, alpha: number, bgHex = P.bg): string {
  const n = parseInt(hex.slice(1), 16), b = parseInt(bgHex.slice(1), 16);
  const m = (c: number, d: number) => Math.round(c * alpha + d * (1 - alpha));
  const r = m(n >> 16, b >> 16), g = m((n >> 8) & 255, (b >> 8) & 255), bl = m(n & 255, b & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Cell-grid drawing primitives — everything lands on integer 4px cells.
// ---------------------------------------------------------------------------
export type Ctx = SKRSContext2D;
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const px = (c: number) => c * CELL;

export function cell(ctx: Ctx, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), CELL, CELL);
}
export function box(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), px(w), px(h));
}
/** t-cell-thick border drawn as four fills — hard cell edges, no sub-pixel stroke. */
export function frame(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, t = 1): void {
  box(ctx, x, y, w, t, color);
  box(ctx, x, y + h - t, w, t, color);
  box(ctx, x, y + t, t, h - 2 * t, color);
  box(ctx, x + w - t, y + t, t, h - 2 * t, color);
}
/** 1px hairline outline (the production `strokeRect` look) — used by variant C only. */
function hairline(ctx: Ctx, r: Rect, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(px(r.x) + 0.5, px(r.y) + 0.5, px(r.w) - 1, px(r.h) - 1);
}
export function silkText(ctx: Ctx, text: string, x: number, y: number, sizePx: number, color: string): void {
  ctx.font = `${sizePx}px "JetBrains Mono"`;
  ctx.fillStyle = color;
  ctx.fillText(text, px(x), px(y));
}

// ---------------------------------------------------------------------------
// Occupancy grid + PCB-style router (Dijkstra with a turn penalty -> long
// committed straight runs and clean corners; 45 degree chamfers applied after).
// ---------------------------------------------------------------------------
class Occ {
  private b = new Uint8Array(GRID_W * GRID_H);
  blockedAt(x: number, y: number): boolean {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return true;
    return this.b[y * GRID_W + x] === 1;
  }
  block(x: number, y: number): void {
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) this.b[y * GRID_W + x] = 1;
  }
  blockRect(r: Rect, pad = 0): void {
    for (let y = r.y - pad; y < r.y + r.h + pad; y++)
      for (let x = r.x - pad; x < r.x + r.w + pad; x++) this.block(x, y);
  }
  unblockRect(r: Rect, pad = 0): void {
    for (let y = r.y - pad; y < r.y + r.h + pad; y++)
      for (let x = r.x - pad; x < r.x + r.w + pad; x++)
        if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) this.b[y * GRID_W + x] = 0;
  }
  /** Is the `brush`x`brush` footprint anchored at (x,y) entirely free? */
  brushFree(x: number, y: number, brush: number): boolean {
    for (let dy = 0; dy < brush; dy++)
      for (let dx = 0; dx < brush; dx++) if (this.blockedAt(x + dx, y + dy)) return false;
    return true;
  }
}

const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/** Binary min-heap over `cost * 1e6 + state` packed into plain numbers. */
class Heap {
  private a: number[] = [];
  push(v: number): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length === 0) return top;
    a[0] = last;
    let i = 0;
    for (; ;) {
      const l = 2 * i + 1, r = l + 1;
      let s = i;
      if (l < a.length && a[l] < a[s]) s = l;
      if (r < a.length && a[r] < a[s]) s = r;
      if (s === i) break;
      [a[s], a[i]] = [a[i], a[s]];
      i = s;
    }
    return top;
  }
  get size(): number { return this.a.length; }
}

interface RouteOpts { brush?: number; turn?: number; endDir?: number; startDir?: number; yMin?: number; yMax?: number }

/** Shortest turn-penalized rectilinear path from `from` to `to`, or null. */
function routeCells(occ: Occ, from: Pt, to: Pt, opts: RouteOpts = {}): Pt[] | null {
  const brush = opts.brush ?? 1, turn = opts.turn ?? 16;
  const yMin = opts.yMin ?? 0, yMax = opts.yMax ?? GRID_H - 1;
  const N = GRID_W * GRID_H * 4;
  const dist = new Int32Array(N).fill(0x7fffffff);
  const prev = new Int32Array(N).fill(-1);
  const enc = (x: number, y: number, d: number) => (y * GRID_W + x) * 4 + d;
  const heap = new Heap();
  const seedDirs = opts.startDir === undefined ? [0, 1, 2, 3] : [opts.startDir];
  if (!occ.brushFree(from.x, from.y, brush)) return null;
  for (const d of seedDirs) {
    const s = enc(from.x, from.y, d);
    dist[s] = 0;
    heap.push(s);
  }
  let goal = -1;
  while (heap.size > 0) {
    const packed = heap.pop()!;
    const s = packed % 1000000, c = (packed - s) / 1000000;
    if (c > dist[s]) continue;
    const d = s & 3, cellIdx = (s - d) / 4;
    const x = cellIdx % GRID_W, y = (cellIdx - (cellIdx % GRID_W)) / GRID_W;
    if (x === to.x && y === to.y && (opts.endDir === undefined || d === opts.endDir)) { goal = s; break; }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd ^ 1) === d) continue; // no immediate reversal
      const nx = x + DIRS[nd].x, ny = y + DIRS[nd].y;
      if (ny < yMin || ny + brush - 1 > yMax) continue; // stay inside the group's band
      if (!occ.brushFree(nx, ny, brush)) continue;
      const nc = c + 1 + (nd === d ? 0 : turn);
      const ns = enc(nx, ny, nd);
      if (nc >= dist[ns]) continue;
      dist[ns] = nc;
      prev[ns] = s;
      heap.push(nc * 1000000 + ns);
    }
  }
  if (goal < 0) return null;
  const out: Pt[] = [];
  for (let s = goal; s >= 0; s = prev[s]) {
    const d = s & 3, ci = (s - d) / 4;
    out.push({ x: ci % GRID_W, y: (ci - (ci % GRID_W)) / GRID_W });
  }
  return out.reverse();
}

/** Collapse a dense cell path down to its corner waypoints. */
function toWaypoints(cells: Pt[]): Pt[] {
  if (cells.length < 3) return cells.slice();
  const out: Pt[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = cells[i - 1], b = cells[i], c = cells[i + 1];
    if ((b.x - a.x) !== (c.x - b.x) || (b.y - a.y) !== (c.y - b.y)) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

const sgn = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Rectilinear polyline -> cells, mitering every interior corner into a 45 chamfer. */
function chamfer(poly: Pt[], amount: number): Pt[] {
  if (poly.length < 2) return poly.slice();
  const out: Pt[] = [];
  const push = (p: Pt) => {
    const l = out[out.length - 1];
    if (!l || l.x !== p.x || l.y !== p.y) out.push({ ...p });
  };
  const legLen = (i: number) => Math.abs(poly[i + 1].x - poly[i].x) + Math.abs(poly[i + 1].y - poly[i].y);
  let cursor = { ...poly[0] };
  for (let i = 0; i < poly.length - 1; i++) {
    const d0 = { x: sgn(poly[i + 1].x - poly[i].x), y: sgn(poly[i + 1].y - poly[i].y) };
    const isLast = i === poly.length - 2;
    let end = { ...poly[i + 1] };
    let k = 0;
    if (!isLast && amount > 0) {
      const d1 = { x: sgn(poly[i + 2].x - poly[i + 1].x), y: sgn(poly[i + 2].y - poly[i + 1].y) };
      k = Math.min(amount, Math.floor((legLen(i) - 1) / 2), Math.floor((legLen(i + 1) - 1) / 2));
      if (k > 0) {
        end = { x: poly[i + 1].x - k * d0.x, y: poly[i + 1].y - k * d0.y };
        // straight leg
        for (let p = { ...cursor }; ; p = { x: p.x + d0.x, y: p.y + d0.y }) {
          push(p);
          if (p.x === end.x && p.y === end.y) break;
        }
        // 45 chamfer across the corner
        const step = { x: d0.x + d1.x, y: d0.y + d1.y };
        let p = { ...end };
        for (let s = 0; s < k; s++) { p = { x: p.x + step.x, y: p.y + step.y }; push(p); }
        cursor = p;
        continue;
      }
    }
    for (let p = { ...cursor }; ; p = { x: p.x + d0.x, y: p.y + d0.y }) {
      push(p);
      if (p.x === end.x && p.y === end.y) break;
    }
    cursor = { ...end };
  }
  return out;
}

/** Widen a cell path with a brush x brush square brush. */
function widen(cells: Pt[], brush: number): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const c of cells)
    for (let dy = 0; dy < brush; dy++)
      for (let dx = 0; dx < brush; dx++) {
        const k = `${c.x + dx},${c.y + dy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ x: c.x + dx, y: c.y + dy });
      }
  return out;
}

export interface Net { cells: Pt[]; color: string; spine: Pt[]; weight: number }

/**
 * Push both ends of a spine `n` cells further along their terminal direction.
 * Routing endpoints must sit a couple of cells clear of a component (brush +
 * clearance), which would otherwise leave a visible gap between trace and pin;
 * the overshoot is drawn *under* the component body (and under the connector
 * gold), so the trace reads as landing on the pin.
 */
function extendSpine(spine: Pt[], n: number): Pt[] {
  if (spine.length < 2 || n <= 0) return spine;
  const head: Pt[] = [], tail: Pt[] = [];
  const d0 = { x: sgn(spine[0].x - spine[1].x), y: sgn(spine[0].y - spine[1].y) };
  const d1 = { x: sgn(spine[spine.length - 1].x - spine[spine.length - 2].x), y: sgn(spine[spine.length - 1].y - spine[spine.length - 2].y) };
  for (let i = 1; i <= n; i++) {
    head.unshift({ x: spine[0].x + d0.x * i, y: spine[0].y + d0.y * i });
    tail.push({ x: spine[spine.length - 1].x + d1.x * i, y: spine[spine.length - 1].y + d1.y * i });
  }
  return [...head, ...spine, ...tail];
}

/** Route + chamfer + widen + reserve. Returns null when no legal path exists. */
function trace(occ: Occ, from: Pt, to: Pt, color: string, opts: RouteOpts & { chamfer?: number; clearance?: number; extend?: number; optional?: boolean } = {}): Net | null {
  const brush = opts.brush ?? 1;
  // Try the constrained route first (fixed exit/entry faces keep sibling nets
  // off each other's hub anchors); fall back to a free route rather than
  // dropping the net entirely.
  const raw = routeCells(occ, from, to, opts)
    ?? ((opts.startDir !== undefined || opts.endDir !== undefined)
      ? routeCells(occ, from, to, { ...opts, startDir: undefined, endDir: undefined })
      : null);
  if (!raw) {
    if (!opts.optional) routeFailures++;
    if (process.env.PROTO_DEBUG) console.error(`  route failed ${from.x},${from.y} -> ${to.x},${to.y} brush=${brush} startFree=${occ.brushFree(from.x, from.y, brush)} endFree=${occ.brushFree(to.x, to.y, brush)}`);
    return null;
  }
  const wp = toWaypoints(raw);
  const ch = opts.chamfer ?? 2;
  let spine = chamfer(wp, ch);
  let cells = widen(spine, brush);
  if (cells.some(c => occ.blockedAt(c.x, c.y))) { spine = raw; cells = widen(raw, brush); }
  const clearance = opts.clearance ?? 1;
  for (const c of cells)
    for (let dy = -clearance; dy <= clearance; dy++)
      for (let dx = -clearance; dx <= clearance; dx++) occ.block(c.x + dx, c.y + dy);
  cells = widen(extendSpine(spine, opts.extend ?? 4), brush);
  return { cells, color, spine, weight: brush };
}

/**
 * Hand-placed bus: skip the router and lay an explicit rectilinear polyline.
 * Used where the floorplan already defines the lane (a reserved gutter) and the
 * router's freedom to pick either arm of an L would fight the next net for the
 * same few columns.
 */
function manual(occ: Occ, poly: Pt[], color: string, opts: { brush?: number; chamfer?: number; extend?: number } = {}): Net {
  const brush = opts.brush ?? 1;
  const spine = chamfer(poly, opts.chamfer ?? 2);
  for (const c of widen(spine, brush))
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) occ.block(c.x + dx, c.y + dy);
  return { cells: widen(extendSpine(spine, opts.extend ?? 4), brush), color, spine, weight: brush };
}

/**
 * A parallel bus bundle: route the first trace, then offset its waypoint
 * polyline diagonally by (d,d) per sibling so horizontal legs stay parallel at
 * pitch d AND vertical legs stay parallel at pitch d — real bus discipline.
 * Siblings that collide are re-routed independently rather than dropped.
 */
function bundle(
  occ: Occ, from: Pt, to: Pt, color: string, count: number, pitch: number,
  opts: RouteOpts & { chamfer?: number } = {},
): Net[] {
  const brush = opts.brush ?? 1;
  const first = routeCells(occ, from, to, opts);
  const nets: Net[] = [];
  // Siblings inside one bundle pack tightly against each other (only their own
  // cells are reserved while the bundle is being laid); the 1-cell clearance
  // halo is applied once, around the finished bundle, so *other* nets keep
  // their distance but the bus itself can run at its intended pitch.
  const own: Pt[] = [];
  const emit = (spineRaw: Pt[]) => {
    const spine = chamfer(toWaypoints(spineRaw), opts.chamfer ?? 2);
    const cells = widen(spine, brush);
    if (cells.some(c => occ.blockedAt(c.x, c.y))) return false;
    for (const c of cells) { occ.block(c.x, c.y); own.push(c); }
    nets.push({ cells: widen(extendSpine(spine, 4), brush), color, spine, weight: brush });
    return true;
  };
  if (!first) {
    routeFailures++;
    if (process.env.PROTO_DEBUG) console.error(`  bundle failed ${from.x},${from.y} -> ${to.x},${to.y} brush=${brush}`);
    return nets;
  }
  emit(first);
  const wp = toWaypoints(first);
  const horizFirst = wp.length > 1 && wp[0].y === wp[1].y;
  const horizLast = wp.length > 1 && wp[wp.length - 1].y === wp[wp.length - 2].y;
  for (let i = 1; i < count; i++) {
    const d = i * pitch;
    const off = wp.map(p => ({ x: p.x + d, y: p.y + d }));
    if (horizFirst) off[0].x = wp[0].x; else off[0].y = wp[0].y;
    if (horizLast) off[off.length - 1].x = wp[wp.length - 1].x;
    else off[off.length - 1].y = wp[wp.length - 1].y;
    if (emit(off)) continue;
    const alt = routeCells(occ, { x: off[0].x, y: off[0].y }, { x: off[off.length - 1].x, y: off[off.length - 1].y }, opts);
    if (alt) emit(alt);
  }
  for (const c of own)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) occ.block(c.x + dx, c.y + dy);
  return nets;
}

// ---------------------------------------------------------------------------
// Component sprites (variant A vocabulary). Every sprite is cell-aligned.
// ---------------------------------------------------------------------------
type Draw = (ctx: Ctx, level: number) => void;
export interface Comp { rect: Rect; draw: Draw }

const comp = (rect: Rect, draw: Draw): Comp => ({ rect, draw });

/**
 * Connection lighting (Cody, 2026-07-24): every attached component has two
 * states. **Unlit** — the part exists but is not yet energised: a dark tone
 * ladder topping out at `#222222`, no accent anywhere (deliberately close to the
 * old near-invisible look). **Lit** — the growing circuit has reached its
 * attachment point: the approved brighter-gray ladder plus accent pins/markers.
 *
 * Both states are the *same* sprite drawn through a tone ladder, so the two can
 * never drift apart, and the lit ladder maps exactly onto the constants the
 * approved portrait was drawn with (recess #111111, lid #1a1a1a, body #222222,
 * metal #444444, bright #888888).
 */
interface Tones { recess: string; lid: string; body: string; metal: string; bright: string; accent: string | null }
/**
 * Three rungs, each one palette step apart: 0 unlit, 1 mid, 2 lit. Levels are
 * *half-rung addressable*: at a half level the dark roles (recess, lid, body)
 * have stepped to the lower rung while the bright roles (metal, bright) and the
 * accent are still on the upper one. That gives every transition a genuine
 * intermediate frame — with the change spread across both frames — without
 * inventing a palette entry. A 1-rung move occupies 2 frames and a 2-rung move
 * 4, matching §12.5/§12.6.1, and nothing ever changes in a single frame.
 */
export const LEVEL_UNLIT = 0, LEVEL_MID = 1, LEVEL_LIT = 2;
const RUNG_TONES: Omit<Tones, 'accent'>[] = [
  { recess: P.bg, lid: P.bg, body: P.grid, metal: P.surface, bright: P.edge },       // 0 unlit
  { recess: P.grid, lid: P.grid, body: P.surface, metal: P.edge, bright: P.dim },     // 1 mid
  { recess: P.grid, lid: P.surface, body: P.edge, metal: P.dim, bright: P.muted },    // 2 lit
];
const rungAccent = (rung: number, accent: string | null): string | null =>
  rung >= LEVEL_LIT ? accent : rung === LEVEL_MID && accent ? mixOnBg(accent, 0.6) : null;
export const tonesFor = (level: number, accent: string | null = null): Tones => {
  const clamped = Math.max(0, Math.min(LEVEL_LIT, level));
  const lo = RUNG_TONES[Math.floor(clamped)], hi = RUNG_TONES[Math.ceil(clamped)];
  // At a half rung the *dark* roles have already stepped and the *bright* roles
  // plus the accent have not, so the change is spread across the two frames
  // instead of landing almost entirely on one. At an integer level lo === hi, so
  // the lit and unlit states are bit-for-bit what they always were.
  return {
    recess: lo.recess, lid: lo.lid, body: lo.body,
    metal: hi.metal, bright: hi.bright,
    accent: rungAccent(Math.ceil(clamped), accent),
  };
};
/** Accent-carrying detail falls back to plain metal when the part is unlit. */
const acc = (T: Tones): string => T.accent ?? T.metal;

/** CPU socket: plastic frame + exposed pin-grid border + accent heat spreader. */
function cpuSocket(x: number, y: number, w: number, h: number, accent: string): Comp {
  return comp({ x, y, w, h }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 2, y + 2, w - 4, h - 4, T.recess);
    for (let iy = y + 3; iy < y + h - 3; iy += 2)
      for (let ix = x + 3; ix < x + w - 3; ix += 2) cell(ctx, ix, iy, T.metal);
    const m = 5, hx = x + m, hy = y + m, hw = w - 2 * m, hh = h - 2 * m;
    box(ctx, hx, hy, hw, hh, T.metal);
    frame(ctx, hx, hy, hw, hh, acc(T), 1);
    frame(ctx, hx + 2, hy + 2, hw - 4, hh - 4, T.bright, 1);
    box(ctx, hx + 3, hy + 3, hw - 6, hh - 6, T.body);
    box(ctx, x + 1, y + 1, 2, 2, acc(T)); // pin-1 marker
  });
}

/** Vertical DIMM slot: dark body, contact column, accent latches, keying notch. */
function dimmSlot(x: number, y: number, h: number, accent: string): Comp {
  return comp({ x, y, w: 3, h }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, 3, h, T.body);
    box(ctx, x + 1, y + 1, 1, h - 2, T.metal);
    for (let iy = y + 2; iy < y + h - 2; iy += 3) cell(ctx, x + 1, iy, T.bright);
    box(ctx, x, y, 3, 1, acc(T));
    box(ctx, x, y + h - 1, 3, 1, acc(T));
    cell(ctx, x + 1, y + Math.floor(h * 0.38), P.bg); // key notch — substrate, both states
  });
}

/** Horizontal expansion (PCIe) slot: shroud, contact rows, accent end latch. */
function pcieSlot(x: number, y: number, w: number, accent: string): Comp {
  return comp({ x, y, w, h: 4 }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, w, 4, T.body);
    box(ctx, x + 1, y + 1, w - 2, 2, T.recess);
    for (let ix = x + 2; ix < x + w - 2; ix += 2) { cell(ctx, ix, y + 1, T.metal); cell(ctx, ix, y + 2, T.metal); }
    box(ctx, x + w - 2, y, 2, 4, acc(T));
    box(ctx, x, y, 1, 4, T.metal);
  });
}

/** VRM inductor: chunky metal cube with a visible coil core. */
function choke(x: number, y: number): Comp {
  return comp({ x, y, w: 4, h: 4 }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, 4, 4, T.metal);
    box(ctx, x + 1, y + 1, 2, 2, T.bright);
  });
}

/** MOSFET / DPAK: body plus a row of bright pins. */
function mosfet(x: number, y: number): Comp {
  return comp({ x, y, w: 3, h: 3 }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, 3, 2, T.body);
    box(ctx, x, y, 3, 1, T.metal);
    for (let i = 0; i < 3; i++) cell(ctx, x + i, y + 2, T.bright);
  });
}

/** Small electrolytic cap: round silhouette with a crossed (scored) top. */
function capSmall(x: number, y: number): Comp {
  return comp({ x, y, w: 3, h: 3 }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, 3, 3, T.body);
    cell(ctx, x + 1, y, T.bright); cell(ctx, x, y + 1, T.bright);
    cell(ctx, x + 2, y + 1, T.bright); cell(ctx, x + 1, y + 2, T.bright);
    cell(ctx, x + 1, y + 1, T.metal);
  });
}

/** Big electrolytic can: bright rim, dark scored top, rounded corners. */
function capBig(x: number, y: number): Comp {
  return comp({ x, y, w: 4, h: 4 }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, 4, 4, T.bright);
    box(ctx, x + 1, y + 1, 2, 2, T.metal);
    cell(ctx, x, y, T.body); cell(ctx, x + 3, y, T.body);
    cell(ctx, x, y + 3, T.body); cell(ctx, x + 3, y + 3, T.body);
    cell(ctx, x + 1, y + 1, T.bright); cell(ctx, x + 2, y + 2, T.bright);
  });
}

/** Coin cell in its holder: bright disc with a retaining clip. */
function coinCell(x: number, y: number): Comp {
  const R = 6;
  return comp({ x, y, w: R, h: R }, (ctx, level) => {
    const T = tonesFor(level);
    const rows = [[2, 3], [1, 4], [0, 5], [0, 5], [1, 4], [2, 3]];
    rows.forEach(([a, b], r) => box(ctx, x + a, y + r, b - a + 1, 1, T.bright));
    box(ctx, x + 2, y + 2, 2, 2, T.metal);
    cell(ctx, x + 2, y + 2, T.bright);
    box(ctx, x, y + 2, 1, 2, T.body); // holder clip
    box(ctx, x + R - 1, y + 2, 1, 2, T.body);
  });
}

/** Chipset heatsink: finned block. */
function heatsink(x: number, y: number, w: number, h: number, accent: string): Comp {
  return comp({ x, y, w, h }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.bright, 1);
    for (let iy = y + 2; iy < y + h - 1; iy += 2) box(ctx, x + 2, iy, w - 4, 1, T.metal);
    box(ctx, x + 1, y + 1, 2, 1, acc(T));
  });
}

/** Quad-flat-pack IC: body, bright pin rows on all four sides, accent pin-1 dot. */
function qfp(x: number, y: number, w: number, h: number, accent: string): Comp {
  return comp({ x: x - 1, y: y - 1, w: w + 2, h: h + 2 }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 2, y + 2, w - 4, h - 4, T.lid);
    for (let iy = y + 1; iy < y + h - 1; iy += 2) { cell(ctx, x - 1, iy, T.bright); cell(ctx, x + w, iy, T.bright); }
    for (let ix = x + 1; ix < x + w - 1; ix += 2) { cell(ctx, ix, y - 1, T.bright); cell(ctx, ix, y + h, T.bright); }
    cell(ctx, x + 1, y + 1, acc(T));
  });
}

/** Dual-inline IC (DRAM / flash): body with pins on the two long sides. */
function dipIC(x: number, y: number, w: number, h: number, accent: string): Comp {
  return comp({ x: x - 1, y, w: w + 2, h }, (ctx, level) => {
    const T = tonesFor(level, accent);
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 1, y + 1, w - 2, h - 2, T.lid);
    for (let iy = y + 1; iy < y + h - 1; iy += 2) { cell(ctx, x - 1, iy, T.bright); cell(ctx, x + w, iy, T.bright); }
    cell(ctx, x + 1, y + 1, acc(T));
  });
}

/** Crystal oscillator: small shiny can. */
function crystal(x: number, y: number): Comp {
  return comp({ x, y, w: 4, h: 2 }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, 4, 2, T.bright);
    box(ctx, x + 1, y, 2, 1, T.metal);
    cell(ctx, x, y, T.body); cell(ctx, x + 3, y, T.body);
  });
}

/** Pin header (SATA / power): shroud with a bright pin grid. */
function header(x: number, y: number, w: number, h: number): Comp {
  return comp({ x, y, w, h }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    for (let iy = y + 1; iy < y + h - 1; iy += 2)
      for (let ix = x + 1; ix < x + w - 1; ix += 2) cell(ctx, ix, iy, T.bright);
  });
}

/** 2-pin chip resistor / small SMD passive. */
function smd(x: number, y: number, w: number, h: number): Comp {
  return comp({ x, y, w, h }, (ctx, level) => {
    const T = tonesFor(level);
    box(ctx, x, y, w, h, T.body);
    if (w >= h) { box(ctx, x, y, 1, h, T.bright); box(ctx, x + w - 1, y, 1, h, T.bright); }
    else { box(ctx, x, y, w, 1, T.bright); box(ctx, x, y + h - 1, w, 1, T.bright); }
  });
}

/** Anonymous IC in the current visual language (variants B and C). */
function anonIC(rect: Rect, accent: string, style: 'chunky' | 'thin'): Comp {
  return comp(rect, ctx => {
    if (style === 'chunky') {
      box(ctx, rect.x, rect.y, rect.w, rect.h, P.edge);
      frame(ctx, rect.x, rect.y, rect.w, rect.h, P.dim, 1);
      box(ctx, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4, P.surface);
    } else {
      box(ctx, rect.x, rect.y, rect.w, rect.h, P.surface);
      hairline(ctx, rect, P.edge);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared board scaffold
// ---------------------------------------------------------------------------
export function drawSubstrate(ctx: Ctx): void {
  box(ctx, 0, 0, BOARD_RIGHT, GRID_H, P.bg);
  ctx.fillStyle = P.void;
  ctx.fillRect(px(BOARD_RIGHT), 0, WIDTH - px(BOARD_RIGHT), HEIGHT);

  // Fiberglass grid as cell-aligned **intersection dots** rather than continuous
  // 1px lines. Two reasons, both binding: (a) §3 requires all simulation art on
  // integer cells with hard edges, and a 1px line at px+0.5 is sub-cell; (b) the
  // continuous lines cost 2.07 MB of the GIF budget on their own (measured) by
  // breaking every LZW run on the board, where the dots cost ~0.1 MB. Same
  // 8-cell pitch, same `#111111`, same faint texture.
  if (!process.env.PROTO_NOGRID)
    for (let gy = 0; gy <= GRID_H; gy += 8)
      for (let gx = 0; gx <= BOARD_RIGHT; gx += 8) cell(ctx, gx, gy, P.grid);

  ctx.strokeStyle = BOARD_EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(px(BOARD.inset) + 1, px(BOARD.inset) + 1,
    px(BOARD_RIGHT) - px(BOARD.inset) - 2, HEIGHT - 2 * px(BOARD.inset) - 2);
  ctx.strokeStyle = BOARD_KEEPOUT;
  ctx.lineWidth = 1;
  const ki = BOARD.inset + 2;
  ctx.strokeRect(px(ki) + 0.5, px(ki) + 0.5, px(BOARD_RIGHT - ki) - px(ki) - 1, HEIGHT - 2 * px(ki) - 1);
}

// Mount holes: two on the left board edge, two on the right edge *between* the
// connector's finger groups (prototype deviation from production's 4 bare
// corners — a hole at the board's top-right corner sits squarely in the
// connector fanout lane and structurally seals finger group 0's approach).
export const MOUNT_HOLES: Pt[] = [
  { x: 6, y: 6 }, { x: 6, y: GRID_H - 6 }, { x: 222, y: 21 }, { x: 222, y: 42 },
];
export function drawMountHole(ctx: Ctx, h: Pt): void {
  const cx = px(h.x) + CELL / 2, cy = px(h.y) + CELL / 2;
  ctx.strokeStyle = BOARD_KEEPOUT; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = BOARD_EDGE; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = P.dim; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = P.void; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
}

interface DressFeature { kind: 'hatch' | 'footprint' | 'fiducial' | 'testpoint'; rect: Rect; designator?: string }

function buildDressing(rng: Rng, occ: Occ, density: { hatch: [number, number]; foot: [number, number]; fid: [number, number]; tp: [number, number] }): DressFeature[] {
  const out: DressFeature[] = [];
  const taken: Rect[] = [];
  const hits = (r: Rect): boolean => {
    for (let y = r.y - 1; y < r.y + r.h + 1; y++)
      for (let x = r.x - 1; x < r.x + r.w + 1; x++) if (occ.blockedAt(x, y)) return true;
    return taken.some(t => r.x < t.x + t.w + 1 && t.x < r.x + r.w + 1 && r.y < t.y + t.h + 1 && t.y < r.y + r.h + 1);
  };
  const place = (w: number, h: number, tries: number): Rect | null => {
    for (let a = 0; a < tries; a++) {
      const r = { x: randInt(rng, 6, BOARD_RIGHT - 8 - w), y: randInt(rng, 6, 62 - h), w, h };
      if (!hits(r)) return r;
    }
    return null;
  };
  for (let i = 0; i < randInt(rng, ...density.hatch); i++) {
    const r = place(randInt(rng, 10, 20), randInt(rng, 6, 12), 40);
    if (r) out.push({ kind: 'hatch', rect: r });
  }
  const presets: [number, number, string][] = [[3, 5, 'U'], [4, 1, 'R'], [2, 2, 'C'], [5, 2, 'R'], [2, 4, 'C']];
  for (let i = 0; i < randInt(rng, ...density.foot); i++) {
    const [w, h, p] = pick(rng, presets);
    const r = place(w, h, 60);
    if (!r) continue;
    taken.push(r);
    out.push({ kind: 'footprint', rect: r, designator: `${p}${randInt(rng, 1, 99)}` });
  }
  for (let i = 0; i < randInt(rng, ...density.fid); i++) {
    const r = place(3, 3, 60);
    if (r) { taken.push(r); out.push({ kind: 'fiducial', rect: r }); }
  }
  for (let i = 0; i < randInt(rng, ...density.tp); i++) {
    const r = place(3, 3, 60);
    if (r) { taken.push(r); out.push({ kind: 'testpoint', rect: r }); }
  }
  return out;
}

export function drawDressing(ctx: Ctx, features: DressFeature[]): void {
  for (const f of features) {
    const bx = px(f.rect.x), by = px(f.rect.y), bw = px(f.rect.w), bh = px(f.rect.h);
    switch (f.kind) {
      case 'footprint':
        ctx.strokeStyle = DRESSING_COLORS.outline; ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = DRESSING_COLORS.pin;
        if (f.rect.w >= f.rect.h) {
          ctx.fillRect(px(f.rect.x - 1), by, CELL, bh);
          ctx.fillRect(px(f.rect.x + f.rect.w), by, CELL, bh);
        } else {
          ctx.fillRect(bx, px(f.rect.y - 1), bw, CELL);
          ctx.fillRect(bx, px(f.rect.y + f.rect.h), bw, CELL);
        }
        if (f.designator) {
          ctx.font = '8px "JetBrains Mono"';
          ctx.fillStyle = DRESSING_COLORS.designator;
          ctx.fillText(f.designator, bx, by - 2);
        }
        break;
      case 'hatch': {
        ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
        ctx.strokeStyle = DRESSING_COLORS.hatch; ctx.lineWidth = 1;
        for (let d = -bh; d < bw; d += 6) {
          ctx.beginPath(); ctx.moveTo(bx + d, by); ctx.lineTo(bx + d + bh, by + bh); ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case 'fiducial':
        ctx.strokeStyle = DRESSING_COLORS.ring; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, Math.min(bw, bh) / 2 - 1, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'testpoint':
        ctx.strokeStyle = DRESSING_COLORS.ring; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, Math.min(bw, bh) / 2, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, 1, 0, Math.PI * 2); ctx.stroke();
        break;
    }
  }
}

function drawConnector(ctx: Ctx, litIndex: number): void {
  FINGERS.forEach((f, i) => {
    box(ctx, f.x, f.y, FINGER_W, f.h, i === litIndex ? P.goldLit : P.gold);
  });
}

// Silkscreen name treatment (Cody, 2026-07-24): "i'd like my name on it more
// subtle, no $ (not like a terminal) just like print on the board." The name is
// board legend, not a shell prompt — no `$`, no block cursor, no glow halo, no
// signage flicker. It shares the REV line's color and weight so the whole bottom
// band reads as one silkscreen layer, one size step up so it still anchors the
// corner without headlining. `NAME` is stripped of layout.ts's `$ ` prefix here
// rather than editing the shared constant (production updates it later).
const NAME_PRINT = NAME.replace(/^\$\s*/, '');
const NAME_FONT_PX = 15;
// Left inset clears the (6,74) mount hole's keepout circle (x 16..36 px).
const NAME_X = px(NAME_ZONE.x) + 36;
// One shared baseline across name / thesis / REV — the "single silkscreen layer".
const SILK_BASELINE = 26;

/**
 * `nameLit` false renders the legend at `#444444` — the name participates in the
 * power-on cascade like any other component (Cody, 2026-07-24), lighting to
 * `#888888` once the first region connects. Thesis and REV are static print and
 * never ramp.
 */
export function drawTextLayer(ctx: Ctx, seed: number, nameLit = true): void {
  // Text layer, 2026-07-25 (Cody): "get rid of tag line and details, just put rev
  // on left side of board." Thesis line and the credentials tail are gone; the
  // legend is now two stacked lines bottom-left — name over REV — both silkscreen
  // gray, sharing the left inset that clears the (6,74) mount hole.
  ctx.fillStyle = nameLit ? P.muted : P.dim;
  ctx.font = `${NAME_FONT_PX}px "JetBrains Mono"`;
  ctx.fillText(NAME_PRINT, NAME_X, px(NAME_ZONE.y) + 22);

  ctx.fillStyle = P.muted;
  ctx.font = '11px "JetBrains Mono"';
  ctx.fillText(`REV ${revFromSeed(seed)}`, NAME_X, px(NAME_ZONE.y) + 40);
}

// One posed creature in the void (spec: 28-34 cells, mirror-symmetric, 2 eyes).
const EYES = [{ r: 3, c: 4 }, { r: 3, c: 7 }];
const BODY_PROFILE = [0.0, 0.135, 0.297, 0.297, 0.378, 0.432, 0.432, 0.405, 0.378, 0.324, 0.243, 0.189];

function genBody(rng: Rng): boolean[][] {
  for (; ;) {
    const body: boolean[][] = Array.from({ length: 12 }, () => Array(12).fill(false));
    for (let r = 0; r < 12; r++)
      for (let c = 0; c < 6; c++) {
        const v = rng() < BODY_PROFILE[r];
        body[r][c] = v; body[r][11 - c] = v;
      }
    for (const e of EYES) { body[e.r][e.c] = true; body[e.r][11 - e.c] = true; }
    // keep the largest 8-connected component
    const seen = Array.from({ length: 12 }, () => Array(12).fill(false));
    let best: [number, number][] = [];
    for (let r = 0; r < 12; r++)
      for (let c = 0; c < 12; c++) {
        if (!body[r][c] || seen[r][c]) continue;
        const compCells: [number, number][] = [];
        const stack: [number, number][] = [[r, c]];
        seen[r][c] = true;
        while (stack.length) {
          const [cr, cc] = stack.pop()!;
          compCells.push([cr, cc]);
          for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++) {
              const nr = cr + dr, nc = cc + dc;
              if (nr >= 0 && nr < 12 && nc >= 0 && nc < 12 && body[nr][nc] && !seen[nr][nc]) {
                seen[nr][nc] = true; stack.push([nr, nc]);
              }
            }
        }
        if (compCells.length > best.length) best = compCells;
      }
    const keep = new Set(best.map(([r, c]) => `${r},${c}`));
    let count = 0;
    for (let r = 0; r < 12; r++)
      for (let c = 0; c < 12; c++) { body[r][c] = keep.has(`${r},${c}`); if (body[r][c]) count++; }
    if (count >= 28 && count <= 34 && EYES.every(e => body[e.r][e.c])) return body;
  }
}

interface PosedCreature { body: boolean[][]; ox: number; oy: number; color: string }

/** Split from the draw so the rng stream is consumed identically whether or not
 * the creature is actually shown (it only exists once a finger has arrived). */
function poseCreature(rng: Rng, color: string): PosedCreature {
  const body = genBody(rng);
  return { body, ox: randInt(rng, 244, 280), oy: randInt(rng, 14, 46), color };
}

function drawCreature(ctx: Ctx, c: PosedCreature): void {
  const { body, ox, oy, color } = c;
  for (let r = 0; r < 12; r++)
    for (let col = 0; col < 12; col++) {
      if (!body[r][col]) continue;
      const isEye = EYES.some(e => e.r === r && (e.c === col || 11 - e.c === col));
      cell(ctx, ox + col, oy + r, isEye ? P.offwhite : color);
    }
}

// ---------------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------------
interface Led { x: number; y: number; color: string; period: number; phase: number }
interface Blip { x: number; y: number; w: number; h: number; color: string; period: number; phase: number }
interface Exclusive { comp: Comp; tree: number; breather: boolean; reach: number }
interface Alive { fan: Pt; fanAccent: string; leds: Led[]; blips: Blip[]; exclusives: Exclusive[] }
export interface Scene { comps: Comp[]; nets: Net[]; silk: Draw[]; dressing: DressFeature[]; pulse?: { path: Pt[]; color: string }; alive?: Alive }

export function baseOcc(): Occ {
  const occ = new Occ();
  // off-board + margins
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (x < 7 || x > 226 || y < 6 || y > 63) occ.block(x, y);
  for (const z of TEXT_ZONES) occ.blockRect(z, 1);
  for (const h of MOUNT_HOLES) occ.blockRect({ x: h.x - 2, y: h.y - 2, w: 5, h: 5 });
  for (const f of FINGERS) occ.blockRect({ x: f.x, y: f.y, w: FINGER_W, h: f.h });
  return occ;
}

/** Trace landing cell just west of a finger; brush-aware so a 2-cell trunk's
 * own footprint stays on-board instead of overlapping the gold. */
const fingerEntry = (band: number, idx: number, brush = 1): Pt => {
  const f = FINGERS.filter(g => g.band === band)[idx];
  return { x: 227 - brush, y: brush === 1 ? f.y + 1 : f.y };
};

let routeFailures = 0;

/** Reserve every component footprint (1-cell clearance) against the router. */
function reserve(occ: Occ, comps: Comp[]): void {
  for (const c of comps) occ.blockRect(c.rect, 1);
}

export function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [out[i], out[k]] = [out[k], out[i]]; }
  return out;
}

// ---------- Variant A: iconic motherboard --------------------------------
//
// Floorplan discipline: three component rows separated by reserved horizontal
// routing gutters, plus vertical gutters between column groups and a connector
// fanout zone on the right. Components never enter a gutter, so the router
// always has committed straight lanes — that is what makes the routing read as
// deliberate bus work instead of wandering.
//
//   row T   y  6..17     gutter 1  y 18..23
//   row M   y 24..44     gutter 2  y 45..49
//   row B   y 50..58     gutter 3  y 59..63
//
export function buildA(rng: Rng, occ: Occ): Scene {
  const acc = shuffled(rng, ACCENT_LIST);
  const comps: Comp[] = [];
  const silk: Draw[] = [];
  const nets: Net[] = [];
  const add = (n: Net | null) => { if (n) nets.push(n); };
  const addAll = (ns: Net[]) => nets.push(...ns);

  const sectionBox = (r: Rect, label?: string) => silk.push(ctx => {
    ctx.strokeStyle = P.surface; ctx.lineWidth = 1;
    ctx.strokeRect(px(r.x) + 0.5, px(r.y) + 0.5, px(r.w) - 1, px(r.h) - 1);
    if (label) silkText(ctx, label, r.x + 1, r.y - 0.4, 8, P.edge);
  });

  // ---------------- row T: power section, chipset, memory, logic -----------
  const nChoke = randInt(rng, 5, 6);
  const chokePitch = nChoke === 6 ? 5 : 6;
  for (let i = 0; i < nChoke; i++) { comps.push(choke(10 + i * chokePitch, 6)); comps.push(mosfet(10 + i * chokePitch, 11)); }
  sectionBox({ x: 8, y: 5, w: nChoke * chokePitch + 3, h: 12 }, 'VRM');
  for (let i = 0; i < 3; i++) comps.push(capBig(45 + i * 5, 6));
  for (let i = 0; i < 3; i++) comps.push(capSmall(45 + i * 5, 12));

  comps.push(heatsink(64, 5, 14, 12, acc[2]));
  sectionBox({ x: 63, y: 4, w: 16, h: 14 }, 'U1');
  comps.push(dipIC(83, 6, 6, 11, acc[3]));
  comps.push(dipIC(93, 6, 6, 11, acc[3]));
  comps.push(crystal(103, 6));
  for (let i = 0; i < 3; i++) comps.push(capSmall(103 + i * 4, 10));
  comps.push(smd(103, 15, 4, 2)); comps.push(smd(109, 15, 4, 2));

  const nDram = randInt(rng, 3, 4);
  for (let i = 0; i < nDram; i++) comps.push(dipIC(120 + i * 10, 6, 7, 11, acc[1]));
  sectionBox({ x: 118, y: 5, w: nDram * 10 + 1, h: 13 });
  comps.push(dipIC(163, 6, 6, 11, acc[2]));
  comps.push(dipIC(172, 6, 6, 11, acc[4]));
  const qfpTop = qfp(184, 6, 11, 11, acc[0]); // tree 0's hub
  comps.push(qfpTop);

  // ---------------- row M: CPU socket, DIMM bank, bridges ------------------
  const cpu = { x: 10, y: 24 + randInt(rng, -1, 0), w: 26, h: 21 };
  comps.push(cpuSocket(cpu.x, cpu.y, cpu.w, cpu.h, acc[0]));
  sectionBox({ x: cpu.x - 1, y: cpu.y - 1, w: cpu.w + 2, h: cpu.h + 2 }, 'CPU1');

  const nDimm = randInt(rng, 3, 4);
  const dimmX = 46;
  for (let i = 0; i < nDimm; i++) comps.push(dimmSlot(dimmX + i * 6, 24, 21, acc[1]));
  sectionBox({ x: dimmX - 1, y: 23, w: nDimm * 6, h: 23 }, 'DIMM');

  comps.push(coinCell(72, 26));
  silk.push(ctx => silkText(ctx, 'BT1', 72, 25.4, 8, P.edge));
  for (let i = 0; i < 4; i++) comps.push(capSmall(72 + (i % 2) * 4, 34 + Math.floor(i / 2) * 4));

  const qfpBig = { x: 85, y: 26, w: 16, h: 16 };
  comps.push(qfp(qfpBig.x, qfpBig.y, qfpBig.w, qfpBig.h, acc[4]));
  comps.push(header(105, 26, 13, 6));
  for (let i = 0; i < 6; i++) comps.push(capSmall(105 + (i % 3) * 4, 34 + Math.floor(i / 3) * 4));

  const qfp2 = { x: 125, y: 27, w: 12, h: 12 };
  comps.push(qfp(qfp2.x, qfp2.y, qfp2.w, qfp2.h, acc[3]));
  for (let i = 0; i < 4; i++) comps.push(smd(141 + (i % 2) * 6, 27 + Math.floor(i / 2) * 3, 5, 2));
  comps.push(crystal(141, 34));
  comps.push(dipIC(156, 26, 6, 11, acc[1]));
  comps.push(dipIC(165, 26, 6, 11, acc[1]));
  const qfp3 = { x: 178, y: 26, w: 13, h: 13 };
  const qfpMid = qfp(qfp3.x, qfp3.y, qfp3.w, qfp3.h, acc[2]); // tree 1's hub
  comps.push(qfpMid);

  // ---------------- row B: expansion slots, headers, I/O -------------------
  for (let i = 0; i < 9; i++) comps.push(capSmall(10 + i * 4, 50));
  for (let i = 0; i < 4; i++) { comps.push(smd(48 + i * 9, 50, 5, 2)); comps.push(capSmall(54 + i * 9, 50)); }
  comps.push(pcieSlot(10, 55, 72, acc[3]));
  silk.push(ctx => silkText(ctx, 'PCIE1', 10, 54.4, 8, P.edge));
  comps.push(pcieSlot(88, 55, 56, acc[3]));
  silk.push(ctx => silkText(ctx, 'PCIE2', 88, 54.4, 8, P.edge));
  comps.push(header(88, 50, 14, 4));
  comps.push(header(105, 50, 14, 4));
  comps.push(header(150, 53, 16, 6));
  for (let i = 0; i < 4; i++) comps.push(smd(150 + (i % 2) * 6, 50 + Math.floor(i / 2) * 3, 5, 2));
  comps.push(dipIC(172, 50, 6, 9, acc[4]));
  const qfpBot = qfp(185, 51, 7, 7, acc[3]); // tree 2's hub
  comps.push(qfpBot);

  // fanout-zone furniture, in the dead lanes between finger groups so the strip
  // in front of the connector is not bare
  for (let i = 0; i < 3; i++) { comps.push(smd(200 + i * 6, 21, 4, 2)); comps.push(smd(200 + i * 6, 43, 4, 2)); }

  reserve(occ, comps);

  // ---------------- buses --------------------------------------------------
  // power: one 2-cell trunk per MOSFET, straight down into the CPU socket
  for (let i = 0; i < nChoke - 1; i++)
    add(trace(occ, { x: 11 + i * chokePitch, y: 15 }, { x: 11 + i * chokePitch, y: cpu.y - 3 }, acc[0],
      { brush: 2, turn: 40, chamfer: 0 }));
  // bulk caps -> CPU (lands in the free column between power trunks)
  add(trace(occ, { x: 45, y: 17 }, { x: cpu.x + cpu.w - 2, y: cpu.y - 4 }, acc[0], { brush: 1, turn: 26, chamfer: 3 }));
  // chipset -> DIMM bank top: hand-placed down gutter 1 (the router would
  // otherwise take either arm of the L and fight the CPU/DIMM bus for columns)
  add(manual(occ, [{ x: 62, y: 19 }, { x: dimmX + 4, y: 19 }, { x: dimmX + 4, y: 22 }], acc[2], { brush: 1, chamfer: 2 }));
  add(manual(occ, [{ x: 62, y: 21 }, { x: dimmX + 7, y: 21 }, { x: dimmX + 7, y: 22 }], acc[2], { brush: 1, chamfer: 1 }));
  // CPU -> DIMM bank: tight parallel data bus in the CPU/DIMM gutter
  addAll(bundle(occ, { x: cpu.x + cpu.w + 1, y: cpu.y + 3 }, { x: dimmX - 3, y: cpu.y + 3 }, acc[1], 5, 2, { brush: 1, turn: 22, chamfer: 1 }));
  // CPU south -> big QFP: long eastward run through gutter 2
  addAll(bundle(occ, { x: cpu.x + 18, y: cpu.y + cpu.h + 1 }, { x: qfpBig.x + 4, y: qfpBig.y + qfpBig.h + 4 }, acc[1], 3, 4, { brush: 2, turn: 26, chamfer: 3 }));
  // chipset -> DRAM row: long eastward run through gutter 1
  addAll(bundle(occ, { x: 80, y: 19 }, { x: 117, y: 19 }, acc[2], 3, 2, { brush: 1, turn: 26, chamfer: 2 }));
  // coin cell -> chipset
  add(trace(occ, { x: 79, y: 27 }, { x: 70, y: 19 }, acc[2], { brush: 1, turn: 20, chamfer: 2 }));
  // DRAM row -> second QFP (vertical bus down through gutter 1)
  addAll(bundle(occ, { x: 121, y: 19 }, { x: qfp2.x + 1, y: 24 }, acc[1], 4, 3, { brush: 1, turn: 22, chamfer: 2 }));
  // big QFP -> second QFP
  addAll(bundle(occ, { x: qfpBig.x + qfpBig.w + 2, y: 29 }, { x: qfp2.x - 4, y: 29 }, acc[4], 4, 2, { brush: 1, turn: 22, chamfer: 2 }));
  // CPU south -> expansion slot 1 (drop through gutter 2)
  addAll(bundle(occ, { x: cpu.x + 4, y: cpu.y + cpu.h + 1 }, { x: 40, y: 61 }, acc[0], 3, 4, { brush: 2, turn: 26, chamfer: 3 }));
  // expansion slot 2 -> second QFP
  addAll(bundle(occ, { x: 128, y: 53 }, { x: 128, y: 41 }, acc[3], 3, 3, { brush: 1, turn: 26, chamfer: 2 }));
  // headers -> big QFP
  add(trace(occ, { x: 96, y: 47 }, { x: 103, y: 43 }, acc[4], { brush: 1, turn: 20, chamfer: 2 }));
  // full-width backbone along gutter 3 -> up into the right-hand logic
  add(trace(occ, { x: 46, y: 61 }, { x: 170, y: 61 }, acc[4], { brush: 2, turn: 30, chamfer: 3 }));
  // second QFP -> right-hand bridge
  addAll(bundle(occ, { x: qfp2.x + qfp2.w + 2, y: 40 }, { x: qfp3.x - 5, y: 40 }, acc[3], 2, 4, { brush: 2, turn: 26, chamfer: 3 }));

  // ---------------- interconnect fabric (round 9) --------------------------
  //
  // Cody: "so far i don't think the board is as fully connected and dynamically
  // routing as it could be rn".
  //
  // Diagnosis: the buses above form THREE DISJOINT TREES, one per band, and the
  // three band hubs (qfpTop / qfpMid / qfpBot) were each connected to nothing but
  // their own finger group. Two consequences, both of which he is seeing:
  //   * only the middle finger group was reachable from the rest of the board, so
  //     every escape used a group-1 finger;
  //   * a tree has exactly one path between any two nodes, so a flow can pick a
  //     destination but can never pick a different ROUTE to the same place —
  //     "dynamically routing" is capped by the topology, not by the walk.
  //
  // The fix is structural: a vertical hub spine tying the three bands into one
  // circuit, plus trunks that deliberately CLOSE LOOPS so the graph carries
  // cycles. Every added run is rectilinear, chamfered, clearance-reserved and
  // lives in a reserved gutter or a dead column — this is denser motherboard
  // routing, not spaghetti.

  // long gutter-1 trunk: DRAM bank -> row-T hub. The board's first genuinely
  // cross-region bus, and the edge that puts the row-T hub inside a cycle
  // (DRAM -> qfp2 -> row-M hub -> row-T hub -> DRAM).
  addAll(bundle(occ, { x: 128, y: 20 }, { x: 190, y: 20 }, acc[1], 2, 2,
    { brush: 1, turn: 30, chamfer: 3, yMin: 18, yMax: 23 }));
  // hub spine, upper half: row-T hub -> row-M hub
  add(trace(occ, { x: 193, y: 19 }, { x: 193, y: 24 }, acc[0], { brush: 2, turn: 30, chamfer: 1 }));
  // row-M hub -> row-B east logic, down the east dead columns
  add(trace(occ, { x: 181, y: 44 }, { x: 181, y: 50 }, acc[2], { brush: 1, turn: 26, chamfer: 1 }));
  // gutter-3 east: row-B east logic -> row-B hub. Closes the big board loop
  // CPU -> PCIE1 -> row-B logic -> row-B hub -> row-M hub -> QFP2 -> QFPbig -> CPU.
  add(trace(occ, { x: 174, y: 61 }, { x: 196, y: 61 }, acc[3], { brush: 2, turn: 26, chamfer: 3 }));
  // gutter-2 west: cap field -> second QFP
  add(trace(occ, { x: 107, y: 44 }, { x: 124, y: 44 }, acc[4],
    { brush: 1, turn: 26, chamfer: 2, optional: true }));
  // row-B: expansion slot 2 -> I/O header block
  add(trace(occ, { x: 137, y: 50 }, { x: 147, y: 50 }, acc[3],
    { brush: 1, turn: 22, chamfer: 2, optional: true }));
  // row-T west: crystal cluster -> DRAM bank, and cap field -> chipset
  add(trace(occ, { x: 108, y: 7 }, { x: 114, y: 7 }, acc[1],
    { brush: 1, turn: 22, chamfer: 1, optional: true }));
  add(trace(occ, { x: 60, y: 12 }, { x: 62, y: 16 }, acc[2],
    { brush: 1, turn: 22, chamfer: 1, optional: true }));

  // connector fanout: three 2-cell trunks per finger group, parallel into the gold
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: 198, y: 7 + i * 4 }, fingerEntry(0, i, 2), acc[0], { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: qfp3.x + qfp3.w + 3, y: 27 + i * 4 }, fingerEntry(1, i, 2), acc[2], { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));
  // group 2 starts one column west of the other two: at x=198 the lowest trunk's
  // nearest node is the fanout-zone SMD furniture rather than the row-B hub, and
  // that finger ends up served by an island with no path back into the board.
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: 197, y: 49 + i * 4 }, fingerEntry(2, i, 2), acc[3], { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));

  // hub spine, lower half — laid after the fanout so the fanout keeps first pick
  // of its own lanes. This is the link that makes all nine fingers reachable
  // from anywhere on the board.
  add(trace(occ, { x: 194, y: 40 }, { x: 194, y: 52 }, acc[2], { brush: 2, turn: 30, chamfer: 2 }));
  // gutter-2 east lane: row-B I/O furniture -> row-B east logic
  add(trace(occ, { x: 150, y: 47 }, { x: 178, y: 47 }, acc[4],
    { brush: 1, turn: 26, chamfer: 2, optional: true }));
  // header block -> second QFP, down the free column east of the headers
  add(trace(occ, { x: 120, y: 28 }, { x: 120, y: 41 }, acc[3],
    { brush: 1, turn: 26, chamfer: 2, optional: true }));

  if (process.env.PROTO_OCC) {
    const spans = (probe: (i: number) => boolean, n: number): string => {
      const out: string[] = [];
      let s = -1;
      for (let i = 0; i <= n; i++) {
        const free = i < n && !probe(i);
        if (free && s < 0) s = i;
        if (!free && s >= 0) { if (i - s >= 3) out.push(`${s}-${i - 1}`); s = -1; }
      }
      return out.join(' ');
    };
    for (let y = 5; y < 64; y++) console.error(`row ${String(y).padStart(2)}: ${spans(x => occ.blockedAt(x, y), 232)}`);
    for (let x = 8; x < 232; x++) {
      const s = spans(y => occ.blockedAt(x, y), 64);
      if (s) console.error(`col ${String(x).padStart(3)}: ${s}`);
    }
  }

  const dressing = buildDressing(rng, occ, { hatch: [2, 3], foot: [6, 10], fid: [3, 5], tp: [4, 6] });
  const pulseNet = nets.length ? nets[randInt(rng, 0, nets.length - 1)] : undefined;

  // The fan is a real component (Cody, 2026-07-24: "also in the static portrait,
  // with a pop of accent color"): pushed last so it draws over the heatsink it
  // is seated on, and added after `reserve` because it sits entirely inside the
  // heatsink's already-reserved footprint — zero routing impact.
  const fan = fanComp(68, 8, acc[2]);
  comps.push(fan);

  // Recycle model (spec §12.6). Components east of EXCLUSIVE_X belong to exactly
  // one tree (the tree owning their band) and follow that tree's cycle;
  // everything west of it is fed by the shared upstream chain (VRM -> CPU ->
  // DIMM -> bridges) and is therefore constant. Of each tree's exclusives, a
  // seeded 1-2 are *breathers* that fall all the way to unlit; the rest dim only
  // one rung, to the middle tone. Hubs are excluded from the breather draw — a
  // tree's hub going dark would read as the tree disconnecting, not breathing.
  const EXCLUSIVE_X = 150;
  const treeOfY = (y: number): number => (y < 23 ? 0 : y < 46 ? 1 : 2);
  const hubRects = [qfpTop.rect, qfpMid.rect, qfpBot.rect];
  const isHub = (c: Comp) => hubRects.some(h => h.x === c.rect.x && h.y === c.rect.y);
  const exclusives: Exclusive[] = comps
    .filter(c => c.rect.x >= EXCLUSIVE_X)
    .map(c => ({
      comp: c, tree: treeOfY(c.rect.y), breather: false,
      // Normalised position across the component field — a proxy for when this
      // tree's reveal reaches it (the cascade is left-to-right by construction).
      reach: Math.max(0, Math.min(1, (c.rect.x - 8) / 188)),
    }));
  for (let tree = 0; tree < 3; tree++) {
    const pool = exclusives.filter(e => e.tree === tree && !isHub(e.comp));
    for (const e of shuffled(rng, pool).slice(0, Math.min(pool.length, randInt(rng, 1, 2)))) e.breather = true;
  }
  if (process.env.PROTO_DEBUG)
    console.error(`  exclusives: ${exclusives.length} (breathers: ${exclusives.filter(e => e.breather)
      .map(e => `t${e.tree}@${e.comp.rect.x},${e.comp.rect.y}`).join(' ')})`);

  // Alive-state fixtures (spec §12.5): idle-animation hardware at fixed
  // floorplan anchors. Every period is an integer divisor of IDLE_LOOP (60),
  // which itself divides T — so the whole idle vocabulary is seam-exact.
  const alive: Alive = {
    fan: { x: 68, y: 8 }, // seated on the chipset heatsink — costs no floorplan area
    fanAccent: acc[2],  // the chipset module's own accent, so the pop reads as part of that block
    exclusives,
    leds: [
      { x: 188, y: 9, color: acc[0], period: 20, phase: 0 },
      { x: 183, y: 30, color: acc[2], period: 30, phase: 7 },
      { x: 188, y: 51, color: acc[3], period: 15, phase: 3 },
      { x: 90, y: 30, color: acc[4], period: 60, phase: 11 },
      { x: 129, y: 31, color: acc[3], period: 12, phase: 5 },
      { x: 76, y: 7, color: acc[2], period: 30, phase: 19 },
    ],
    blips: [
      { x: dimmX + 1, y: 30, w: 1, h: 1, color: acc[1], period: 30, phase: 0 },
      { x: dimmX + 7, y: 36, w: 1, h: 1, color: acc[1], period: 30, phase: 13 },
      { x: 123, y: 11, w: 2, h: 1, color: acc[1], period: 60, phase: 5 },
      { x: 133, y: 11, w: 2, h: 1, color: acc[1], period: 60, phase: 29 },
      { x: 87, y: 30, w: 1, h: 1, color: acc[4], period: 20, phase: 9 },
      { x: 181, y: 33, w: 2, h: 1, color: acc[2], period: 60, phase: 41 },
    ],
  };
  return { comps, nets, silk, dressing, alive, pulse: pulseNet ? { path: pulseNet.spine, color: pulseNet.color } : undefined };
}

// ---------- Variants B and C: the anonymous-component language ------------
interface AbstractCfg {
  padW: number; padH: number; hubW: number; hubH: number; stub: number;
  trunkBrush: number; branchBrush: number; style: 'chunky' | 'thin';
  sectionBoxes: boolean;
  dressing: { hatch: [number, number]; foot: [number, number]; fid: [number, number]; tp: [number, number] };
  padXMax: number; stubsPerGroup: number; fillerPerBand: number;
}

function buildAbstract(rng: Rng, occ: Occ, cfg: AbstractCfg): Scene {
  const acc = shuffled(rng, ACCENT_LIST);
  const comps: Comp[] = [];
  const silk: Draw[] = [];
  const nets: Net[] = [];
  const bands = [{ y0: 6, y1: 22 }, { y0: 26, y1: 42 }, { y0: 46, y1: 62 }];
  const counts = [2, 2, 1];

  interface Group { color: string; pads: Rect[]; hub: Rect; band: number }
  const groups: Group[] = [];
  const placed: Rect[] = [];
  const fits = (r: Rect): boolean => {
    if (r.x < 8 || r.x + r.w > 222 || r.y < 6 || r.y + r.h > 62) return false;
    if (placed.some(p => r.x < p.x + p.w + 4 && p.x < r.x + r.w + 4 && r.y < p.y + p.h + 4 && p.y < r.y + r.h + 4)) return false;
    for (let y = r.y - 1; y < r.y + r.h + 1; y++)
      for (let x = r.x - 1; x < r.x + r.w + 1; x++) if (occ.blockedAt(x, y)) return false;
    return true;
  };
  const sample = (w: number, h: number, xMin: number, xMax: number, yMin: number, yMax: number): Rect | null => {
    for (let a = 0; a < 300; a++) {
      const r = { x: randInt(rng, xMin, xMax - w), y: randInt(rng, yMin, yMax - h), w, h };
      if (fits(r)) return r;
    }
    return null;
  };

  let padIdx = 0;
  const hubZones = [[110, 165], [130, 180], [100, 155]];
  for (let b = 0; b < 3; b++) {
    const pads: Rect[] = [];
    // Hub first, then its pads strictly *west* of it: the board's flow is
    // pad -> hub -> connector, all eastward. Sampling pads independently let a
    // pad land east of its own hub, and the trunk then had to loop right around
    // the board to come back — the spaghetti that made the first B render
    // unreadable.
    const zone = hubZones[b];
    const hub = sample(cfg.hubW, cfg.hubH, zone[0], zone[1], bands[b].y0 + 1, bands[b].y1)
      ?? sample(cfg.hubW, cfg.hubH, 100, 190, bands[b].y0 + 1, bands[b].y1);
    if (!hub) continue;
    placed.push(hub);
    for (let n = 0; n < counts[b]; n++) {
      const r = sample(cfg.padW, cfg.padH, 10, Math.min(cfg.padXMax, hub.x - 26), bands[b].y0 + 1, bands[b].y1);
      if (r) { placed.push(r); pads.push(r); }
    }
    groups.push({ color: acc[padIdx % acc.length], pads, hub, band: b });
    padIdx += counts[b];
  }

  // component bodies
  const padColors = new Map<Rect, string>();
  groups.forEach((g, gi) => {
    g.pads.forEach((p, pi) => padColors.set(p, acc[(gi * 2 + pi) % acc.length]));
  });
  for (const g of groups) {
    for (const p of g.pads) {
      const color = padColors.get(p)!;
      comps.push(anonIC(p, color, cfg.style));
      comps.push(comp(p, ctx => {
        ctx.fillStyle = color;
        const midY = p.y + Math.floor(p.h / 2);
        for (const sx of [p.x - 1, p.x + p.w])
          for (const sy of [midY - 1, midY + 1]) cell(ctx, sx, sy, color);
      }));
    }
    comps.push(anonIC(g.hub, g.color, cfg.style));
    const hub = g.hub;
    comps.push(comp(hub, ctx => {
      ctx.fillStyle = g.color;
      for (let iy = hub.y + 1; iy < hub.y + hub.h - 1; iy += 2) { cell(ctx, hub.x - 1, iy, g.color); cell(ctx, hub.x + hub.w, iy, g.color); }
    }));
    if (cfg.sectionBoxes) {
      const r = { x: hub.x - 3, y: hub.y - 3, w: hub.w + 6, h: hub.h + 6 };
      silk.push(ctx => {
        ctx.strokeStyle = P.surface; ctx.lineWidth = 1;
        ctx.strokeRect(px(r.x) + 0.5, px(r.y) + 0.5, px(r.w) - 1, px(r.h) - 1);
      });
    }
  }

  // passive stubs
  const passives: { rect: Rect; group: number }[] = [];
  groups.forEach((g, gi) => {
    for (let i = 0; i < cfg.stubsPerGroup; i++) {
      const band = bands[g.band];
      const r = sample(cfg.stub, cfg.stub, Math.max(14, g.hub.x - 45), Math.min(190, g.hub.x + 30), band.y0 + 1, band.y1);
      if (!r) continue;
      placed.push(r);
      passives.push({ rect: r, group: gi });
      comps.push(anonIC(r, g.color, cfg.style));
      comps.push(comp(r, ctx => { cell(ctx, r.x - 1, r.y, g.color); cell(ctx, r.x + r.w, r.y + r.h - 1, g.color); }));
    }
  });

  // Unpopulated filler bodies: same anonymous language, dim (never accent), so
  // the board reads as a populated design rather than five parts on a plain.
  for (let b = 0; b < 3; b++) {
    for (let i = 0; i < cfg.fillerPerBand; i++) {
      // Filler hugs the top/bottom edges of its band so the band's middle rows
      // stay a clear routing corridor — trunks that had to detour around
      // mid-band filler read as loops, not bus work.
      const w = randInt(rng, 3, 6), h = randInt(rng, 3, 4);
      const top = rng() < 0.5;
      const yLo = top ? bands[b].y0 + 1 : bands[b].y1 - 4;
      const yHi = top ? bands[b].y0 + 5 : bands[b].y1;
      const r = sample(w, h, 12, 186, yLo, yHi);
      if (!r) continue;
      placed.push(r);
      comps.push(comp(r, ctx => {
        box(ctx, r.x, r.y, r.w, r.h, P.surface);
        frame(ctx, r.x, r.y, r.w, r.h, P.edge, 1);
        for (let iy = r.y + 1; iy < r.y + r.h - 1; iy += 2) { cell(ctx, r.x - 1, iy, P.edge); cell(ctx, r.x + r.w, iy, P.edge); }
      }));
    }
  }

  reserve(occ, comps);

  // Routing, in a fixed order per group so nets never steal each other's hub
  // approach: finger branches off the hub's east face first (they are the
  // structural ones), then pad trunks onto its west face at distinct rows,
  // then passive stubs off its south face.
  const add = (n: Net | null) => { if (n) nets.push(n); };
  groups.forEach((g, gi) => {
    const h = g.hub;
    const band = { yMin: bands[g.band].y0, yMax: bands[g.band].y1 };
    const east = [0, Math.floor(h.h / 2), h.h - 1].map(dy => ({ x: h.x + h.w + 1, y: h.y + dy }));
    const west = [1, h.h - 2].map(dy => ({ x: h.x - 1 - cfg.trunkBrush, y: h.y + dy }));
    const south = [1, Math.floor(h.w / 2), h.w - 2].map(dx => ({ x: h.x + dx, y: h.y + h.h + 1 }));
    for (let i = 0; i < 3; i++) {
      // A finger branch is structural — every finger must be fed. Try the
      // preferred landing row first, then the finger's other rows, then drop
      // the entry-direction constraint before giving up.
      const f = FINGERS.filter(q => q.band === g.band)[i];
      let net: Net | null = null;
      for (const dy of [1, 0, 2]) {
        const to = { x: 227 - cfg.branchBrush, y: f.y + (cfg.branchBrush === 1 ? dy : 0) };
        const last = dy === 2;
        net = trace(occ, east[i], to, g.color, { ...band, brush: cfg.branchBrush, turn: 18, chamfer: 2, startDir: 0, endDir: 0, optional: true })
          ?? trace(occ, east[i], to, g.color, { ...band, brush: cfg.branchBrush, turn: 18, chamfer: 2, optional: !last });
        if (net) break;
      }
      add(net);
    }
    g.pads.forEach((p, pi) => {
      add(trace(occ, { x: p.x + p.w + 1, y: p.y + Math.floor(p.h / 2) }, west[pi % west.length],
        padColors.get(p)!, { ...band, brush: cfg.trunkBrush, turn: 22, chamfer: 2, startDir: 0 }));
    });
    passives.filter(q => q.group === gi).forEach((ps, i) => {
      add(trace(occ, south[i % south.length], { x: ps.rect.x - 2, y: ps.rect.y }, g.color,
        { brush: cfg.branchBrush, turn: 18, chamfer: 2, startDir: 2 }));
    });
  });

  const dressing = buildDressing(rng, occ, cfg.dressing);
  if (cfg.sectionBoxes) {
    silk.push(ctx => {
      ctx.strokeStyle = P.surface; ctx.lineWidth = 1;
      for (const b of bands) ctx.strokeRect(px(8) + 0.5, px(b.y0 - 1) + 0.5, px(214) - 1, px(b.y1 - b.y0 + 2) - 1);
    });
  }
  const pulseNet = nets.length ? nets[randInt(rng, 0, nets.length - 1)] : undefined;
  return { comps, nets, silk, dressing, pulse: pulseNet ? { path: pulseNet.spine, color: pulseNet.color } : undefined };
}

const CFG_B: AbstractCfg = {
  padW: 4, padH: 6, hubW: 6, hubH: 8, stub: 3,
  trunkBrush: 2, branchBrush: 1, style: 'chunky', sectionBoxes: true,
  dressing: { hatch: [4, 6], foot: [16, 22], fid: [7, 10], tp: [7, 10] }, padXMax: 90, stubsPerGroup: 3, fillerPerBand: 6,
};
const CFG_C: AbstractCfg = {
  padW: 3, padH: 5, hubW: 5, hubH: 7, stub: 2,
  trunkBrush: 1, branchBrush: 1, style: 'thin', sectionBoxes: false,
  dressing: { hatch: [2, 4], foot: [5, 9], fid: [3, 5], tp: [3, 5] }, padXMax: 150, stubsPerGroup: 2, fillerPerBand: 0,
};

// ---------------------------------------------------------------------------
// Connection propagation (the power-on cascade)
// ---------------------------------------------------------------------------
//
// "Colors dynamically route toward the connector, building to the interface,
// lighting up components as the board connects together" (Cody, 2026-07-24).
//
// Model: the union of trace cells and component footprints is one conductive
// graph. Every cell gets a **connection distance** — a Dijkstra distance
// measured *along the copper*, seeded at the westmost cell of each connected
// island with an initial value equal to that cell's own x offset from the
// board's left edge. So distance ≈ "how far east along the copper you are", and
// the reveal frontier sweeps left-to-right, following the actual routing rather
// than a flat wipe. Islands with no trace (an isolated passive) still fall into
// the same left-to-right order via their seed offset.
//
// Pure function of the built scene — no rng, no time. The animation timeline
// consumes it as f(t) (see spec §12).
const BOARD_LEFT = 7;

export function connectionDistance(scene: Scene): { dist: Int32Array; max: number } {
  const INF = 0x7fffffff;
  const n = GRID_W * GRID_H;
  const cond = new Uint8Array(n);
  const mark = (x: number, y: number) => {
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) cond[y * GRID_W + x] = 1;
  };
  for (const net of scene.nets) for (const c of net.cells) mark(c.x, c.y);
  for (const c of scene.comps)
    for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++)
      for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) mark(x, y);

  const dist = new Int32Array(n).fill(INF);
  const heap = new Heap();
  // Seed: per conductive island, every cell sharing that island's minimum x.
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (!cond[s] || seen[s]) continue;
    const island: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      island.push(i);
      const x = i % GRID_W, y = (i - (i % GRID_W)) / GRID_W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        const j = ny * GRID_W + nx;
        if (cond[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    const minX = Math.min(...island.map(i => i % GRID_W));
    for (const i of island)
      if (i % GRID_W === minX) {
        const d = Math.max(0, minX - BOARD_LEFT);
        dist[i] = d;
        heap.push(d * 1000000 + i);
      }
  }
  while (heap.size > 0) {
    const packed = heap.pop()!;
    const i = packed % 1000000, d = (packed - i) / 1000000;
    if (d > dist[i]) continue;
    const x = i % GRID_W, y = (i - (i % GRID_W)) / GRID_W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const j = ny * GRID_W + nx;
      if (!cond[j] || d + 1 >= dist[j]) continue;
      dist[j] = d + 1;
      heap.push((d + 1) * 1000000 + j);
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (dist[i] !== INF && dist[i] > max) max = dist[i];
  return { dist, max };
}

// ---------------------------------------------------------------------------
// Alive state (spec §12.5): once a region is fully connected the board must
// read as *running*, not merely lit — "dynamically alive, flowing, flashing,
// blinking, rotating, etc connected to the life spawning at connectors"
// (Cody, 2026-07-24).
//
// Every element below is a pure periodic function of the frame index with a
// period that divides IDLE_LOOP, and IDLE_LOOP divides T — so the whole idle
// vocabulary is seam-exact by construction, with no stored state.
// ---------------------------------------------------------------------------
const IDLE_LOOP = 60;        // frames; every idle period divides this, and this divides T=360
const FAN_STEP_FRAMES = 5;   // 4 blade steps x 5 frames = 20-frame rotation
const FLOW_WAVELENGTH = 30;  // cells between crests
const FLOW_CREST = 6;        // cells of crest per bus
const FLOW_BUSES = 6;        // restraint cap: at most this many trunks carry a wave
const EMIT_PERIOD = 6;       // frames between spill emissions — the binding 2 px/s cadence
const SPILL_IN_FLIGHT = 4;   // pixels visible mid-flight per emitting finger
const T_LOOP = 360;          // the spec loop, 30 s at 12 fps — the recycle timebase
const DIM_WINDOW = 30;       // T/12: §11's dim & recycle slice
const DIM_START = T_LOOP - DIM_WINDOW;
const ROUTE_FRAMES = T_LOOP / 6; // §11's route phase — how long a reveal takes to cross
const HALF_RUNG = 0.5;       // half a palette rung per frame: 1-rung move = 2 frames, 2-rung = 4

/** 4-blade pinwheel on a 6x6 footprint inside an 8x8 shroud; `step` 0..3 advances
 * it 22.5 degrees, so four steps complete the blades' 90-degree rotational
 * symmetry. The 2x2 hub is the fan's accent pop (Cody, 2026-07-24) — a small
 * deliberate spot of color at the centre of the rotation, rather than accent on
 * the blades themselves, which would smear into noise as they turn. */
function drawFan(ctx: Ctx, at: Pt, step: number, level: number, accent: string): number {
  const T = tonesFor(level, accent);
  let drawn = 0;
  const cx = at.x + 2.5, cy = at.y + 2.5;
  frame(ctx, at.x - 1, at.y - 1, 8, 8, T.body, 1); // shroud
  for (let y = at.y; y < at.y + 6; y++)
    for (let x = at.x; x < at.x + 6; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r < 0.9) { cell(ctx, x, y, acc(T)); drawn++; continue; } // hub — the accent pop
      if (r > 3.2) continue;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 360 + step * 22.5;
      if (deg % 90 < 45) { cell(ctx, x, y, T.metal); drawn++; }
    }
  return drawn;
}

/** The fan as a placed component — static blades (step 0) in stills, re-drawn
 * rotating by the alive-state overlay. */
function fanComp(x: number, y: number, accent: string): Comp {
  return comp({ x: x - 1, y: y - 1, w: 8, h: 8 }, (ctx, level) => { drawFan(ctx, { x, y }, 0, level, accent); });
}

/**
 * Draws one frame of idle animation over the fully-lit board. Returns the
 * number of cells it touched, which is the measured quantity the §12 restraint
 * cap is expressed in.
 */
function drawAlive(ctx: Ctx, scene: Scene, t: number, creature: PosedCreature): number {
  const a = scene.alive;
  if (!a) return 0;
  let cells = 0;
  const cyc = (p: number, off = 0): number => (((t + off) % p) + p) % p;

  // --- rotating fan -------------------------------------------------------
  cells += drawFan(ctx, a.fan, Math.floor(cyc(FAN_STEP_FRAMES * 4) / FAN_STEP_FRAMES), LEVEL_LIT, a.fanAccent);

  // --- status LEDs: slow, phase-offset blink, 1 cell each -----------------
  for (const led of a.leds) {
    if (cyc(led.period, led.phase) >= led.period / 3) continue;
    cell(ctx, led.x, led.y, led.color);
    cells++;
  }

  // --- memory / chipset activity blips: 2 frames on, 1-2 cells ------------
  for (const b of a.blips) {
    if ((t + b.phase) % b.period >= 2) continue;
    box(ctx, b.x, b.y, b.w, b.h, b.color);
    cells += b.w * b.h;
  }

  // --- bus flow: a dim brightness crest travelling downstream (eastward,
  //     toward the interface) along the widest trunks. Uses the already
  //     sanctioned 80% dim, so it adds no palette entry, and it is a
  //     brightness change on cells that are already lit — not new coverage.
  const covered = (x: number, y: number) => scene.comps.some(c =>
    x >= c.rect.x && x < c.rect.x + c.rect.w && y >= c.rect.y && y < c.rect.y + c.rect.h);
  const trunks = scene.nets.filter(n => n.weight >= 2)
    .sort((p, q) => q.spine.length - p.spine.length).slice(0, FLOW_BUSES);
  for (const net of trunks) {
    const head = (t * FLOW_WAVELENGTH) / IDLE_LOOP; // one wavelength per IDLE_LOOP
    for (let i = 0; i < net.spine.length; i++) {
      if (((i - head) % FLOW_WAVELENGTH + FLOW_WAVELENGTH) % FLOW_WAVELENGTH >= FLOW_CREST) continue;
      const p = net.spine[i];
      for (let dy = 0; dy < net.weight; dy++)
        for (let dx = 0; dx < net.weight; dx++) {
          if (covered(p.x + dx, p.y + dy)) continue;
          cell(ctx, p.x + dx, p.y + dy, mixOnBg(net.color, 0.8));
          cells++;
        }
    }
  }

  // --- recycle: one periodic model, mod T (spec §12.6). For a tree-exclusive
  //     component, its tree's cycle position decides its rung:
  //       c >= DIM_START            -> base   (dim & recycle window)
  //       c <  reach                -> base   (this cycle's reveal hasn't got there yet)
  //       otherwise                 -> lit    (complete)
  //     base is MID for an ordinary exclusive ("mostly stay lit" — one rung down,
  //     never dark) and UNLIT for a seeded breather ("sometimes dim"). Shared
  //     components are not in this list at all and are genuinely constant.
  //     The ladder is walked at HALF_RUNG per frame, so a 2-rung move takes 4
  //     frames and a 1-rung move 2. Everything here is a pure function of
  //     (t mod T) — seam-exact, no stored state.
  for (const e of a.exclusives) {
    const c = ((t + e.tree * (T_LOOP / 3)) % T_LOOP + T_LOOP) % T_LOOP;
    const reach = e.reach * ROUTE_FRAMES;
    const base = e.breather ? LEVEL_UNLIT : LEVEL_MID;
    // Closed-form ramp at HALF_RUNG per frame, in both directions: no stored
    // state, and *every* exclusive ramps — an ordinary one's lit->mid takes two
    // frames just as a breather's lit->unlit takes four. Nothing pops.
    let level: number;
    if (c >= DIM_START) level = Math.max(base, LEVEL_LIT - HALF_RUNG * (c - DIM_START + 1));
    else if (c < reach) level = base;
    else level = Math.min(LEVEL_LIT, base + HALF_RUNG * (c - reach + 1));
    if (level >= LEVEL_LIT) continue;                     // already drawn lit
    e.comp.draw(ctx, level);
    cells += e.comp.rect.w * e.comp.rect.h;
  }

  // --- connector coupling: the activity visibly feeds the life at the
  //     interface. On each emission frame the source finger shows a
  //     **2-cell** gold lift (#8a7a2f -> #d4b83a) for one frame and a pixel
  //     leaves it, drifting toward the creature's assembly site. The lift is
  //     deliberately sub-transient — 2 cells, one frame, one gold step, never
  //     white — so it does not consume the flash budget (§12.6). This is visual
  //     correlation layered on §11's binding 2 px/s cadence; the emission
  //     mechanic itself is unchanged.
  //     One posed creature => one emitter: the primary finger nearest it.
  const primaries = FINGERS.filter(f => f.index === 0);
  const target = { x: creature.ox + 5, y: creature.oy + 6 };
  const src = primaries.reduce((best, f) =>
    Math.abs(f.y - target.y) < Math.abs(best.y - target.y) ? f : best, primaries[0]);
  if (t % EMIT_PERIOD === 0) {
    box(ctx, src.x + FINGER_W - 2, src.y + 1, 2, 1, P.goldLit);
    cells += 2;
  }
  for (let k = 0; k < SPILL_IN_FLIGHT; k++) {
    const age = (t % EMIT_PERIOD) + k * EMIT_PERIOD;
    const u = age / (EMIT_PERIOD * SPILL_IN_FLIGHT);
    const x = Math.round(src.x + FINGER_W + 1 + (target.x - src.x - FINGER_W - 1) * u);
    const y = Math.round(src.y + 1 + (target.y - src.y - 1) * u);
    if (x <= BOARD_RIGHT + 1) continue;
    cell(ctx, x, y, creature.color);
    cells++;
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
/**
 * `phase` is the fraction of full connection, 0..1. At phase >= 1 the reveal
 * frontier is past every cell and this function takes exactly the steady-state
 * path — so `--phase 1` is byte-identical to the approved portrait rendered
 * without the flag. Phase consumes no rng, so the stream is unperturbed at any
 * phase.
 */
function renderCanvas(variant: 'A' | 'B' | 'C', seed: number, phase = 1, aliveFrame?: number): Canvas {
  registerFonts();
  const rng = mulberry32(seed);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const occ = baseOcc();

  const scene = variant === 'A' ? buildA(rng, occ)
    : buildAbstract(rng, occ, variant === 'B' ? CFG_B : CFG_C);

  const partial = phase < 1;
  const conn = partial ? connectionDistance(scene) : null;
  const frontier = conn ? phase * conn.max : Infinity;
  const distAt = (x: number, y: number): number =>
    conn ? conn.dist[y * GRID_W + x] : 0;
  const reached = (x: number, y: number): boolean => distAt(x, y) <= frontier;
  const compLit = (c: Comp): boolean => {
    if (!conn) return true;
    for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++)
      for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) if (reached(x, y)) return true;
    return false;
  };
  // A finger has arrived once revealed copper occupies its footprint.
  const fingerArrival = (f: typeof FINGERS[number]): number => {
    let best = Infinity;
    for (let y = f.y; y < f.y + f.h; y++)
      for (let x = f.x; x < f.x + FINGER_W; x++) {
        const d = distAt(x, y);
        if (d < best) best = d;
      }
    return best;
  };
  const ARRIVAL_WINDOW = 14; // cells of frontier travel — the "just landed" flash window

  drawSubstrate(ctx);
  for (const h of MOUNT_HOLES) drawMountHole(ctx, h);
  if (!process.env.PROTO_NODRESS) drawDressing(ctx, scene.dressing);
  for (const s of scene.silk) s(ctx, LEVEL_LIT);

  // traces below components (they run under the hardware, as on a real board)
  // Trace bodies at exactly the spec-sanctioned 60% accent-on-background dim —
  // no new palette entry is introduced by the routing layer.
  for (const n of scene.nets)
    for (const c of n.cells) {
      if (!reached(c.x, c.y)) continue;
      cell(ctx, c.x, c.y, mixOnBg(n.color, 0.6));
    }
  for (const c of scene.comps) c.draw(ctx, compLit(c) ? LEVEL_LIT : LEVEL_UNLIT);

  const rngLitFinger = randInt(rng, 0, FINGERS.length - 1);
  if (partial) {
    FINGERS.forEach((f, i) => {
      const a = fingerArrival(f);
      const justLanded = a <= frontier && a > frontier - ARRIVAL_WINDOW;
      box(ctx, f.x, f.y, FINGER_W, f.h, justLanded ? P.goldLit : P.gold);
    });
  } else {
    drawConnector(ctx, rngLitFinger);
  }

  if (scene.pulse && scene.pulse.path.length > 6) {
    const head = randInt(rng, 6, scene.pulse.path.length - 1);
    // A pulse only travels copper that is already carrying — suppress it while
    // its own net is still growing.
    const netLive = scene.pulse.path.every(p => reached(p.x, p.y));
    if (netLive)
      for (let d = 0; d <= 6; d++) {
        const p = scene.pulse.path[head - d];
        if (!p) continue;
        cell(ctx, p.x, p.y, d < 1 ? P.white : d < 4 ? mixOnBg(scene.pulse.color, 0.8) : mixOnBg(scene.pulse.color, 0.35));
      }
  }

  // Creature: shed from the connector, so it only exists once a finger has
  // actually been reached (§11 "arrival triggers the spill").
  const creature = poseCreature(rng, pick(rng, ACCENT_LIST));
  if (!partial || FINGERS.some(f => fingerArrival(f) <= frontier)) drawCreature(ctx, creature);
  // Alive state: only over a fully-connected board, and opt-in, so the approved
  // still stays byte-identical when the flag is absent.
  if (aliveFrame !== undefined && !partial) {
    aliveCellCount = drawAlive(ctx, scene, aliveFrame, creature);
    aliveCellMax = Math.max(aliveCellMax, aliveCellCount);
  }
  // The legend lights with the first region's cascade (§12.7).
  drawTextLayer(ctx, seed, !partial || FINGERS.some(f => fingerArrival(f) <= frontier));
  return canvas;
}

/** Cells touched by the most recent alive-state overlay, and the running max
 * across a rendered loop — the measured quantity §12's restraint cap is
 * expressed in. */
let aliveCellCount = 0;
let aliveCellMax = 0;

const render = (variant: 'A' | 'B' | 'C', seed: number, phase = 1, aliveFrame?: number): Buffer =>
  renderCanvas(variant, seed, phase, aliveFrame).toBuffer('image/png');

/** Contact sheet: several full-size frames stacked vertically. */
function contactSheet(frames: Canvas[]): Buffer {
  const gap = 4;
  const canvas = createCanvas(WIDTH, HEIGHT * frames.length + gap * (frames.length - 1));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = P.dim; // sheet divider — contact-sheet chrome, not board art
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  frames.forEach((f, i) => ctx.drawImage(f, 0, i * (HEIGHT + gap)));
  return canvas.toBuffer('image/png');
}

const renderStrip = (seed: number, phases: number[]): Buffer =>
  contactSheet(phases.map(p => renderCanvas('A', seed, p)));

const renderAliveStrip = (seed: number, frames: number[]): Buffer =>
  contactSheet(frames.map(f => renderCanvas('A', seed, 1, f)));

/** Looping GIF of the alive state at full power — one IDLE_LOOP, 12 fps. */
function renderAliveGif(seed: number, frameCount: number, fps: number): Uint8Array {
  const buffers: Uint8ClampedArray[] = [];
  // PROTO_FREEZE / PROTO_NOGRID / PROTO_NODRESS exist to reproduce §12.6.4's
  // GIF size attribution: they hold the animation still, or drop the grid or the
  // dressing, so each contributor's share of the encoded size can be measured.
  const freeze = process.env.PROTO_FREEZE ? Number(process.env.PROTO_FREEZE) : null;
  for (let t = 0; t < frameCount; t++) {
    const c = renderCanvas('A', seed, 1, freeze ?? t);
    buffers.push(c.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data);
  }
  return encodeGif(buffers, WIDTH, HEIGHT, fps);
}

function main(): void {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? '' : next;
  }
  const variant = (args.variant ?? 'C').toUpperCase() as 'A' | 'B' | 'C';
  if (!['A', 'B', 'C'].includes(variant)) throw new Error(`--variant must be A, B or C (got ${args.variant})`);
  const seed = Number(args.seed ?? 20260724);
  const phase = args.phase === undefined ? 1 : Math.max(0, Math.min(1, Number(args.phase)));
  if (Number.isNaN(phase)) throw new Error(`--phase must be a number in 0..1 (got ${args.phase})`);
  if (args.phase !== undefined && variant !== 'A')
    throw new Error('--phase is variant A only (the connection-lighting model is A\'s)');

  if (args.strip !== undefined) {
    const phases = [0.25, 0.6, 1.0];
    const out = args.strip || `review/phases-A-${seed}.png`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderStrip(seed, phases));
    console.log(`wrote ${out}  (phases ${phases.join(', ')})`);
    return;
  }

  if (args.alivestrip !== undefined) {
    const frames = [0, 7, 14];
    const out = args.alivestrip || `review/alive-A-${seed}.png`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderAliveStrip(seed, frames));
    console.log(`wrote ${out}  (idle frames ${frames.join(', ')}; ${aliveCellCount} cells animated in the last frame)`);
    return;
  }

  if (args.measure !== undefined) {
    // Honest restraint measurement: cells whose colour actually differs from the
    // fully-lit steady-state frame, sampled at cell granularity across the loop.
    const steady = renderCanvas('A', seed, 1).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
    const at = (d: Uint8ClampedArray, cx: number, cy: number) => {
      const i = ((cy * CELL) * WIDTH + cx * CELL) * 4;
      return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    };
    let max = 0, sum = 0, argmax = 0;
    for (let t = 0; t < T_LOOP; t++) {
      const f = renderCanvas('A', seed, 1, t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
      let n = 0;
      for (let cy = 0; cy < GRID_H; cy++)
        for (let cx = 0; cx < GRID_W; cx++) if (at(steady, cx, cy) !== at(f, cx, cy)) n++;
      sum += n;
      if (n > max) { max = n; argmax = t; }
    }
    const pct = (v: number) => (100 * v / (GRID_W * GRID_H)).toFixed(2);
    console.log(`measured over ${T_LOOP} frames: peak ${max} cells (${pct(max)}% of canvas) at frame ${argmax}; mean ${(sum / T_LOOP).toFixed(1)} cells (${pct(sum / T_LOOP)}%)`);
    return;
  }

  if (args.gif !== undefined) {
    const out = args.gif || `review/alive-A-${seed}.gif`;
    mkdirSync(dirname(out), { recursive: true });
    // Default to the full T=360 loop: the recycle breath (§12.6) lives on that
    // timebase, so a 60-frame idle-only loop would never show it.
    const frames = args.frames ? Number(args.frames) : T_LOOP;
    writeFileSync(out, renderAliveGif(seed, frames, 12));
    console.log(`wrote ${out}  (${frames} frames @ 12fps; peak ${aliveCellMax} cells animated in a frame, ${(100 * aliveCellMax / (GRID_W * GRID_H)).toFixed(2)}% of canvas)`);
    return;
  }

  const out = args.out ?? `review/portrait-${variant}-${seed}.png`;
  mkdirSync(dirname(out), { recursive: true });
  const aliveFrame = args.alive === undefined ? undefined : Number(args.alive);
  writeFileSync(out, render(variant, seed, phase, aliveFrame));
  console.log(`wrote ${out}${phase < 1 ? `  (phase ${phase})` : ''}${routeFailures ? `  (${routeFailures} routes failed)` : ''}`);
}

// Run the CLI only when this file is the entry point — `proto-dynamics.ts`
// imports the board builder from here.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
