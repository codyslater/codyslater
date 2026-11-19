// The tissue: three neurons that live in the void, wired to the gold fingers. A PURE DATA module
// (no canvas): cell lists a renderer paints later. `staticCells` is the resting arbor (somas,
// neurites, boutons, finger contacts), identical in every frame; `tissueCellsAt(t)` is only what
// differs from rest at frame t (spikes, firing somas, rings, flashes, breathing dendrite tips).
//
// The story: boards escapes land on three input fingers; each drives one neuron (soma 1 -> 2 -> 3,
// a plain chain); soma 3's axon ends on a fourth finger, "recording" back into the board. A spike
// travels 1.5 cells per frame, so the soma-to-soma axons are long enough to watch one go.
//
// Geometry is FROZEN: it takes hand-tuning to look clean, and the daily job renders arbitrary
// seeds, so the anatomy comes from a fixed internal constant and never from `seed`. The seed varies
// only which accents the somas wear, the spontaneous firings, and the breathing-tip phases.
import { ACCENTS, FINGERS, GOLD, GRID_W, VOID_BG } from './layout.js';
import { mulberry32, type Rng } from './rng.js';
import type { Cell, EscapeEvent } from './types.js';

export interface TissueCell { x: number; y: number; color: string }
/** A spike arriving ON a finger from the tissue (tissue -> board). */
export interface Recording { frame: number; finger: number; accent: string }

export interface Soma { index: number; cx: number; cy: number; accent: string; cells: Cell[]; nucleus: Cell[] }
export type NeuriteKind = 'input' | 'link' | 'rec' | 'dendrite';
export interface Neurite {
  id: number; kind: NeuriteKind;
  /** the soma whose accent it wears (an input axon belongs to the cell it excites) */
  owner: number;
  /** soma indices; -1 = a finger / a free end */
  from: number; to: number; finger: number;
  /** the line a spike runs along, source first (for a dendrite: its main stem) */
  path: Cell[];
  /** every static cell: path + thick base + branch + bouton + contact */
  cells: Cell[];
  thick?: Cell[]; branch?: Cell[]; bouton?: Cell[]; contact?: Cell[];
  /** breathing tip: the cells it can extend into, period dividing T and (per seed) phase */
  ext?: Cell[]; period?: number; phase?: number;
}
export interface Spike { neurite: number; t0: number; arrive: number; color: string }
export interface Firing { soma: number; t: number }

export interface Tissue {
  T: number;
  somas: Soma[]; neurites: Neurite[];
  spikes: Spike[]; firings: Firing[]; spontaneous: number[]; recordings: Recording[];
  /** refractory period per soma, frames */
  refractory: number[];
  /** the loop closes on itself (the simulated period repeats exactly) */
  steady: boolean;
  /** The busiest frame's dynamic cell count. The frames carry all of it: nothing is
   * shed. It may exceed BUDGET, which is only the phase search's target. */
  peak: number;
  staticCells: TissueCell[];
  /** the dynamic overlay for every frame of the loop, precomputed (frozen) */
  frames: readonly (readonly TissueCell[])[];
}

// ---------------------------------------------------------------- constants
/** the three input fingers (one per soma, nearest in y) and the one recording finger */
export const INPUT_FINGERS = [1, 4, 8] as const;
export const RECORD_FINGER = 7;
const XMIN = 232, XMAX = 297, YMIN = 2, YMAX = 77;   // every cell lives here, but the contacts
const CONTACT_X = 231;                               // contacts: x 231..232, on the finger's exit row
const ANATOMY_SEED = 0x7155a1;                       // the frozen wiring; the first attempt that validates wins
const SOMA_POS: [number, number][] = [[254, 14], [260, 34], [254, 58]];
const SPEED = 1.5;                                   // cells per frame
const REFRACT = [18, 18, 48];                        // soma 3 is the recording neuron: it adapts, so
                                                     // recordings are always >= 48 frames apart
export const BUDGET = 210;                           // the phase search's TARGET for the busiest frame's dynamic cells; never a truncation (see `peak`)
const TIP_PLAN = [2, 2, 1];                          // breathing tips per soma
const TIP_PERIODS = [72, 96, 144, 288, 48];          // all divide 288
const RING_R = [5, 7, 9];

// ---------------------------------------------------------------- colours
// At most 16 for the GIF encoder. Neural green is the dendrites' hue, so no soma wears it: four
// accents x 3 tiers + white + dendrite + growth cone = 15.
const hexOf = (r: number, g: number, b: number): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
/** the accent blended toward the void: the same formula as render.mixOnBg, which this module
 * does not import (render pulls in the canvas, and the renderer will import this). */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16), b = parseInt(VOID_BG.slice(1), 16);
  const m = (c: number, d: number): number => Math.round(c * alpha + d * (1 - alpha));
  return hexOf(m(n >> 16, b >> 16), m((n >> 8) & 255, (b >> 8) & 255), m(n & 255, b & 255));
}
const WHITE = '#ffffff';
export const DENDRITE_COLOUR = '#2a8f5a';
export const CONE_COLOUR = '#6fe0a0';
const SOMA_ACCENTS = [ACCENTS.ai, ACCENTS.synbio, ACCENTS.rna, ACCENTS.om];
const TIER_ALPHA = [0.4, 0.68, 1];
const tiers = (accent: string): [string, string, string] =>
  [tint(accent, TIER_ALPHA[0]), tint(accent, TIER_ALPHA[1]), tint(accent, TIER_ALPHA[2])];
