import type { Cell, Flow, Rect, World } from './types.js';
import {
  BOARD_RIGHT, FINGERS, FINGER_W, GRID_H, GRID_W, TEXT_ZONES, inRect, orientEdge, stubPath, transit,
} from './layout.js';
import { SLOTS_PER_FRAME, flowDrawn } from './signals.js';

// ---------------------------------------------------------------------------
// boardlife.ts — the board's two living behaviours as PURE DATA: no canvas, no
// colour mixing. A renderer paints what these functions return.
//
//   WAKE    a copper cell a flow has just left stays marked for WAKE_FRAMES,
//           fading in WAKE_STEPS discrete steps, so every signal leaves a trace.
//   ANSWER  a neuron's spike (a Recording) enters a gold finger; the board
//           answers with a spike along real copper to one chip, which lights in
//           the neuron's accent.
//
// Everything is a pure function of t mod T; nothing keeps per-frame state.
// ---------------------------------------------------------------------------

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const cellIdx = (x: number, y: number): number => y * GRID_W + x;
const ADJ4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

export const WAKE_STEPS = 4;
export const WAKE_FRAMES = 32;
/** frames per fade step */
const STEP_FRAMES = WAKE_FRAMES / WAKE_STEPS;

export interface WakeCell { x: number; y: number; step: number; color: string }

/**
 * One event per (cell, moment a flow's trail finished leaving it), bucketed by
 * the frame that moment falls on (CSR: `start[f]..start[f+1]` are frame f's
 * events). A frame's wake is then the 32 buckets behind it, not a scan of every
 * event, and no per-frame grid is ever stored.
 *
 * `lag` is a weight-2 trunk's painted-width neighbour: the same event, one step
 * older, so the trace reads as a tapering ribbon rather than a flat bar.
 */
export interface Wake {
  T: number;
  /** only read to keep the wake off whatever any flow currently draws */
  flows: readonly Flow[];
  colors: string[];
  start: Int32Array;
  cell: Int32Array;
  color: Uint8Array;
  lag: Uint8Array;
}

