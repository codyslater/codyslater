import type { BoardComponent, Cell, Net, Rect } from './types.js';
import {
  FINGER_W, FINGERS, GRID_H, GRID_W, HUB_RECTS, MOUNT_HOLES, TEXT_ZONES, type Layout,
} from './layout.js';

// ---------------------------------------------------------------------------
// growth.ts — the deterministic net-path builder (§13.6: "retire, or reduce to
// static routing. Whatever survives becomes the deterministic net-path builder
// feeding the graph").
//
// §13.1 retires §11's three disjoint acyclic trees: "a colour cannot travel
// through intricate pathways and reroute on a tree, and with three disjoint
// trees only the middle band's hub could reach the connector at all, so every
// escape came out of the middle finger group." What replaces the tree planner is
// a fixed bus plan laid on §12.2's floorplan by a turn-penalised rectilinear
// router, plus an explicit set of cross-region trunks that CLOSE LOOPS — the
// hub spine tying the three bands into one circuit, and the gutter runs that
// put each hub inside a cycle.
//
// §12.4's routing discipline is carried unchanged and is what this file
// implements: rectilinear-dominant committed runs, 45° chamfers of 1-3 cells,
// 1-cell clearance between distinct nets, trunk 2 cells / branch 1 cell, bundle
// pitches, the 4-cell landing overshoot drawn under the body it lands on, the
// determinism gradient (expressed here as the router's per-net turn penalty:
// high near the origins, lower approaching the connector), connector approach
// lanes and hub assignments.
//
// Nothing here reads the clock and nothing here draws from an rng stream: the
// plan is a pure function of the (seeded) floorplan, which is exactly §12.8's
// "routing detail within the fixed lanes" varying by seed.
// ---------------------------------------------------------------------------

/** Board interior the router may use: §12.2's component field plus the fanout
 * zone, inset from the physical board edge. */
const ROUTE_X_MIN = 7, ROUTE_X_MAX = 226, ROUTE_Y_MIN = 6, ROUTE_Y_MAX = 63;

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
  /** Is the `brush`×`brush` footprint anchored at (x,y) entirely free? */
  brushFree(x: number, y: number, brush: number): boolean {
    for (let dy = 0; dy < brush; dy++)
      for (let dx = 0; dx < brush; dx++) if (this.blockedAt(x + dx, y + dy)) return false;
    return true;
  }
}