/** The electrode leads (board finger -> soma) are not part of any cell: one neutral dim gold, the
 * connector gold toward the void. Only axons wear a cell's tint. */
export const LEAD_COLOUR = tint(GOLD, 0.6);
/** A spike's trail on a lead, head-side first. It is meant to run bright gold (#d4b83a) down to
 * LEAD_COLOUR, but the 16-colour GIF cap leaves room for one gold only (15 + LEAD_COLOUR), so all
 * three steps collapse onto it (a trail equal to rest is not an overlay: a lead spike shows its
 * white head and flank). Widen this ramp when a slot frees up. */
export const LEAD_RAMP: readonly string[] = [LEAD_COLOUR, LEAD_COLOUR, LEAD_COLOUR];
/** EVERY colour this module can emit. */
export const TISSUE_COLOURS: readonly string[] =
  [WHITE, DENDRITE_COLOUR, CONE_COLOUR, ...SOMA_ACCENTS.flatMap(tiers), LEAD_COLOUR];

// ---------------------------------------------------------------- grid helpers
const key = (x: number, y: number): number => y * GRID_W + x;
const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const cheb = (a: Cell, b: Cell): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const dirIndex = (dx: number, dy: number): number => ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const randInt = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const inBounds = (c: Cell): boolean => c.x >= XMIN && c.x <= XMAX && c.y >= YMIN && c.y <= YMAX;

interface SomaG { index: number; cx: number; cy: number; cells: Cell[]; nucleus: Cell[] }
// a 7x7 disc: the three cells of each corner are cut
const cutCorner = (dx: number, dy: number): boolean => Math.min(dx, 6 - dx) + Math.min(dy, 6 - dy) < 2;
function makeSoma(index: number, cx: number, cy: number): SomaG {
  const cells: Cell[] = [], nucleus: Cell[] = [];
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) if (!cutCorner(dx, dy)) cells.push({ x: cx - 3 + dx, y: cy - 3 + dy });
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nucleus.push({ x: cx + dx, y: cy + dy });
  return { index, cx, cy, cells, nucleus };
}
const inSoma = (s: SomaG, x: number, y: number): boolean => {
  const dx = x - (s.cx - 3), dy = y - (s.cy - 3);
  return dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && !cutCorner(dx, dy);
};
/** first cell outside the soma along the ray at `ang` */
function edgeStart(s: SomaG, ang: number): Cell {
  for (let r = 0; r < 14; r += 0.25) {
    const x = Math.round(s.cx + Math.cos(ang) * r), y = Math.round(s.cy + Math.sin(ang) * r);
    if (!inSoma(s, x, y)) return { x, y };
  }
  return { x: s.cx + 5, y: s.cy };
}

// ---------------------------------------------------------------- smooth axon: a rasterised cubic arc
function arc(p0: Cell, p3: Cell, bulge: number, tan0: Cell | null, tanEnd: Cell | null): Cell[] {
  const dx = p3.x - p0.x, dy = p3.y - p0.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const p1 = { x: p0.x + dx * 0.3 + nx * bulge + (tan0 ? tan0.x * len * 0.22 : 0), y: p0.y + dy * 0.3 + ny * bulge + (tan0 ? tan0.y * len * 0.22 : 0) };
  const p2 = { x: p0.x + dx * 0.7 + nx * bulge + (tanEnd ? tanEnd.x * len * 0.22 : 0), y: p0.y + dy * 0.7 + ny * bulge + (tanEnd ? tanEnd.y * len * 0.22 : 0) };
  const N = Math.ceil(len * 6) + 8;
  const out: Cell[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const c = {
      x: Math.round(u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x),
      y: Math.round(u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y),
    };
    const l = out[out.length - 1];
    if (!l || l.x !== c.x || l.y !== c.y) out.push(c);
  }
  // thin the raster to a clean 8-connected line: drop a cell that its neighbours already bridge
  const res: Cell[] = [];
  for (const c of out) {
    while (res.length >= 2 && cheb(res[res.length - 2], c) <= 1) res.pop();
    res.push(c);
  }
  return res;
}
/** longest run of identical steps, in cells */
function straight(p: Cell[]): number {
  let best = 1, run = 1, last = '';
  for (let i = 1; i < p.length; i++) {
    const d = `${p[i].x - p[i - 1].x},${p[i].y - p[i - 1].y}`;
    if (d === last) run++; else { run = 1; last = d; }
    best = Math.max(best, run + 1);
  }
  return best;
}

// ---------------------------------------------------------------- the anatomy (static, frozen)
interface Anatomy { somas: SomaG[]; neurites: Neurite[] }
type Occ = Map<number, number>;
const SOMA_ID = 100;

/** `cells` may be laid down: inside bounds, on no occupied cell, touching no OTHER neurite or soma.
 * `rootAt(i)` says which cells may hug the neurite's own soma (its root, or its far end for an input). */
function fits(cells: Cell[], id: number, own: number, occ: Occ, rootAt: (i: number) => boolean): boolean {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!inBounds(c)) return false;
    const at = occ.get(key(c.x, c.y));
    if (at !== undefined && at !== id) return false;
    for (const [dx, dy] of DIRS) {
      const o = occ.get(key(c.x + dx, c.y + dy));
      if (o === undefined || o === id) continue;
      if (o === SOMA_ID + own && rootAt(i)) continue;
      return false;
    }
  }
  return true;
}
const mark = (occ: Occ, cells: Cell[], id: number): void => { for (const c of cells) occ.set(key(c.x, c.y), id); };