export function buildWake(world: World): Wake {
  const T = world.T, N = T * SLOTS_PER_FRAME;

  // Where a wake may be painted: net copper only, never under a body or its pin
  // ring (trails cut across chip faces; the wake stops at the pins), a finger,
  // a text zone, or at/after the board's right edge.
  const ok = new Uint8Array(GRID_W * GRID_H);
  for (const n of world.nets) for (const c of n.cells)
    if (c.x >= 0 && c.y >= 0 && c.x < BOARD_RIGHT && c.y < GRID_H) ok[cellIdx(c.x, c.y)] = 1;
  for (const c of world.components) {
    const r = c.rect;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++)
      if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) ok[cellIdx(x, y)] = 0;
  }
  for (const f of FINGERS)
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + FINGER_W; x++) ok[cellIdx(x, y)] = 0;
  for (const z of TEXT_ZONES)
    for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++)
      if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) ok[cellIdx(x, y)] = 0;

  // net membership, for the painted width of 2-cell trunks (first net owns a shared cell)
  const netOf = new Int16Array(GRID_W * GRID_H).fill(-1);
  const wide = new Map<number, Set<number>>();
  world.nets.forEach((n, ni) => {
    for (const c of n.cells) if (c.x >= 0 && c.y >= 0 && c.x < GRID_W && c.y < GRID_H && netOf[cellIdx(c.x, c.y)] < 0)
      netOf[cellIdx(c.x, c.y)] = ni;
    if (n.weight > 1) wide.set(ni, new Set(n.cells.map(c => cellIdx(c.x, c.y))));
  });

  const colors = [...new Set(world.flows.map(f => f.color))];
  const buckets: { cell: number; color: number; lag: number }[][] = Array.from({ length: T }, () => []);

  world.flows.forEach(f => {
    const ci = colors.indexOf(f.color);
    // slots each cell is occupied at, ascending
    const at = new Map<number, number[]>();
    f.slots.forEach((p, s) => {
      if (!p || p.x < 0 || p.y < 0 || p.x >= GRID_W || p.y >= GRID_H) return;
      const k = cellIdx(p.x, p.y);
      const list = at.get(k);
      if (list) list.push(s); else at.set(k, [s]);
    });
    const seen = new Set<number>();
    const put = (k: number, leave: number, lag: number): void => {
      const dedupe = (k * T + leave) * 2 + lag;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      buckets[leave].push({ cell: k, color: ci, lag });
    };
    for (const [k, list] of at) {
      if (!ok[k] && netOf[k] < 0) continue;
      for (let j = 0; j < list.length; j++) {
        // a revisit inside the trail window keeps the cell inside the trail: only
        // the visit that is followed by a gap of at least `trail` ends a run
        const gap = (j + 1 < list.length ? list[j + 1] : list[0] + N) - list[j];
        if (gap < f.trail) continue;
        // the tail leaves slot s once the head reaches s + trail
        const leave = mod(Math.ceil((list[j] + f.trail) / SLOTS_PER_FRAME), T);
        if (ok[k]) put(k, leave, 0);
        const ni = netOf[k], set = ni >= 0 ? wide.get(ni) : undefined;
        if (!set) continue;
        const x = k % GRID_W, y = Math.floor(k / GRID_W);
        for (const [dx, dy] of ADJ4) {
          const k2 = cellIdx(x + dx, y + dy);
          if (x + dx >= 0 && y + dy >= 0 && x + dx < GRID_W && y + dy < GRID_H && ok[k2] && set.has(k2)) put(k2, leave, 1);
        }
      }
    }
  });

  const start = new Int32Array(T + 1);
  for (let f = 0; f < T; f++) start[f + 1] = start[f] + buckets[f].length;
  const cell = new Int32Array(start[T]), color = new Uint8Array(start[T]), lag = new Uint8Array(start[T]);
  buckets.forEach((b, f) => b.forEach((e, i) => {
    cell[start[f] + i] = e.cell; color[start[f] + i] = e.color; lag[start[f] + i] = e.lag;
  }));
  return { T, flows: world.flows, colors, start, cell, color, lag };
}