const DIRS: Cell[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

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

interface RouteOpts {
  brush?: number; turn?: number; endDir?: number; startDir?: number; yMin?: number; yMax?: number;
}

/**
 * Shortest turn-penalised rectilinear path from `from` to `to`, or null.
 *
 * The turn penalty is §11's routing character made mechanical: at `turn = 16+` a
 * corner costs as much as sixteen cells of straight run, so the router commits
 * to long straight legs and turns only where it must. §11's determinism gradient
 * is expressed by giving nets near the board's origins a higher penalty than
 * nets approaching the connector (see the per-net `turn` values below).
 */
function routeCells(occ: Occ, from: Cell, to: Cell, opts: RouteOpts = {}): Cell[] | null {
  const brush = opts.brush ?? 1, turn = opts.turn ?? 16;
  const yMin = opts.yMin ?? 0, yMax = opts.yMax ?? GRID_H - 1;
  const N = GRID_W * GRID_H * 4;
  const dist = new Int32Array(N).fill(0x7fffffff);
  const prev = new Int32Array(N).fill(-1);
  const enc = (x: number, y: number, d: number): number => (y * GRID_W + x) * 4 + d;
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
      if (ny < yMin || ny + brush - 1 > yMax) continue;
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
  const out: Cell[] = [];
  for (let s = goal; s >= 0; s = prev[s]) {
    const d = s & 3, ci = (s - d) / 4;
    out.push({ x: ci % GRID_W, y: (ci - (ci % GRID_W)) / GRID_W });
  }
  return out.reverse();
}

/** Collapse a dense cell path down to its corner waypoints. */
function toWaypoints(cells: Cell[]): Cell[] {
  if (cells.length < 3) return cells.slice();
  const out: Cell[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = cells[i - 1], b = cells[i], c = cells[i + 1];
    if ((b.x - a.x) !== (c.x - b.x) || (b.y - a.y) !== (c.y - b.y)) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Rectilinear polyline → cells, mitering every interior corner into a 45°
 * chamfer of up to `amount` cells (§12.4). */
function chamfer(poly: Cell[], amount: number): Cell[] {
  if (poly.length < 2) return poly.slice();
  const out: Cell[] = [];
  const push = (p: Cell): void => {
    const l = out[out.length - 1];
    if (!l || l.x !== p.x || l.y !== p.y) out.push({ ...p });
  };
  const legLen = (i: number): number => Math.abs(poly[i + 1].x - poly[i].x) + Math.abs(poly[i + 1].y - poly[i].y);
  let cursor = { ...poly[0] };
  for (let i = 0; i < poly.length - 1; i++) {
    const d0 = { x: sgn(poly[i + 1].x - poly[i].x), y: sgn(poly[i + 1].y - poly[i].y) };
    const isLast = i === poly.length - 2;
    let end = { ...poly[i + 1] };
    if (!isLast && amount > 0) {
      const d1 = { x: sgn(poly[i + 2].x - poly[i + 1].x), y: sgn(poly[i + 2].y - poly[i + 1].y) };
      const k = Math.min(amount, Math.floor((legLen(i) - 1) / 2), Math.floor((legLen(i + 1) - 1) / 2));
      if (k > 0) {
        end = { x: poly[i + 1].x - k * d0.x, y: poly[i + 1].y - k * d0.y };
        for (let p = { ...cursor }; ; p = { x: p.x + d0.x, y: p.y + d0.y }) {
          push(p);
          if (p.x === end.x && p.y === end.y) break;
        }
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

/** Widen a cell path with a `brush`×`brush` square brush (§12.4's 2-cell trunk). */
function widen(cells: Cell[], brush: number): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
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

/**
 * Push both ends of a spine `n` cells further along their terminal direction —
 * §12.4's landing overshoot. Routing endpoints sit a couple of cells clear of a
 * component (brush + clearance), which would otherwise leave a visible gap
 * between trace and pin; the overshoot is drawn *under* the component body (and
 * under the connector gold), so the trace reads as landing on the pin.
 *
 * The overshoot is deliberately NOT part of `spine`: §13.1's graph, fabric and
 * flows all key off the spine, and the fabric's canonical stub is what bridges
 * the remaining gap to the node's centre.
 */
function extendSpine(spine: Cell[], n: number): Cell[] {
  if (spine.length < 2 || n <= 0) return spine;
  const head: Cell[] = [], tail: Cell[] = [];
  const last = spine.length - 1;
  const d0 = { x: sgn(spine[0].x - spine[1].x), y: sgn(spine[0].y - spine[1].y) };
  const d1 = { x: sgn(spine[last].x - spine[last - 1].x), y: sgn(spine[last].y - spine[last - 1].y) };
  for (let i = 1; i <= n; i++) {
    head.unshift({ x: spine[0].x + d0.x * i, y: spine[0].y + d0.y * i });
    tail.push({ x: spine[last].x + d1.x * i, y: spine[last].y + d1.y * i });
  }
  return [...head, ...spine, ...tail];
}

type TraceOpts = RouteOpts & { chamfer?: number; clearance?: number; extend?: number };

/** Route + chamfer + widen + reserve. Returns null when no legal path exists. */
function trace(occ: Occ, from: Cell, to: Cell, color: string, opts: TraceOpts = {}): Net | null {
  const brush = opts.brush ?? 1;
  // Try the constrained route first (fixed exit/entry faces keep sibling nets off
  // each other's hub anchors); fall back to a free route rather than dropping the
  // net entirely.
  const raw = routeCells(occ, from, to, opts)
    ?? ((opts.startDir !== undefined || opts.endDir !== undefined)
      ? routeCells(occ, from, to, { ...opts, startDir: undefined, endDir: undefined })
      : null);
  if (!raw) return null;
  const wp = toWaypoints(raw);
  let spine = chamfer(wp, opts.chamfer ?? 2);
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
 * same few columns. §12.4: these reserve their own clearance but are not
 * themselves collision-checked.
 */
function manual(occ: Occ, poly: Cell[], color: string, opts: { brush?: number; chamfer?: number; extend?: number } = {}): Net {
  const brush = opts.brush ?? 1;
  const spine = chamfer(poly, opts.chamfer ?? 2);
  for (const c of widen(spine, brush))
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) occ.block(c.x + dx, c.y + dy);
  return { cells: widen(extendSpine(spine, opts.extend ?? 4), brush), color, spine, weight: brush };
}

/**
 * A parallel bus bundle (§12.4's "bundles"): route the first trace, then offset
 * its waypoint polyline diagonally by (d,d) per sibling so horizontal legs stay
 * parallel at pitch d AND vertical legs stay parallel at pitch d, and corners
 * turn together. Siblings that collide are re-routed independently rather than
 * dropped.
 */
function bundle(
  occ: Occ, from: Cell, to: Cell, color: string, count: number, pitch: number, opts: RouteOpts & { chamfer?: number } = {},
): Net[] {
  const brush = opts.brush ?? 1;
  const first = routeCells(occ, from, to, opts);
  const nets: Net[] = [];
  // Siblings inside one bundle pack tightly against each other (only their own
  // cells are reserved while the bundle is being laid); the 1-cell clearance halo
  // is applied once, around the finished bundle, so *other* nets keep their
  // distance but the bus itself can run at its intended pitch.
  const own: Cell[] = [];
  const emit = (spineRaw: Cell[]): boolean => {
    const spine = chamfer(toWaypoints(spineRaw), opts.chamfer ?? 2);
    const cells = widen(spine, brush);
    if (cells.some(c => occ.blockedAt(c.x, c.y))) return false;
    for (const c of cells) { occ.block(c.x, c.y); own.push(c); }
    nets.push({ cells: widen(extendSpine(spine, 4), brush), color, spine, weight: brush });
    return true;
  };
  if (!first) return nets;
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
    const alt = routeCells(occ, off[0], off[off.length - 1], opts);
    if (alt) emit(alt);
  }
  for (const c of own)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) occ.block(c.x + dx, c.y + dy);
  return nets;
}

/** Every permanent obstacle: off-board margins, the three text zones (§13.5 —
 * THESIS_ZONE and REV_ZONE stay binding exclusion masks even though nothing is
 * printed in them any more), the four mount-hole keepouts and the connector
 * gold. Board dressing is deliberately absent: §11 explicitly allows traces to
 * run over it. */
function baseOcc(): Occ {
  const occ = new Occ();
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (x < ROUTE_X_MIN || x > ROUTE_X_MAX || y < ROUTE_Y_MIN || y > ROUTE_Y_MAX) occ.block(x, y);
  for (const z of TEXT_ZONES) occ.blockRect(z, 1);
  for (const h of MOUNT_HOLES) occ.blockRect({ x: h.x - 2, y: h.y - 2, w: 5, h: 5 });
  for (const f of FINGERS) occ.blockRect({ x: f.x, y: f.y, w: FINGER_W, h: f.h });
  return occ;
}

/** Reserve every component footprint with §12.4's 1-cell clearance. */
function reserve(occ: Occ, comps: readonly BoardComponent[]): void {
  for (const c of comps) occ.blockRect(c.rect, 1);
}

/** Trace landing cell just west of a finger; brush-aware so a 2-cell trunk's own
 * footprint stays on-board instead of overlapping the gold (§12.4). */
const fingerEntry = (band: number, idx: number, brush = 1): Cell => {
  const f = FINGERS.filter(g => g.band === band)[idx];
  return { x: 227 - brush, y: brush === 1 ? f.y + 1 : f.y };
};

/**
 * The board's whole routed circuit, as one bus plan.
 *
 * Structure, in the order it is laid (order matters: each net reserves its own
 * clearance, so earlier nets get first pick of the lanes they need):
 *
 *   1. the power/data buses of §12.4 — VRM → CPU, CPU ↔ DIMM, chipset ↔ DRAM,
 *      the bridge chain, the gutter-3 backbone;
 *   2. §13.1's cross-region links — the gutter-1 DRAM→row-T-hub trunk and the
 *      vertical hub spine — which are what make the routed graph ONE ISLAND
 *      with cycles rather than three disjoint trees;
 *   3. the connector fanout: three 2-cell trunks per finger group;
 *   4. the lower hub spine and the remaining short links, laid last so the
 *      fanout keeps first pick of its own lanes.
 *
 * The measured shape this produces is §13.1's requirement: all nine fingers plus
 * 20+ component nodes in one island of simple cycle rank >= 3.
 */
export function buildNets(layout: Layout): Net[] {
  const occ = baseOcc();
  reserve(occ, layout.components);

  const acc = layout.accents;
  const { nChoke, chokePitch, cpu, dimmX, qfpBig, qfp2 } = layout.floorplan;
  const qfp3 = HUB_RECTS[1];

  const nets: Net[] = [];
  const add = (n: Net | null): void => { if (n) nets.push(n); };
  const addAll = (ns: Net[]): void => { nets.push(...ns); };

  // ---------------- §12.4's buses -----------------------------------------
  // power: one 2-cell trunk per MOSFET, straight down into the CPU socket.
  // `turn: 40` is the west end of the determinism gradient — a corner costs 40
  // cells of run, so these are pure Manhattan drops with no chamfer at all.
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
  addAll(bundle(occ, { x: cpu.x + cpu.w + 1, y: cpu.y + 3 }, { x: dimmX - 3, y: cpu.y + 3 }, acc[1], 5, 2,
    { brush: 1, turn: 22, chamfer: 1 }));
  // CPU south -> big QFP: long eastward run through gutter 2
  addAll(bundle(occ, { x: cpu.x + 18, y: cpu.y + cpu.h + 1 }, { x: qfpBig.x + 4, y: qfpBig.y + qfpBig.h + 4 }, acc[1], 3, 4,
    { brush: 2, turn: 26, chamfer: 3 }));
  // chipset -> DRAM row: long eastward run through gutter 1
  addAll(bundle(occ, { x: 80, y: 19 }, { x: 117, y: 19 }, acc[2], 3, 2, { brush: 1, turn: 26, chamfer: 2 }));
  // coin cell -> chipset
  add(trace(occ, { x: 79, y: 27 }, { x: 70, y: 19 }, acc[2], { brush: 1, turn: 20, chamfer: 2 }));
  // DRAM row -> second QFP (vertical bus down through gutter 1)
  addAll(bundle(occ, { x: 121, y: 19 }, { x: qfp2.x + 1, y: 24 }, acc[1], 4, 3, { brush: 1, turn: 22, chamfer: 2 }));
  // big QFP -> second QFP
  addAll(bundle(occ, { x: qfpBig.x + qfpBig.w + 2, y: 29 }, { x: qfp2.x - 4, y: 29 }, acc[4], 4, 2,
    { brush: 1, turn: 22, chamfer: 2 }));
  // CPU south -> expansion slot 1 (drop through gutter 2)
  addAll(bundle(occ, { x: cpu.x + 4, y: cpu.y + cpu.h + 1 }, { x: 40, y: 61 }, acc[0], 3, 4,
    { brush: 2, turn: 26, chamfer: 3 }));
  // expansion slot 2 -> second QFP
  addAll(bundle(occ, { x: 128, y: 53 }, { x: 128, y: 41 }, acc[3], 3, 3, { brush: 1, turn: 26, chamfer: 2 }));
  // headers -> big QFP
  add(trace(occ, { x: 96, y: 47 }, { x: 103, y: 43 }, acc[4], { brush: 1, turn: 20, chamfer: 2 }));
  // full-width backbone along gutter 3 -> up into the right-hand logic
  add(trace(occ, { x: 46, y: 61 }, { x: 170, y: 61 }, acc[4], { brush: 2, turn: 30, chamfer: 3 }));
  // second QFP -> right-hand bridge
  addAll(bundle(occ, { x: qfp2.x + qfp2.w + 2, y: 40 }, { x: qfp3.x - 5, y: 40 }, acc[3], 2, 4,
    { brush: 2, turn: 26, chamfer: 3 }));

  // ---------------- §13.1's cross-region links ----------------------------
  //
  // These are the edges that turn three disjoint band trees into ONE ISLAND WITH
  // CYCLES. Without them only the middle band's hub reaches the connector, and a
  // walk on a forest can pick a destination but never a different ROUTE to the
  // same place — "rerouting" would be capped by the topology, not by the walk.
  // Every added run is rectilinear, chamfered, clearance-reserved, and lives in a
  // reserved gutter or a dead column: this is denser motherboard routing, not
  // spaghetti. §13.1 explicitly sanctions it — "nets may span §12.2's rows and
  // gutters; the row/gutter structure governs component placement only".

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
  add(trace(occ, { x: 107, y: 44 }, { x: 124, y: 44 }, acc[4], { brush: 1, turn: 26, chamfer: 2 }));
  // row-B: expansion slot 2 -> I/O header block
  add(trace(occ, { x: 137, y: 50 }, { x: 147, y: 50 }, acc[3], { brush: 1, turn: 22, chamfer: 2 }));
  // row-T west: crystal cluster -> DRAM bank, and cap field -> chipset
  add(trace(occ, { x: 108, y: 7 }, { x: 114, y: 7 }, acc[1], { brush: 1, turn: 22, chamfer: 1 }));
  add(trace(occ, { x: 60, y: 12 }, { x: 62, y: 16 }, acc[2], { brush: 1, turn: 22, chamfer: 1 }));

  // ---------------- connector fanout (§12.4) ------------------------------
  // Three 2-cell trunks per finger group, parallel into the gold. `turn: 22` is
  // the east end of the determinism gradient: the machine is purest where it
  // begins and loosens slightly toward the boundary where life emerges.
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: 198, y: 7 + i * 4 }, fingerEntry(0, i, 2), acc[0], { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: qfp3.x + qfp3.w + 3, y: 27 + i * 4 }, fingerEntry(1, i, 2), acc[2],
      { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));
  // Group 2 starts one column west of the other two: at x=198 the lowest trunk's
  // nearest node is the fanout-zone SMD furniture rather than the row-B hub, and
  // that finger ends up served by an island with no path back into the board.
  for (let i = 0; i < 3; i++)
    add(trace(occ, { x: 197, y: 49 + i * 4 }, fingerEntry(2, i, 2), acc[3], { brush: 2, turn: 22, chamfer: 3, endDir: 0 }));

  // hub spine, lower half — laid after the fanout so the fanout keeps first pick
  // of its own lanes. This is the link that makes all nine fingers reachable
  // from anywhere on the board.
  add(trace(occ, { x: 194, y: 40 }, { x: 194, y: 52 }, acc[2], { brush: 2, turn: 30, chamfer: 2 }));
  // gutter-2 east lane: row-B I/O furniture -> row-B east logic
  add(trace(occ, { x: 150, y: 47 }, { x: 178, y: 47 }, acc[4], { brush: 1, turn: 26, chamfer: 2 }));
  // header block -> second QFP, down the free column east of the headers
  add(trace(occ, { x: 120, y: 28 }, { x: 120, y: 41 }, acc[3], { brush: 1, turn: 26, chamfer: 2 }));

  return nets;
}