/** a dendrite's random walk: a thin line that bends in 45-degree steps and never touches anything else */
function meander(o: {
  start: Cell; aim: Cell; steps: number; theta0: number; kappa: number; gain: number; sigma: number;
  id: number; own: number; occ: Occ;
}, rng: Rng): Cell[] | null {
  const cells: Cell[] = [o.start];
  const mine = new Set<number>([key(o.start.x, o.start.y)]);
  let th = o.theta0, last = -1, run = 0, cur = { ...o.start };
  for (let n = 0; n < o.steps; n++) {
    const w: number[] = [];
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = DIRS[k];
      const c = { x: cur.x + dx, y: cur.y + dy };
      let wk = 0;
      if (inBounds(c) && !mine.has(key(c.x, c.y)) && !o.occ.has(key(c.x, c.y))
        && !(last >= 0 && (k === (last + 4) % 8 || (k === last && run >= (k % 2 === 0 ? 3 : 4))))) {
        let clear = true;
        for (const [ax, ay] of DIRS) {
          const q = key(c.x + ax, c.y + ay);
          if (q === key(cur.x, cur.y)) continue;
          if (mine.has(q)) { clear = false; break; }                 // no own corner or blob
          const oc = o.occ.get(q);
          if (oc !== undefined && oc !== o.id && !(oc === SOMA_ID + o.own && n < 3)) { clear = false; break; }
        }
        if (clear) wk = Math.exp(o.kappa * Math.cos(Math.atan2(dy, dx) - th));
      }
      w.push(wk); sum += wk;
    }
    if (sum <= 0) return null;
    let r = rng() * sum, k = 0;
    for (; k < 7; k++) { r -= w[k]; if (r <= 0) break; }
    if (k === last) run++; else { run = 1; last = k; }
    cur = { x: cur.x + DIRS[k][0], y: cur.y + DIRS[k][1] };
    cells.push(cur); mine.add(key(cur.x, cur.y));
    const aimAng = Math.atan2(o.aim.y - cur.y, o.aim.x - cur.x);
    th += Math.max(-0.5, Math.min(0.5, wrap(aimAng - th))) * o.gain + (rng() + rng() + rng() - 1.5) * o.sigma;
    th += 0.3 * wrap(Math.atan2(DIRS[k][1], DIRS[k][0]) - th);
  }
  return cells;
}

/** growth-cone cells for a tip whose line ends `path`: three cells ahead, in one of two shapes */
function coneCells(path: Cell[], shapeB: boolean): Cell[] {
  const c = path[path.length - 1], q = path[path.length - 2];
  const k = dirIndex(c.x - q.x, c.y - q.y);
  const offs: [number, number][] = shapeB ? [[k - 2, 1], [k, 2], [k + 2, 1]] : [[k - 1, 1], [k, 1], [k + 1, 1]];
  return offs.map(([kk, d]) => {
    const D = DIRS[mod(kk, 8)];
    return { x: c.x + D[0] * d, y: c.y + D[1] * d };
  });
}