export function wakeCellsAt(wake: Wake, t: number): WakeCell[] {
  const { T } = wake;
  const tt = mod(Math.round(t), T);
  // fresher wins: scan age ascending; an older-lagged entry can still beat nothing
  const best = new Map<number, { eff: number; color: number }>();
  for (let age = 0; age < WAKE_FRAMES; age++) {
    const f = mod(tt - age, T);
    for (let i = wake.start[f]; i < wake.start[f + 1]; i++) {
      const eff = age + wake.lag[i] * STEP_FRAMES;
      if (eff >= WAKE_FRAMES) continue;
      const cur = best.get(wake.cell[i]);
      if (!cur || eff < cur.eff) best.set(wake.cell[i], { eff, color: wake.color[i] });
    }
  }
  // never on a cell a flow draws right now: the wake lives behind the trail
  const drawn = new Set<number>();
  for (const f of wake.flows) for (const c of flowDrawn(f, tt, T)) drawn.add(cellIdx(c.x, c.y));
  const out: WakeCell[] = [];
  for (const [k, { eff, color }] of best) {
    if (drawn.has(k)) continue;
    out.push({ x: k % GRID_W, y: Math.floor(k / GRID_W), step: Math.floor(eff / STEP_FRAMES), color: wake.colors[color] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface Recording { frame: number; finger: number; accent: string }
/** `path` runs from the finger's exit cell to the first cell on the chip's
 * footprint, in travel order. `hidden[i]` marks cells of it a renderer must not
 * paint (inside a body or finger, in a text zone, past the board edge): the path
 * has to stay contiguous through them, the spike only has to stay off them. */
export interface Answer {
  recording: Recording; path: Cell[]; component: number; arriveFrame: number; hidden?: boolean[];
}

export const ANSWER_SPEED = 2.5;
export const ANSWER_HOLD = 24;
export const ANSWER_FADE = 8;
/** head cells and trail cells behind it */
const SPIKE_HEAD = 4, SPIKE_TRAIL = 6;
/** a chip this far (in copper cells) from every finger makes the answer cross the board */
const ANSWER_MIN_PATH = 60;
const FADE_K = [0.75, 0.5, 0.25];

interface Reach { dist: number[]; prev: { n: number; e: number }[] }

/** Dijkstra over the graph in spine cells. Another finger is never a way
 * through: a return signal does not leave by one finger to re-enter by another. */
function reach(world: World, src: number): Reach {
  const g = world.graph;
  const dist = g.nodes.map(() => Infinity), prev = g.nodes.map(() => ({ n: -1, e: -1 }));
  const done = g.nodes.map(() => false);
  dist[src] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    if (g.nodes[u].finger >= 0 && u !== src) continue;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei], o = e.a === u ? e.b : e.a;
      const nd = dist[u] + e.cells.length;
      if (nd < dist[o]) { dist[o] = nd; prev[o] = { n: u, e: ei }; }
    }
  }
  return { dist, prev };
}

const fingerNodes = (world: World): number[] =>
  world.graph.nodes.map((n, i) => (n.finger >= 0 ? i : -1)).filter(i => i >= 0);

const answering = new WeakMap<World, number>();

/**
 * The ONE chip every recording in a world is answered at (an index into
 * `world.components`). Among the components the connector reaches by copper, take
 * the largest footprint at least ANSWER_MIN_PATH cells of copper from the NEAREST
 * of the nine fingers (so the rule is the same whichever finger spoke, and every
 * finger's path is long); ties go to the smallest x, then y. With none that far,
 * the farthest one. Distances are spine cells, the graph's own length.
 */
export function answeringComponent(world: World): number {
  const cached = answering.get(world);
  if (cached !== undefined) return cached;
  const g = world.graph;
  const dist = g.nodes.map(() => Infinity);
  for (const f of fingerNodes(world)) reach(world, f).dist.forEach((d, i) => { if (d < dist[i]) dist[i] = d; });
  const cand = g.nodes.map((n, i) => ({ comp: n.comp, d: dist[i] })).filter(c => c.comp >= 0 && c.d < Infinity);
  if (!cand.length) throw new Error('boardlife: no component is reachable from a finger');
  const far = cand.filter(c => c.d >= ANSWER_MIN_PATH);
  const area = (c: { comp: number }): number => world.components[c.comp].rect.w * world.components[c.comp].rect.h;
  let pick: { comp: number; d: number };
  if (far.length) {
    far.sort((p, q) => {
      const a = world.components[p.comp].rect, b = world.components[q.comp].rect;
      return area(q) - area(p) || a.x - b.x || a.y - b.y;
    });
    pick = far[0];
  } else pick = cand.reduce((p, q) => (q.d > p.d ? q : p));
  answering.set(world, pick.comp);
  return pick.comp;
}

const dedupe = (cells: Cell[]): Cell[] =>
  cells.filter((c, i) => i === 0 || c.x !== cells[i - 1].x || c.y !== cells[i - 1].y);

export function buildAnswers(world: World, recordings: readonly Recording[]): Answer[] {
  const g = world.graph, T = world.T;
  const comp = answeringComponent(world);
  const target = g.nodes.findIndex(n => n.comp === comp);
  const rect: Rect = world.components[comp].rect;
  const hiddenAt = (c: Cell): boolean =>
    c.x >= BOARD_RIGHT || world.components.some(k => inRect(c.x, c.y, k.rect))
    || FINGERS.some(f => inRect(c.x, c.y, { x: f.x, y: f.y, w: FINGER_W, h: f.h }))
    || TEXT_ZONES.some(z => inRect(c.x, c.y, z));
  const out: Answer[] = [];
  for (const r of recordings) {
    const src = g.nodes.findIndex(n => n.finger === r.finger);
    if (src < 0 || target < 0) continue;
    const { dist, prev } = reach(world, src);
    if (!Number.isFinite(dist[target])) continue;
    const hops: { from: number; e: number }[] = [];
    for (let n = target; n !== src; n = prev[n].n) hops.unshift({ from: prev[n].n, e: prev[n].e });

    // the same walk the flows make (hop = transit through a node, then its edge)
    let path: Cell[] = [];
    let edgeStart = 0;
    for (const h of hops) {
      const cells = orientEdge(g, h.e, h.from);
      if (!cells.length) continue;
      const centre = g.nodes[h.from].center;
      if (!path.length) path.push({ ...centre });
      const link = transit(path[path.length - 1], centre, cells[0]);
      path.push(...link);
      edgeStart = path.length - 1;
      path.push(...cells.slice(link.length ? 1 : 0));
    }
    path.push(...stubPath(path[path.length - 1], g.nodes[target].center));
    path = dedupe(path);

    // arrive on the first cell of the chip's footprint reached by the last edge
    let arrive = path.findIndex((c, i) => i >= edgeStart && inRect(c.x, c.y, rect));
    if (arrive < 0) arrive = path.length - 1;
    // leave the finger from the last cell of it before the path goes out onto the board
    const f = FINGERS[r.finger], fr: Rect = { x: f.x, y: f.y, w: FINGER_W, h: f.h };
    const out0 = path.findIndex(c => !inRect(c.x, c.y, fr));
    const first = Math.max(0, out0 - 1);
    path = path.slice(first, arrive + 1);

    out.push({
      recording: r, path, component: comp,
      arriveFrame: mod(r.frame + Math.ceil(path.length / ANSWER_SPEED), T),
      hidden: path.map(hiddenAt),
    });
  }
  return out;
}

/** The spike: a 4-cell head and a 6-cell trail behind it, advancing ANSWER_SPEED
 * cells per frame from the recording's frame, gone the frame it arrives. */
export function answerSpikeAt(
  answers: readonly Answer[], t: number, T: number,
): { x: number; y: number; d: number; accent: string }[] {
  const out: { x: number; y: number; d: number; accent: string }[] = [];
  const now = Math.round(t);
  for (const a of answers) {
    const L = a.path.length;
    const age = mod(now - a.recording.frame, T);
    if (age >= Math.ceil(L / ANSWER_SPEED)) continue;
    const head = Math.floor(age * ANSWER_SPEED);
    for (let d = 0; d < SPIKE_HEAD + SPIKE_TRAIL; d++) {
      const i = head - d;
      if (i < 0 || i >= L || a.hidden?.[i]) continue;
      out.push({ x: a.path[i].x, y: a.path[i].y, d, accent: a.recording.accent });
    }
  }
  return out;
}

/** The chip's wash: k = 1 for ANSWER_HOLD frames from arrival, then three steps
 * down over ANSWER_FADE. One entry per component; the freshest answer owns it. */
export function answerWashAt(
  answers: readonly Answer[], t: number, T: number,
): { component: number; accent: string; k: number }[] {
  const now = Math.round(t);
  const best = new Map<number, { accent: string; k: number; age: number }>();
  for (const a of answers) {
    const age = mod(now - a.arriveFrame, T);
    if (age >= ANSWER_HOLD + ANSWER_FADE) continue;
    const k = age < ANSWER_HOLD ? 1 : FADE_K[Math.floor(((age - ANSWER_HOLD) * FADE_K.length) / ANSWER_FADE)];
    const cur = best.get(a.component);
    if (!cur || age < cur.age) best.set(a.component, { accent: a.recording.accent, k, age });
  }
  return [...best].map(([component, { accent, k }]) => ({ component, accent, k }));
}