function tryAnatomy(rng: Rng): Anatomy | null {
  const occ: Occ = new Map();
  const somas = SOMA_POS.map(([x, y], i) => makeSoma(i, x, y));
  for (const s of somas) mark(occ, s.cells, SOMA_ID + s.index);
  const neurites: Neurite[] = [];
  const exitRow = (f: number): number => FINGERS[f].y + 1;
  const contactOf = (f: number): Cell[] => {
    const y = exitRow(f);
    return [{ x: CONTACT_X, y }, { x: CONTACT_X + 1, y }, { x: CONTACT_X, y: y + 1 }, { x: CONTACT_X + 1, y: y + 1 }];
  };
  const push = (n: Omit<Neurite, 'cells'>, extra: Cell[][]): Neurite => {
    const seen = new Set<number>(), cells: Cell[] = [];
    for (const c of [...n.path, ...extra.flat()]) if (!seen.has(key(c.x, c.y))) { seen.add(key(c.x, c.y)); cells.push(c); }
    const full = { ...n, cells };
    neurites.push(full);
    return full;
  };

  // ---- soma-to-soma axons: long, bowing out to the right, ending in a 2x2 bouton with a 1-cell cleft
  for (let li = 0; li < 2; li++) {
    const a = somas[li], b = somas[li + 1], id = neurites.length;
    const dTo = (c: Cell): number => Math.min(...b.cells.map(k => cheb(c, k)));
    let best: { path: Cell[]; bouton: Cell[] } | null = null, bestScore = Infinity;
    for (let ea = -110; ea <= 20; ea += 10) {
      let E: Cell | null = null;
      for (let r = 3; r < 9 && !E; r += 0.25) {
        const c = { x: Math.round(b.cx + Math.cos(ea * Math.PI / 180) * r), y: Math.round(b.cy + Math.sin(ea * Math.PI / 180) * r) };
        if (dTo(c) === 3 && !occ.has(key(c.x, c.y))) E = c;
      }
      if (!E) continue;
      let Q = b.cells[0];
      for (const k of b.cells) if (cheb(E, k) < cheb(E, Q)) Q = k;
      const sx = Math.sign(Q.x - E.x), sy = Math.sign(Q.y - E.y);
      const bx = sx < 0 ? E.x - 1 : E.x, by = sy < 0 ? E.y - 1 : E.y;
      const bouton = [{ x: bx, y: by }, { x: bx + 1, y: by }, { x: bx, y: by + 1 }, { x: bx + 1, y: by + 1 }];
      if (Math.min(...bouton.map(dTo)) !== 2 || !fits(bouton, id, -1, occ, () => false)) continue;
      for (let sa = -20; sa <= 100; sa += 10) {
        const start = edgeStart(a, sa * Math.PI / 180);
        const len = Math.hypot(E.x - start.x, E.y - start.y);
        for (const mag of [0.2, 0.28, 0.36, 0.45, 0.55, 0.65]) for (const sign of [1, -1]) {
          const path = arc(start, E, sign * mag * len, null, null);
          const maxX = Math.max(...path.map(c => c.x));
          if (path.length < 22 || path.length > 46 || straight(path) > 6) continue;
          if (maxX < Math.max(start.x, E.x) + 5 || maxX > 282) continue;
          if (!fits(path, id, a.index, occ, i => i < 3)) continue;
          const score = Math.abs(path.length - 27) + (straight(path) > 5 ? 2 : 0) + Math.abs(maxX - 273) * 0.3;
          if (score < bestScore) { bestScore = score; best = { path, bouton }; }
        }
      }
    }
    if (!best) return null;
    mark(occ, best.path, id); mark(occ, best.bouton, id);
    push({ id, kind: 'link', owner: a.index, from: a.index, to: b.index, finger: -1, path: best.path, bouton: best.bouton }, [best.bouton]);
  }

  // ---- finger axons: gentle arcs, never crossing. `ends` are the soma-side candidates.
  const fingerAxon = (f: number, s: SomaG, kind: 'input' | 'rec'): boolean => {
    const id = neurites.length, contact = contactOf(f), y = exitRow(f);
    mark(occ, contact, id);
    const fcell = { x: CONTACT_X + 2, y };
    const base = Math.atan2(fcell.y - s.cy, fcell.x - s.cx);
    let best: Cell[] | null = null, bestScore = Infinity;
    for (let da = -50; da <= 50; da += 5) {
      const e = edgeStart(s, base + da * Math.PI / 180);
      const [p0, p3] = kind === 'input' ? [fcell, e] : [e, fcell];
      const len = Math.hypot(p3.x - p0.x, p3.y - p0.y);
      for (const mag of [0.03, 0.06, 0.09, 0.12, 0.16, 0.2, 0.26]) for (const sign of [1, -1]) {
        const path = arc(p0, p3, sign * mag * len, kind === 'input' ? { x: 1, y: 0 } : null, kind === 'rec' ? { x: 1, y: 0 } : null);
        if (straight(path) > 6) continue;
        const ok = kind === 'input' ? (i: number): boolean => i >= path.length - 3 : (i: number): boolean => i < 3;
        if (!fits(path, id, s.index, occ, ok)) continue;
        const score = mag * 10 + Math.abs(da) * 0.05 + path.length * 0.02;
        if (score < bestScore) { bestScore = score; best = path; }
      }
    }
    if (!best) return false;
    mark(occ, best, id);
    push(kind === 'input'
      ? { id, kind, owner: s.index, from: -1, to: s.index, finger: f, path: best, contact }
      : { id, kind, owner: s.index, from: s.index, to: -1, finger: f, path: best, contact }, [contact]);
    return true;
  };
  if (!fingerAxon(RECORD_FINGER, somas[2], 'rec')) return null;
  for (let i = 0; i < 3; i++) if (!fingerAxon(INPUT_FINGERS[i], somas[i], 'input')) return null;

  // ---- dendrites: 3 per soma, short tufts, 2 cells thick at the base, at most one bifurcation
  const dends: Neurite[] = [];
  for (const s of somas) {
    // angles already taken by axons near this soma
    const taken: number[] = [];
    for (const n of neurites) for (const c of n.path) {
      if (Math.hypot(c.x - s.cx, c.y - s.cy) <= 10) taken.push(Math.atan2(c.y - s.cy, c.x - s.cx));
    }
    const angs: number[] = [];
    for (let d = 0; d < 3; d++) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const ang = rng() * Math.PI * 2;
        if (taken.some(a => Math.abs(wrap(ang - a)) < 0.5) || angs.some(a => Math.abs(wrap(ang - a)) < 0.9)) continue;
        const len = randInt(rng, 6, 8), id = neurites.length + dends.length;
        const start = edgeStart(s, ang);
        if (occ.has(key(start.x, start.y)) || !inBounds(start)) continue;
        const main = meander({
          start, aim: { x: start.x + Math.cos(ang) * len * 2, y: start.y + Math.sin(ang) * len * 2 },
          steps: len - 1, theta0: ang, kappa: 2.6, gain: 0.08, sigma: 0.4, id, own: s.index, occ: new Map(occ).set(key(start.x, start.y), id),
        }, rng);
        if (!main || main.length < 6 || !fits(main, id, s.index, occ, i => i < 3)) continue;
        // thick base: a second cell beside each of the first 4 stem cells
        const thick: Cell[] = [];
        for (let i = 0; i < 4; i++) {
          const k = dirIndex(main[i + 1].x - main[i].x, main[i + 1].y - main[i].y);
          for (const side of [2, 6]) {
            const D = DIRS[(k + side) % 8], c = { x: main[i].x + D[0], y: main[i].y + D[1] };
            const trial = [...main, ...thick, c];
            if (!main.some(m => m.x === c.x && m.y === c.y) && fits(trial, id, s.index, occ, () => true)) { thick.push(c); break; }
          }
        }
        if (thick.length < 3) continue;
        const occ2 = new Map(occ); mark(occ2, main, id); mark(occ2, thick, id);
        let branch: Cell[] | undefined;
        if (rng() < 0.5) {
          const bi = Math.floor(main.length * (0.45 + rng() * 0.2));
          if (bi >= 3 && bi <= main.length - 3) {
            const dloc = Math.atan2(main[bi + 1].y - main[bi - 1].y, main[bi + 1].x - main[bi - 1].x);
            const bang = dloc + (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 0.4);
            const blen = randInt(rng, 3, 4);
            const br = meander({
              start: main[bi], aim: { x: main[bi].x + Math.cos(bang) * 20, y: main[bi].y + Math.sin(bang) * 20 },
              steps: blen, theta0: bang, kappa: 2.6, gain: 0.05, sigma: 0.4, id, own: s.index, occ: occ2,
            }, rng);
            if (br && br.length >= 4 && main.length + br.length - 1 <= 12) { branch = br.slice(1); mark(occ2, branch, id); }
          }
        }
        mark(occ, main, id); mark(occ, thick, id); if (branch) mark(occ, branch, id);
        dends.push({ id, kind: 'dendrite', owner: s.index, from: s.index, to: -1, finger: -1, path: main, thick, branch, cells: [...main, ...thick, ...(branch ?? [])] });
        angs.push(ang);
        break;
      }
    }
    if (dends.filter(d => d.owner === s.index).length < 3) return null;
  }

  // ---- breathing tips: the far end of a stem can extend 4-6 cells with a growth cone in front
  let tips = 0;
  for (const s of somas) {
    let need = TIP_PLAN[s.index];
    const mine = dends.filter(d => d.owner === s.index).sort((a, b) => b.path[b.path.length - 1].x - a.path[a.path.length - 1].x);
    for (const d of mine) {
      if (need <= 0) break;
      const tip = d.path[d.path.length - 1], prev = d.path[d.path.length - 3];
      const th = Math.atan2(tip.y - prev.y, tip.x - prev.x), el = randInt(rng, 4, 6);
      for (let attempt = 0; attempt < 12; attempt++) {
        const ext = meander({
          start: tip, aim: { x: tip.x + Math.cos(th) * 20, y: tip.y + Math.sin(th) * 20 }, steps: el, theta0: th,
          kappa: 3, gain: 0.05, sigma: 0.3, id: d.id, own: s.index, occ,
        }, rng);
        if (!ext || ext.length < el + 1) continue;
        const e = ext.slice(1);
        if (!fits(e, d.id, s.index, occ, () => false)) continue;
        // the cone, in both shapes, at every length, must stay clear of everything but this tip's own reach
        const reach = new Set(e.map(c => key(c.x, c.y)));
        let clear = true;
        for (let n = 0; n <= el && clear; n++) for (const shapeB of [false, true]) {
          const path = d.path.concat(e.slice(0, n));
          for (const c of coneCells(path, shapeB)) {
            const at = occ.get(key(c.x, c.y));
            if (!inBounds(c) || (at !== undefined && !(at === d.id && reach.has(key(c.x, c.y))))) { clear = false; break; }
            for (const [dx, dy] of DIRS) {
              const o = occ.get(key(c.x + dx, c.y + dy));
              if (o !== undefined && o !== d.id) clear = false;
            }
          }
        }
        if (!clear) continue;
        d.ext = e; d.period = TIP_PERIODS[tips % TIP_PERIODS.length];
        mark(occ, e, d.id);
        tips++; need--;
        break;
      }
    }
  }
  if (tips < 4) return null;
  return { somas, neurites: [...neurites, ...dends] };
}

let FROZEN: Anatomy | null = null;
function anatomy(): Anatomy {
  if (!FROZEN) {
    for (let a = 0; a < 600 && !FROZEN; a++) FROZEN = tryAnatomy(mulberry32(ANATOMY_SEED + a));
    if (!FROZEN) throw new Error('tissue: no valid anatomy');
  }
  return FROZEN;
}

// ---------------------------------------------------------------- activity (a discrete-event simulation)
interface Sim {
  spikes: Spike[]; firings: Firing[]; recordings: { frame: number; finger: number; soma: number }[];
  flashes: { kind: 'bouton' | 'in' | 'rec'; neurite: number; t0: number }[];
  steady: boolean;
}
const arriveAge = (len: number): number => Math.ceil((len - 1) / SPEED);
const spikeDur = (len: number): number => Math.ceil((len + 11) / SPEED) + 1;

/** Run `PER` consecutive periods and keep one (the loop's steady state); `steady` says period k+1
 * repeated period k exactly, so wrapping its times modulo T closes the loop. */
function simulate(an: Anatomy, events: readonly EscapeEvent[], spont: readonly number[], skip: ReadonlySet<number>, T: number): Sim {
  const PER = 6, KEEP = 3;
  const q: (() => void)[][] = Array.from({ length: PER * T + 1 }, () => []);
  const at = (t: number, fn: () => void): void => { if (t < q.length) q[t].push(fn); };
  const last = an.somas.map(() => -1e9);
  const all = { spikes: [] as Spike[], firings: [] as Firing[], flashes: [] as Sim['flashes'], rec: [] as Sim['recordings'] };
  const byFinger = new Map(an.neurites.filter(n => n.kind === 'input').map(n => [n.finger, n]));

  const launch = (n: Neurite, t0: number, then: (arrive: number) => void): void => {
    const arrive = t0 + arriveAge(n.path.length);
    all.spikes.push({ neurite: n.id, t0, arrive, color: '' });
    at(arrive, () => then(arrive));
  };
  const fire = (s: number, t: number): void => {
    if (t - last[s] < REFRACT[s]) return;
    last[s] = t;
    all.firings.push({ soma: s, t });
    at(t + 2, () => {                                  // 2 white frames, then the axon takes the spike
      for (const n of an.neurites) {
        if (n.from !== s || (n.kind !== 'link' && n.kind !== 'rec')) continue;
        launch(n, t + 2, arr => {
          if (n.kind === 'link') {
            all.flashes.push({ kind: 'bouton', neurite: n.id, t0: arr });
            at(arr + 2, () => fire(n.to, arr + 2));
          } else {
            all.flashes.push({ kind: 'rec', neurite: n.id, t0: arr });
            all.rec.push({ frame: arr, finger: n.finger, soma: s });
          }
        });
      }
    });
  };
  for (let k = 0; k < PER; k++) {
    events.forEach((e, i) => {
      const n = byFinger.get(e.finger);
      if (!n || skip.has(i)) return;
      const t0 = mod(e.frame, T) + k * T;
      at(t0, () => {
        all.flashes.push({ kind: 'in', neurite: n.id, t0 });
        launch(n, t0, arr => at(arr + 1, () => fire(n.to, arr + 1)));
      });
    });
    for (const f of spont) at(f + k * T, () => fire(0, f + k * T));
  }
  for (let t = 0; t < q.length; t++) for (let i = 0; i < q[t].length; i++) q[t][i]();   // fns may append to later slots

  const lo = (k: number): number => k * T, inP = (t: number, k: number): boolean => t >= lo(k) && t < lo(k + 1);
  const slice = (k: number) => ({
    spikes: all.spikes.filter(s => inP(s.t0, k)).map(s => ({ ...s, t0: s.t0 - lo(k), arrive: s.arrive - lo(k) })),
    firings: all.firings.filter(f => inP(f.t, k)).map(f => ({ ...f, t: f.t - lo(k) })),
    flashes: all.flashes.filter(f => inP(f.t0, k)).map(f => ({ ...f, t0: f.t0 - lo(k) })),
    recordings: all.rec.filter(r => inP(r.frame, k)).map(r => ({ ...r, frame: r.frame - lo(k) })),
  });
  const a = slice(KEEP), b = slice(KEEP + 1);
  const sig = (s: ReturnType<typeof slice>): string => JSON.stringify([
    s.spikes.map(x => [x.neurite, x.t0]).sort(), s.firings.map(x => [x.soma, x.t]).sort(),
    s.flashes.map(x => [x.kind, x.neurite, x.t0]).sort(), s.recordings.map(x => x.frame).sort(),
  ]);
  return { spikes: a.spikes, firings: a.firings, flashes: a.flashes, recordings: a.recordings, steady: sig(a) === sig(b) };
}

/** Rhythm: 3 to 5 recordings per loop. Inputs on soma 1's finger plus `want` seeded spontaneous firings of
 * soma 1 (the activity's pace: 1, 2 or 3) start full cascades; `want` is a TARGET, never a license to
 * break the rule: a firing that would push the loop past 5 recordings, or that does not close the loop,
 * is not taken, and if a seed's events give fewer than 3 recordings more firings are drawn past `want`
 * until it does (deterministically, from the same stream). The draws are the same for any `want` up to
 * the point the loop stops asking, so `want = 2` is the original behaviour exactly. */
function planRhythm(an: Anatomy, events: readonly EscapeEvent[], rng: Rng, T: number, want: number): { spont: number[]; sim: Sim } {
  const skip = new Set<number>();
  let spont: number[] = [];
  let sim = simulate(an, events, spont, skip, T);
  // a safety net the real timeline never reaches (one escape per finger): too many cascades, so
  // let the latest input events fail to excite
  const inputs = events.map((e, i) => ({ i, f: e.frame })).filter(x => (INPUT_FINGERS as readonly number[]).includes(events[x.i].finger))
    .sort((p, r) => r.f - p.f);
  for (const x of inputs) { if (sim.recordings.length <= 5) break; skip.add(x.i); sim = simulate(an, events, spont, skip, T); }
  const into0 = events.filter((e, i) => e.finger === INPUT_FINGERS[0] && !skip.has(i)).length;
  const fires0 = (s: Sim): number => s.firings.filter(f => f.soma === 0).length;
  for (let tries = 0; (spont.length < want || sim.recordings.length < 3) && spont.length < 5 && tries < 160; tries++) {
    const f = tries < 100 ? Math.floor(rng() * T) : ((tries - 100) * 7) % T;       // then a deterministic scan
    const r = simulate(an, events, [...spont, f], skip, T);
    const strict = tries < 70;                                                     // later: settle for a partial cascade
    if (r.steady && r.recordings.length <= 5 && fires0(r) === into0 + spont.length + 1
      && (!strict || r.recordings.length > sim.recordings.length)) { spont = [...spont, f]; sim = r; }
  }
  return { spont: spont.sort((a, b) => a - b), sim };
}

// ---------------------------------------------------------------- composing frames
const Z = { ring: 1, ext: 2, cone: 3, flash: 4, soma: 5, trail: 6, head: 7 } as const;

function compose(
  an: Anatomy, somas: Soma[], sim: Sim, phases: Map<number, number>, rest: Map<number, string>, T: number,
): { frames: TissueCell[][]; peak: number } {
  const col = somas.map(s => tiers(s.accent));
  // flank cells: per neurite one fixed side of the path, chosen once, perpendicular to travel; a
  // flank on a static cell, a soma or a breathing-tip cell is simply skipped (the side never swaps)
  const blocked = new Set<number>([...rest.keys()]);
  for (const n of an.neurites) for (const c of n.ext ?? []) blocked.add(key(c.x, c.y));
  const flank = new Map<number, (Cell | null)[]>();
  for (const n of an.neurites) {
    if (n.kind === 'dendrite') continue;
    const p = n.path;
    const side = (sg: number): (Cell | null)[] => p.map((c, i) => {
      const a = p[Math.min(i + 1, p.length - 1)], b = p[Math.max(i - 1, 0)];
      const dx = Math.sign(a.x - b.x), dy = Math.sign(a.y - b.y);
      const f = { x: c.x + sg * -dy, y: c.y + sg * dx };
      return inBounds(f) && !blocked.has(key(f.x, f.y)) ? f : null;
    });
    const l = side(1), r = side(-1);
    flank.set(n.id, l.filter(Boolean).length >= r.filter(Boolean).length ? l : r);
  }
  const neurite = new Map(an.neurites.map(n => [n.id, n]));
  const frames: TissueCell[][] = [];
  let peak = 0;
  for (let t = 0; t < T; t++) {
    const g = new Map<number, { c: string; p: number }>();
    const put = (x: number, y: number, c: string, p: number, contact = false): void => {
      if (x < (contact ? CONTACT_X : XMIN) || x > XMAX || y < YMIN || y > YMAX) return;
      const k = key(x, y), o = g.get(k);
      if (!o || p >= o.p) g.set(k, { c, p });
    };
    // firing somas: white, then three steps back to rest, with an expanding dotted ring
    somas.forEach((s, i) => {
      let age = 99;
      for (const f of sim.firings) if (f.soma === i) age = Math.min(age, mod(t - f.t, T));
      if (age < 10) {
        const [body, nuc]: [string, string] = age < 2 ? [WHITE, WHITE] : age < 6 ? [col[i][2], WHITE] : [col[i][2], col[i][2]];
        for (const c of s.cells) put(c.x, c.y, body, Z.soma);
        for (const c of s.nucleus) put(c.x, c.y, nuc, Z.soma);
      }
      if (age >= 2 && age < 8) {
        const step = (age - 2) >> 1, r = RING_R[step];
        for (let y = s.cy - r - 1; y <= s.cy + r + 1; y++) for (let x = s.cx - r - 1; x <= s.cx + r + 1; x++) {
          if ((x + y) % 2 === 0 && Math.round(Math.hypot(x - s.cx, y - s.cy)) === r && !rest.has(key(x, y))) put(x, y, col[i][2 - step], Z.ring);
        }
      }
    });
    // breathing tips
    for (const n of an.neurites) {
      if (!n.ext) continue;
      const P = n.period!, L = n.ext.length;
      // The + 1e-9 settles exact halves upward. For L = 5 and 6 the length passes within one ulp of
      // k + 0.5 (e.g. cos(pi/3)), so without it the cell count would hang on the last bit of
      // Math.cos, and with it the reference render's byte identity does not.
      const k = Math.round(L * (0.5 - 0.5 * Math.cos(2 * Math.PI * mod(t + phases.get(n.id)!, P) / P)) + 1e-9);
      for (let i = 0; i < k; i++) put(n.ext[i].x, n.ext[i].y, DENDRITE_COLOUR, Z.ext);
      for (const c of coneCells(n.path.concat(n.ext.slice(0, k)), Math.floor(t / 3) % 2 === 1)) put(c.x, c.y, CONE_COLOUR, Z.cone);
    }
    // flashes: bouton (white 2, accent 2), input contact (white 2, accent 2), recording contact (white 3, accent 3)
    for (const f of sim.flashes) {
      const age = mod(t - f.t0, T), n = neurite.get(f.neurite)!, lit = n.kind === 'input' ? LEAD_COLOUR : col[n.owner][2];
      const cells = f.kind === 'bouton' ? n.bouton! : n.contact!;
      const white = f.kind === 'rec' ? 3 : 2, total = white * 2;
      if (age < total) for (const c of cells) put(c.x, c.y, age < white ? WHITE : lit, Z.flash, f.kind !== 'bouton');
    }
    // spikes: a 4-cell white head (2 wide: one flank cell each) and an 8-cell trail stepping down the owner's accent
    for (const sp of sim.spikes) {
      const n = neurite.get(sp.neurite)!, age = mod(t - sp.t0, T), len = n.path.length;
      if (age >= spikeDur(len)) continue;
      const h = Math.floor(age * SPEED), c3 = col[n.owner];
      const ramp = n.kind === 'input'
        ? [LEAD_RAMP[0], LEAD_RAMP[0], LEAD_RAMP[1], LEAD_RAMP[1], LEAD_RAMP[1], LEAD_RAMP[2], LEAD_RAMP[2], LEAD_RAMP[2]]
        : [c3[2], c3[2], c3[2], c3[1], c3[1], c3[1], c3[0], c3[0]];
      for (let j = 0; j < 12; j++) {
        const idx = h - j;
        if (idx < 0 || idx >= len) continue;
        put(n.path[idx].x, n.path[idx].y, j < 4 ? WHITE : ramp[j - 4], j < 4 ? Z.head : Z.trail);
        const fl = j < 4 ? flank.get(n.id)![idx] : null;
        if (fl) put(fl.x, fl.y, WHITE, Z.head);
      }
    }
    // only what differs from rest
    const list: { k: number; c: string; p: number }[] = [];
    for (const [k, v] of g) if (rest.get(k) !== v.c) list.push({ k, c: v.c, p: v.p });
    // A frame is never truncated. There used to be a last-resort cap here that dropped the
    // lowest layers past BUDGET; it fired silently on real dates (20261201 on a busy fortnight:
    // 217 cells), and a missing ring or tip is a visible defect. How much may move in the void
    // is gated where it is measured, on the rendered frames (timeline's RENDERED_VOID_PEAK_MAX).
    peak = Math.max(peak, list.length);
    frames.push(list.map(v => Object.freeze({ x: v.k % GRID_W, y: Math.floor(v.k / GRID_W), color: v.c })));
  }
  return { frames, peak };
}

// ---------------------------------------------------------------- public API
/** `spontaneousFirings` is how many times soma 1 is asked to fire on its own per loop (1, 2 or 3; the
 * activity's calm, steady and busy pace). Steady, the default, is the banner as it was before activity. */
export function buildTissue(
  seed: number, events: readonly EscapeEvent[], accents: readonly string[], T: number, spontaneousFirings = 2,
): Tissue {
  if (![1, 2, 3].includes(spontaneousFirings)) {
    throw new Error(`tissue: spontaneousFirings must be 1, 2 or 3, got ${JSON.stringify(spontaneousFirings)}`);
  }
  const an = anatomy();
  const rng = mulberry32((seed ^ 0x7155) >>> 0);

  // three different accents of the world, never neural green (the dendrites' hue)
  const pool = accents.filter((a, i) => SOMA_ACCENTS.includes(a) && accents.indexOf(a) === i);
  const worn = [...(() => { const p = [...pool]; for (let i = p.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [p[i], p[k]] = [p[k], p[i]]; } return p; })(),
    ...SOMA_ACCENTS.filter(a => !pool.includes(a))].slice(0, 3);
  const somas: Soma[] = an.somas.map((s, i) => ({ ...s, accent: worn[i] }));
  const col = somas.map(s => tiers(s.accent));

  const { spont, sim } = planRhythm(an, events, rng, T, spontaneousFirings);

  // resting arbor
  const rest = new Map<number, string>(), order: number[] = [];
  const put = (c: Cell, color: string): void => { const k = key(c.x, c.y); if (!rest.has(k)) order.push(k); rest.set(k, color); };
  for (const n of an.neurites) {
    if (n.kind === 'dendrite') { n.cells.forEach(c => put(c, DENDRITE_COLOUR)); continue; }
    if (n.kind === 'input') { n.path.forEach(c => put(c, LEAD_COLOUR)); n.contact?.forEach(c => put(c, LEAD_COLOUR)); continue; }
    n.path.forEach(c => put(c, col[n.owner][0]));
    n.bouton?.forEach(c => put(c, col[n.owner][1]));
    n.contact?.forEach(c => put(c, col[n.owner][1]));
  }
  somas.forEach((s, i) => { s.cells.forEach(c => put(c, col[i][1])); s.nucleus.forEach(c => put(c, col[i][2])); });
  const staticCells = order.map(k => ({ x: k % GRID_W, y: Math.floor(k / GRID_W), color: rest.get(k)! }));

  // breathing-tip phases: seeded, re-drawn until the busiest frame meets the budget; if none of
  // the 40 draws does, the calmest draw is kept and drawn whole
  let phases = new Map<number, number>(), frames: TissueCell[][] = [], best = Infinity;
  for (let attempt = 0; attempt < 40; attempt++) {
    const trial = new Map<number, number>();
    for (const n of an.neurites) if (n.ext) trial.set(n.id, Math.floor(rng() * n.period!));
    const r = compose(an, somas, sim, trial, rest, T);
    if (r.peak < best) { best = r.peak; phases = trial; frames = r.frames; }
    if (best <= BUDGET) break;
  }

  const neurites: Neurite[] = an.neurites.map(n => (n.ext ? { ...n, phase: phases.get(n.id) } : { ...n }));
  const spikes = sim.spikes.map(s => ({ ...s, color: somas[neurites[s.neurite].owner].accent })).sort((a, b) => a.t0 - b.t0);
  return {
    T, somas, neurites, spikes,
    firings: [...sim.firings].sort((a, b) => a.t - b.t || a.soma - b.soma),
    spontaneous: spont,
    recordings: sim.recordings.map(r => ({ frame: r.frame, finger: r.finger, accent: somas[r.soma].accent })).sort((a, b) => a.frame - b.frame),
    refractory: [...REFRACT], steady: sim.steady, peak: best, staticCells, frames: Object.freeze(frames.map(f => Object.freeze(f))),
  };
}

/** The dynamic overlay for frame `t`, painted over `staticCells`: a pure function of `t mod T`.
 * Frames are precomputed and frozen, so this allocates nothing. */
export function tissueCellsAt(tissue: Tissue, t: number): TissueCell[] {
  return tissue.frames[mod(Math.floor(t), tissue.T)] as TissueCell[];
}
