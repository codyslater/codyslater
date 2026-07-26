/**
 * proto-dynamics.ts — THROWAWAY exploration prototype (2026-07-25 round).
 *
 * Cody locked the board vocabulary ("in general, love the background MB design")
 * and overhauled the dynamics:
 *
 *   "would like what the colors are doing to be much more dynamic, traveling
 *    through intricate path ways, interacting, rerouting, eliciting major
 *    responses when hitting components and turning the entire component a
 *    colour/view related to that colour. and also the colors seem to have been
 *    muted from original ones. ... and also i want pixels coming out of connects
 *    to be more of an oozing phenomenon, multiple colors, creates can be larger
 *    than that and more organic feel. right now it's like the pixels are just
 *    shooting out"
 *
 * This file reuses the approved board from proto-portrait.ts and explores only
 * the dynamics. Nothing here is production code.
 *
 *   npx tsx generator/proto-dynamics.ts --mode couriers|streams|ooze|compare [--vivid] [--seed N] [--out p]
 */

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { encodeGif } from './gif.js';
import { registerFonts } from './fonts.js';
import { mulberry32, randInt, type Rng } from './rng.js';
import { BOARD_RIGHT, CELL, FINGER_W, FINGERS, GRID_H, GRID_W, HEIGHT, WIDTH } from './layout.js';
import {
  ACCENT_LIST, baseOcc, buildA, box, cell, drawDressing, drawMountHole, drawSubstrate, drawTextLayer,
  LEVEL_LIT, mixOnBg, MOUNT_HOLES, P, px, shuffled,
  type Comp, type Ctx, type Net, type Pt, type Scene,
} from './proto-portrait.js';

// ---------------------------------------------------------------------------
// Colour policy — the "unmuted" question
// ---------------------------------------------------------------------------
// Current spec: trace bodies at 60 % accent-on-background, flows at 80 %.
// Cody: "the colors seem to have been muted from original ones."
// `vivid` renders traces and flows at the site tokens' full value.
interface Palette { trace: number; flowHead: number; flowTail: number; washCeil: number }
const MUTED: Palette = { trace: 0.60, flowHead: 1.0, flowTail: 0.55, washCeil: 0.85 };
const VIVID: Palette = { trace: 1.0, flowHead: 1.0, flowTail: 0.75, washCeil: 1.0 };

// The lit tone ladder, in order — the grays a wash remaps onto an accent ramp.
const LADDER = ['#0a0a0a', '#111111', '#1a1a1a', '#222222', '#444444', '#888888'] as const;
const WASH_STOPS = [0.10, 0.17, 0.27, 0.42, 0.66, 1.0];

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A flow has to out-read the copper it runs on. Now that traces are the pure
 * site token, a flow drawn *in* that token is invisible — so a flow is drawn
 * HOTTER than the trace: the accent blended toward white. The board stays fully
 * vivid and the motion still wins.
 */
function hot(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const up = (c: number) => Math.round(c + (255 - c) * k);
  return `#${((up(n >> 16) << 16) | (up((n >> 8) & 255) << 8) | up(n & 255)).toString(16).padStart(6, '0')}`;
}
const hexOf = (r: number, g: number, b: number) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

// ---------------------------------------------------------------------------
// Routing graph: components and connector fingers are nodes, nets are edges.
// This is what lets a colour *travel* — and choose a branch at each node.
// ---------------------------------------------------------------------------
interface GNode { center: Pt; comp: Comp | null; fingerIdx: number }
interface GEdge { a: number; b: number; cells: Pt[] }

interface Graph { nodes: GNode[]; edges: GEdge[]; adj: number[][] }

const distToRect = (p: Pt, r: { x: number; y: number; w: number; h: number }): number =>
  Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));

function buildGraph(scene: Scene): Graph {
  const nodes: GNode[] = scene.comps.map(c => ({
    center: { x: c.rect.x + (c.rect.w >> 1), y: c.rect.y + (c.rect.h >> 1) }, comp: c, fingerIdx: -1,
  }));
  FINGERS.forEach((f, i) => nodes.push({ center: { x: f.x + 1, y: f.y + 1 }, comp: null, fingerIdx: i }));

  const nearest = (p: Pt): number => {
    let best = -1, bestD = 8;
    nodes.forEach((n, i) => {
      const d = n.comp ? distToRect(p, n.comp.rect)
        : Math.max(Math.abs(p.x - n.center.x), Math.abs(p.y - n.center.y));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const edges: GEdge[] = [];
  for (const net of scene.nets) {
    if (net.spine.length < 4) continue;
    const a = nearest(net.spine[0]), b = nearest(net.spine[net.spine.length - 1]);
    if (a < 0 || b < 0 || a === b) continue;
    edges.push({ a, b, cells: net.spine });
  }
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  return { nodes, edges, adj };
}

/** Cells of edge `ei` oriented so they start at node `from`. */
const orient = (g: Graph, ei: number, from: number): Pt[] =>
  g.edges[ei].a === from ? g.edges[ei].cells : [...g.edges[ei].cells].reverse();

/**
 * ROUND 10 — COMPONENT TRANSIT.
 *
 * A net's spine deliberately stops 2–3 cells clear of the component it lands on
 * (the drawn copper overshoots underneath, but the spine does not). So a walk
 * built by concatenating edge spines JUMPED the whole component — measured at up
 * to 26 cells. That is both Cody's "discontinuities" and the reason a signal
 * always looked like it ended at a chip instead of passing through it.
 *
 * Every hop now goes spine-end -> component centre -> next spine-start as real
 * rectilinear cells. The path is 4-connected by construction, so the continuity
 * invariant holds automatically, and the flow is visibly drawn across the die of
 * every component it transits — entering one pin, crossing, leaving another.
 */
function segment(from: Pt, to: Pt, xFirst: boolean): Pt[] {
  const out: Pt[] = [];
  let { x, y } = from;
  const stepX = (): void => { while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, y }); } };
  const stepY = (): void => { while (y !== to.y) { y += Math.sign(to.y - y); out.push({ x, y }); } };
  if (xFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  return out;
}

/**
 * The canonical stub: cells from an edge's spine endpoint into its node's centre.
 * CANONICAL matters — the same function decides where a flow walks and where the
 * gray fabric is drawn, so a transit can never step off drawn copper.
 */
const stubPath = (p: Pt, c: Pt): Pt[] => segment(p, c, Math.abs(c.x - p.x) >= Math.abs(c.y - p.y));

/** spine-end -> component centre -> next spine-start, as contiguous cells. */
function transit(from: Pt, via: Pt, to: Pt): Pt[] {
  const inLeg = stubPath(from, via);
  const outLeg = [...stubPath(to, via)].reverse().slice(1);
  return [...inLeg, ...outLeg, { ...to }];
}

/**
 * ROUND 11 — THE GRAY FABRIC.
 *
 * Cody: "some of the paths are not on wire or anything, make sure everything
 * travels on a path, even if we need to have some gray background paths colors
 * can travel on."
 *
 * Measured: 766 of 5254 distinct on-board flow cells (14.6 %) sat on bare
 * substrate. They were all round-10 transit stubs — a net's spine stops 2–3 cells
 * clear of its component and `extendSpine` continues it straight in under the
 * body, but a transit turns toward the component's CENTRE, so the corner of that
 * turn left the copper.
 *
 * Rather than bend the walks back onto the traces, the board grows the missing
 * interconnect: every node/edge incidence gets a neutral gray stub in `#444444`
 * — dimmer than any active colour, brighter than the `#0e0e0e`–`#222222`
 * dressing, so it reads as the board's ordinary fabric. A colour travelling over
 * it lights it locally through the flow's own hot rendering, exactly like copper.
 */
function fabricCells(g: Graph): Pt[] {
  const out: Pt[] = [];
  for (const e of g.edges) {
    if (!e.cells.length) continue;
    const ends: [number, Pt][] = [[e.a, e.cells[0]], [e.b, e.cells[e.cells.length - 1]]];
    for (const [node, endpoint] of ends)
      out.push({ ...endpoint }, ...stubPath(endpoint, g.nodes[node].center));
  }
  return out;
}

/**
 * Append edge `ei` (oriented away from node `cur`) to `path`, crossing `cur`'s
 * own component on the way in. This is the single place a walk grows, so no
 * caller can reintroduce a teleport.
 */
function pushHop(g: Graph, path: Pt[], cur: number, ei: number): { cells: Pt[]; pinAt: number } {
  const cells = orient(g, ei, cur);
  if (!cells.length) return { cells, pinAt: Math.max(0, path.length - 1) };
  if (!path.length) path.push({ ...g.nodes[cur].center });
  // The PIN index: the last cell before the flow leaves the copper and enters the
  // part. This is what a takeover is anchored to — "flow arrives at a component's
  // pin -> the component takes the colour -> the flow continues out another pin".
  // Anchoring to the spine end instead (round 9) fired the wash before the flow
  // had reached the part and let it fade mid-crossing, so at 4x a signal could be
  // seen sliding through an unlit chip as a detached stub.
  const pinAt = path.length - 1;
  const link = transit(path[path.length - 1], g.nodes[cur].center, cells[0]);
  path.push(...link);
  path.push(...cells.slice(link.length ? 1 : 0));
  return { cells, pinAt };
}

/** Walk into a node and stop on it, so a journey ends on the part it reached. */
function pushInto(g: Graph, path: Pt[], node: number): number {
  if (!path.length) return 0;
  const pinAt = path.length - 1;
  path.push(...stubPath(path[path.length - 1], g.nodes[node].center));
  return pinAt;
}

interface Route { path: Pt[]; stops: { at: number; node: number }[] }

/**
 * A closed walk through the graph: the colour wanders the maze, picking a
 * different branch at each junction, and returns to where it began so the whole
 * thing is periodic. Rerouting is not decoration — at every node with degree > 1
 * the walk genuinely chooses, and it will take a different exit next time it
 * passes through.
 */
function buildRoute(rng: Rng, g: Graph, start: number, minLen: number): Route | null {
  const path: Pt[] = [];
  const stops: { at: number; node: number }[] = [];
  let cur = start, lastEdge = -1;
  for (let guard = 0; guard < 60 && path.length < minLen; guard++) {
    const opts = g.adj[cur].filter(e => e !== lastEdge);
    const choices = opts.length ? opts : g.adj[cur];
    if (!choices.length) break;
    const ei = choices[Math.floor(rng() * choices.length)];
    const { pinAt } = pushHop(g, path, cur, ei);
    stops.push({ at: pinAt, node: cur });
    cur = g.edges[ei].a === cur ? g.edges[ei].b : g.edges[ei].a;
    lastEdge = ei;
  }
  if (path.length < 12) return null;
  // close the walk: BFS back to the start node
  const prev = new Map<number, { node: number; edge: number }>();
  const q = [cur]; const seen = new Set([cur]);
  while (q.length) {
    const n = q.shift()!;
    if (n === start) break;
    for (const ei of g.adj[n]) {
      const o = g.edges[ei].a === n ? g.edges[ei].b : g.edges[ei].a;
      if (seen.has(o)) continue;
      seen.add(o); prev.set(o, { node: n, edge: ei }); q.push(o);
    }
  }
  if (cur !== start) {
    if (!seen.has(start)) return null;
    const back: { node: number; edge: number }[] = [];
    for (let n = start; n !== cur;) { const p = prev.get(n)!; back.push({ node: n, edge: p.edge }); n = p.node; }
    back.reverse();
    let node = cur;
    for (const step of back) {
      const { pinAt } = pushHop(g, path, node, step.edge);
      stops.push({ at: pinAt, node });
      node = step.node;
    }
  }
  // close the cycle in space as well as in topology: the last cell has to be
  // adjacent to the first, or the wrap frame shows the comet snapping back
  if (path.length > 1) path.push(...stubPath(path[path.length - 1], path[0]).slice(0, -1));
  return { path, stops };
}

// ---------------------------------------------------------------------------
// Component wash — "major responses when hitting components"
// ---------------------------------------------------------------------------
interface Hit { frame: number; color: string; hold?: number }

/** When each courier reaches each node, as frames within the loop. */
function collectHits(routes: Route[], colors: string[], T: number): Map<number, Hit[]> {
  const hits = new Map<number, Hit[]>();
  routes.forEach((r, ri) => {
    const L = r.path.length;
    for (const s of r.stops) {
      const frame = mod(Math.round((s.at / L) * T), T);
      const list = hits.get(s.node) ?? [];
      list.push({ frame, color: colors[ri] });
      hits.set(s.node, list);
    }
  });
  return hits;
}

const HOLD = 14, FADE = 16;   // frames a component keeps a colour, then releases it

/** The colour currently owning a node, and how strongly (0..1). */
function washAt(hits: Hit[] | undefined, t: number, T: number): { color: string; k: number } | null {
  if (!hits) return null;
  let best: { color: string; k: number; age: number } | null = null;
  for (const h of hits) {
    const hold = h.hold ?? HOLD;
    const age = mod(t - h.frame, T);
    if (age > hold + FADE) continue;
    const k = age <= hold ? 1 : 1 - (age - hold) / FADE;
    if (!best || age < best.age) best = { color: h.color, k, age };
  }
  return best ? { color: best.color, k: best.k } : null;
}

/**
 * Repaint a whole component in an accent. Every gray of the lit tone ladder is
 * remapped onto the accent's own ramp, so the body, frame, pins and lid all take
 * the colour — the component becomes a coloured *view* of itself rather than a
 * gray box with a coloured dot.
 */
function washComp(ctx: Ctx, base: Uint8ClampedArray, comp: Comp, accent: string, k: number, ceil: number): number {
  const map = new Map<string, string>();
  LADDER.forEach((gray, i) => map.set(gray, mixOnBg(accent, Math.min(1, WASH_STOPS[i] * ceil * k))));
  const r = comp.rect;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      const i = ((y * CELL) * WIDTH + x * CELL) * 4;
      const hex = hexOf(base[i], base[i + 1], base[i + 2]);
      const to = map.get(hex);
      if (!to) continue;              // accent pins and non-ladder pixels stay
      cell(ctx, x, y, to);
      n++;
    }
  return n;
}

// ---------------------------------------------------------------------------
// Board base layer (everything that does not move)
// ---------------------------------------------------------------------------
interface Board { scene: Scene; graph: Graph; fabric: Pt[]; base: Canvas; baseData: Uint8ClampedArray }

function buildBoard(seed: number, pal: Palette): Board {
  registerFonts();
  const rng = mulberry32(seed);
  const occ = baseOcc();
  const scene = buildA(rng, occ);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  drawSubstrate(ctx);
  for (const h of MOUNT_HOLES) drawMountHole(ctx, h);
  drawDressing(ctx, scene.dressing);
  for (const s of scene.silk) s(ctx, LEVEL_LIT);
  for (const n of scene.nets) for (const c of n.cells) cell(ctx, c.x, c.y, mixOnBg(n.color, pal.trace));
  // neutral interconnect fabric, under the hardware and never over a live trace
  const graph = buildGraph(scene);
  const fabric = fabricCells(graph);
  const onNet = new Set(scene.nets.flatMap(n => n.cells.map(c => `${c.x},${c.y}`)));
  for (const c of fabric) if (!onNet.has(`${c.x},${c.y}`)) cell(ctx, c.x, c.y, P.dim);
  for (const c of scene.comps) c.draw(ctx, LEVEL_LIT);
  for (const f of FINGERS) box(ctx, f.x, f.y, FINGER_W, f.h, P.gold);
  drawTextLayer(ctx, seed);
  return {
    scene, graph, fabric, base: canvas,
    baseData: ctx.getImageData(0, 0, WIDTH, HEIGHT).data,
  };
}

// ---------------------------------------------------------------------------
// Treatment A — many small couriers   /   Treatment B — long flowing streams
// ---------------------------------------------------------------------------
interface Flow { route: Route; color: string; trail: number; speedPhase: number }

function buildFlows(rng: Rng, g: Graph, count: number, trail: number, minLen: number): Flow[] {
  const accents = ACCENT_LIST;
  const seeds = shuffled(rng, g.nodes.map((_, i) => i).filter(i => g.adj[i].length > 0));
  const flows: Flow[] = [];
  for (let i = 0; i < seeds.length && flows.length < count; i++) {
    const r = buildRoute(rng, g, seeds[i], minLen);
    if (!r) continue;
    flows.push({ route: r, color: accents[flows.length % accents.length], trail, speedPhase: rng() });
  }
  return flows;
}

function drawFlows(ctx: Ctx, flows: Flow[], t: number, T: number, pal: Palette): void {
  for (const f of flows) {
    const L = f.route.path.length;
    const head = (t / T + f.speedPhase) * L;
    for (let d = f.trail - 1; d >= 0; d--) {
      const p = f.route.path[mod(Math.round(head - d), L)];
      if (!p) continue;
      const u = 1 - d / f.trail;
      // comet: a white-hot leading cell, two cells of pure accent behind it, then
      // a quadratic falloff. Without the white core the flow is indistinguishable
      // from the copper it runs on — the motion has to out-read the static trace.
      if (d === 0) { cell(ctx, p.x, p.y, P.white); continue; }
      if (d <= 2) { cell(ctx, p.x, p.y, f.color); continue; }
      const a = pal.flowTail * u * u;
      if (a < 0.06) continue;
      cell(ctx, p.x, p.y, mixOnBg(f.color, a));
    }
  }
}

/**
 * Two colours holding the same component at once — the interaction. The body
 * keeps the first colour's wash and the component's own outer ring takes the
 * second, so the part reads as *contested* rather than wearing a marquee. (An
 * alternating dotted ring was tried first and read as a selection box.)
 */
function drawInteractions(ctx: Ctx, g: Graph, base: Uint8ClampedArray, hits: Map<number, Hit[]>,
  t: number, T: number, pal: Palette): number {
  let contested = 0;
  hits.forEach((list, node) => {
    const active = list.filter(h => mod(t - h.frame, T) <= HOLD);
    const cols = [...new Set(active.map(h => h.color))];
    if (cols.length < 2) return;
    const comp = g.nodes[node].comp;
    if (!comp) return;
    contested++;
    const r = comp.rect;
    const second = cols[1];
    const map = new Map<string, string>();
    LADDER.forEach((gray, i) => map.set(gray, mixOnBg(second, Math.min(1, WASH_STOPS[i] * pal.washCeil))));
    const ring = (x: number, y: number) => {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
      const i = ((y * CELL) * WIDTH + x * CELL) * 4;
      const to = map.get(hexOf(base[i], base[i + 1], base[i + 2]));
      if (to) cell(ctx, x, y, to);
    };
    for (let x = r.x; x < r.x + r.w; x++) { ring(x, r.y); ring(x, r.y + r.h - 1); }
    for (let y = r.y; y < r.y + r.h; y++) { ring(r.x, y); ring(r.x + r.w - 1, y); }
  });
  return contested;
}

function renderDynamicFrame(b: Board, flows: Flow[], hits: Map<number, Hit[]>, t: number, T: number, pal: Palette): Canvas {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(b.base, 0, 0);
  hits.forEach((list, node) => {
    const w = washAt(list, t, T);
    const comp = b.graph.nodes[node].comp;
    if (!w || !comp) return;
    washComp(ctx, b.baseData, comp, w.color, w.k, pal.washCeil);
  });
  hits.forEach((list, node) => {
    const w = washAt(list, t, T);
    const fi = b.graph.nodes[node].fingerIdx;
    if (!w || fi < 0) return;
    const f = FINGERS[fi];
    box(ctx, f.x, f.y, FINGER_W, f.h, mixOnBg(w.color, Math.min(1, 0.9 * w.k)));
  });
  drawInteractions(ctx, b.graph, b.baseData, hits, t, T, pal);
  drawFlows(ctx, flows, t, T, pal);
  return canvas;
}

// ---------------------------------------------------------------------------
// Escape routing — "more paths making it from various sources on the boards
// into the connector streams that can then escape" (Cody, 2026-07-25)
// ---------------------------------------------------------------------------
//
// The connector stops being scenery and becomes the destination. A stream is
// launched from a source somewhere on the board, works its way through the
// routing — still choosing branches at junctions, so the maze stays alive — and
// arrives at a gold finger, where it flows OUT of the board. Its trail drains
// through the gold, the flow goes dark for exactly one trail-length, and it
// relaunches from a different source. Two journeys per loop, concatenated into
// one cyclic path, so the whole thing stays periodic by construction.

/** Graph distance from every node to the nearest connector finger. */
function distanceToConnector(g: Graph): number[] {
  const dist = g.nodes.map(() => Infinity);
  const q: number[] = [];
  g.nodes.forEach((n, i) => { if (n.fingerIdx >= 0) { dist[i] = 0; q.push(i); } });
  while (q.length) {
    const n = q.shift()!;
    for (const ei of g.adj[n]) {
      const o = g.edges[ei].a === n ? g.edges[ei].b : g.edges[ei].a;
      if (dist[o] <= dist[n] + 1) continue;
      dist[o] = dist[n] + 1;
      q.push(o);
    }
  }
  return dist;
}

/** Graph distance from every node to one specific node (used to aim at one finger). */
function distanceToNode(g: Graph, target: number): number[] {
  const dist = g.nodes.map(() => Infinity);
  dist[target] = 0;
  const q = [target];
  while (q.length) {
    const n = q.shift()!;
    for (const ei of g.adj[n]) {
      const o = g.edges[ei].a === n ? g.edges[ei].b : g.edges[ei].a;
      if (dist[o] <= dist[n] + 1) continue;
      dist[o] = dist[n] + 1;
      q.push(o);
    }
  }
  return dist;
}

interface Journey { cells: Pt[]; stops: { at: number; node: number }[]; finger: number }

/**
 * Cody: "there should be pixels released from all the connector interfaces on the
 * right not just that middle one, routes from elsewhere on the board should make
 * it to all of them." So a journey is now *aimed*: it walks a distance field
 * computed to one specific finger node rather than to the connector in general.
 * The branch-choosing character is unchanged — it still detours a quarter of the
 * time — but every one of the nine fingers gets its own fed route.
 */
function buildJourneyTo(rng: Rng, g: Graph, start: number, target: number, dTo: number[]): Journey | null {
  if (!Number.isFinite(dTo[start])) return null;
  const cells: Pt[] = [];
  const stops: { at: number; node: number }[] = [];
  let cur = start, lastEdge = -1;
  for (let step = 0; step < 30; step++) {
    if (cur === target) {
      stops.push({ at: pushInto(g, cells, cur), node: cur });
      return { cells, stops, finger: g.nodes[cur].fingerIdx };
    }
    const opts = g.adj[cur].map(ei => ({ ei, o: g.edges[ei].a === cur ? g.edges[ei].b : g.edges[ei].a }))
      .filter(c => c.ei !== lastEdge && Number.isFinite(dTo[c.o]));
    if (!opts.length) break;
    const closer = opts.filter(c => dTo[c.o] < dTo[cur]);
    // detour only while there is still room to get back — the last two hops commit
    const pool = closer.length && (rng() < 0.75 || dTo[cur] <= 2) ? closer : opts;
    const pickd = pool[Math.floor(rng() * pool.length)];
    const { pinAt } = pushHop(g, cells, cur, pickd.ei);
    stops.push({ at: pinAt, node: cur });
    cur = pickd.o;
    lastEdge = pickd.ei;
  }
  return null;
}

/**
 * One source -> connector journey. At each junction the walk prefers an edge
 * that gets it closer to the connector, but takes a detour a quarter of the
 * time — so it reads as finding its way through the maze rather than following
 * a printed arrow, and two runs from the same source differ.
 */
function buildJourney(rng: Rng, g: Graph, start: number, dToC: number[]): Journey | null {
  const cells: Pt[] = [];
  const stops: { at: number; node: number }[] = [{ at: 0, node: start }];
  let cur = start, lastEdge = -1;
  for (let step = 0; step < 26; step++) {
    if (g.nodes[cur].fingerIdx >= 0) return { cells, stops, finger: g.nodes[cur].fingerIdx };
    const opts = g.adj[cur].map(ei => ({ ei, o: g.edges[ei].a === cur ? g.edges[ei].b : g.edges[ei].a }))
      .filter(c => c.ei !== lastEdge);
    if (!opts.length) break;
    const closer = opts.filter(c => dToC[c.o] < dToC[cur]);
    const pool = closer.length && rng() < 0.75 ? closer : opts;
    const pickd = pool[Math.floor(rng() * pool.length)];
    cells.push(...orient(g, pickd.ei, cur));
    cur = pickd.o;
    lastEdge = pickd.ei;
    stops.push({ at: cells.length, node: cur });
  }
  return null;
}

/** The visible exit: through the gold finger and out into the void. */
function exitCells(fingerIdx: number): Pt[] {
  const f = FINGERS[fingerIdx];
  const out: Pt[] = [];
  for (let x = f.x; x <= BOARD_RIGHT + 8; x++) out.push({ x, y: f.y + 1 });
  return out;
}

interface EscapeEvent { frame: number; finger: number; color: string }
interface EscFlow { path: (Pt | null)[]; stops: { at: number; node: number }[]; color: string; trail: number; escapes: { at: number; finger: number }[] }

/** Sources spread over the whole board, so the entire maze participates. */
function pickSources(rng: Rng, g: Graph, dToC: number[], n: number): number[] {
  const eligible = g.nodes
    .map((nd, i) => ({ i, nd }))
    .filter(({ i, nd }) => nd.comp && g.adj[i].length > 0 && dToC[i] >= 2 && dToC[i] < Infinity);
  // bucket by board thirds x thirds so west pads, mid ICs and far corners all fire
  const bucket = ({ nd }: { nd: GNode }) =>
    Math.min(2, Math.floor(nd.center.x / 78)) * 3 + Math.min(2, Math.floor(nd.center.y / 22));
  const byBucket = new Map<number, number[]>();
  for (const e of eligible) {
    const b = bucket(e);
    byBucket.set(b, [...(byBucket.get(b) ?? []), e.i]);
  }
  const order = shuffled(rng, [...byBucket.keys()]);
  const out: number[] = [];
  for (let round = 0; out.length < n && round < 6; round++)
    for (const b of order) {
      const pool = byBucket.get(b)!;
      if (round < pool.length && out.length < n) out.push(shuffled(rng, pool)[round % pool.length]);
    }
  return out;
}

function buildEscapeFlows(rng: Rng, g: Graph, dToC: number[], count: number, trail: number): EscFlow[] {
  const sources = pickSources(rng, g, dToC, count * 4);
  const flows: EscFlow[] = [];
  let si = 0;
  while (flows.length < count && si < sources.length) {
    const path: (Pt | null)[] = [];
    const stops: { at: number; node: number }[] = [];
    const escapes: { at: number; finger: number }[] = [];
    let ok = true;
    for (let leg = 0; leg < 2; leg++) {           // two journeys per loop
      let j: Journey | null = null;
      for (let tries = 0; tries < 6 && !j && si < sources.length; tries++) j = buildJourney(rng, g, sources[si++], dToC);
      if (!j) { ok = false; break; }
      const off = path.length;
      for (const st of j.stops) stops.push({ at: off + st.at, node: st.node });
      path.push(...j.cells);
      escapes.push({ at: path.length, finger: j.finger });
      path.push(...exitCells(j.finger));
      for (let k = 0; k < trail + 2; k++) path.push(null);   // drain, then relaunch
    }
    if (!ok || path.length < 40) continue;
    flows.push({ path, stops, color: ACCENT_LIST[flows.length % ACCENT_LIST.length], trail, escapes });
  }
  return flows;
}

function drawEscapeFlows(ctx: Ctx, flows: EscFlow[], t: number, T: number, pal: Palette): void {
  for (const f of flows) {
    const L = f.path.length;
    const head = (t / T) * L;
    for (let d = f.trail - 1; d >= 0; d--) {
      const p = f.path[mod(Math.round(head - d), L)];
      if (!p) continue;
      if (d === 0) { cell(ctx, p.x, p.y, P.white); continue; }
      if (d <= 2) { cell(ctx, p.x, p.y, f.color); continue; }
      const u = 1 - d / f.trail;
      const a = pal.flowTail * u * u;
      if (a >= 0.06) cell(ctx, p.x, p.y, mixOnBg(f.color, a));
    }
  }
}

const escapeEvents = (flows: EscFlow[], T: number): EscapeEvent[] =>
  flows.flatMap(f => f.escapes.map(e => ({
    frame: mod(Math.round((e.at / f.path.length) * T), T), finger: e.finger, color: f.color,
  }))).sort((a, b) => a.frame - b.frame);

// ---------------------------------------------------------------------------
// Ooze genesis — viscous, clumpy, multi-colour accretion
// ---------------------------------------------------------------------------
interface OozeCell { x: number; y: number; color: string; clump: number }

/**
 * Eden-style growth: repeatedly attach a new cell to a random boundary cell of
 * the existing mass, preferring positions with more occupied neighbours. That
 * yields a compact, lumpy, *organic* silhouette — no mirror symmetry — instead
 * of the current rigid 12x12 profile blob.
 */
function growOoze(rng: Rng, n: number, colors: string[]): OozeCell[] {
  const occupied = new Map<string, OozeCell>();
  const key = (x: number, y: number) => `${x},${y}`;
  let clump = 0, inClump = 0;
  const put = (x: number, y: number) => {
    if (inClump >= randInt(rng, 3, 6)) { clump++; inClump = 0; }
    inClump++;
    occupied.set(key(x, y), { x, y, color: colors[clump % colors.length], clump });
  };
  put(0, 0);
  while (occupied.size < n) {
    const cells = [...occupied.values()];
    let best: { x: number; y: number; score: number } | null = null;
    for (let tries = 0; tries < 14; tries++) {
      const c = cells[Math.floor(rng() * cells.length)];
      const dx = randInt(rng, -1, 1), dy = randInt(rng, -1, 1);
      if (!dx && !dy) continue;
      const nx = c.x + dx, ny = c.y + dy;
      if (occupied.has(key(nx, ny))) continue;
      let score = 0;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) if (occupied.has(key(nx + ox, ny + oy))) score++;
      if (Math.abs(ny) > 7) score -= 3;              // keep it wider than it is tall
      if (!best || score > best.score) best = { x: nx, y: ny, score };
    }
    if (best) put(best.x, best.y);
  }
  return [...occupied.values()];
}

const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

/**
 * Ooze, not projectiles. Material is *extruded*: a viscous ribbon reaches out of
 * the finger to the growth front, thick at the lip and tapering, wobbling as it
 * goes; the clump at its tip thickens and then freezes onto the mass, and the
 * ribbon necks off and retracts before the next clump is pushed out. The body
 * accretes right at the connector's lip and grows outward, so the creature
 * visibly comes *out of* the board rather than being assembled at a distance.
 */
const CLUMP = 5;          // cells that settle together — clumpy, not pixel-at-a-time
const EXTRUDE = 13;       // frames a clump spends being pushed out

function renderOozeFrame(b: Board, body: OozeCell[], site: Pt, srcs: Pt[], t: number, T: number, pal: Palette): Canvas {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(b.base, 0, 0);

  const clumps: OozeCell[][] = [];
  for (let i = 0; i < body.length; i += CLUMP) clumps.push(body.slice(i, i + CLUMP));
  const settleEnd = Math.floor(T * 0.94);
  const landAt = (ci: number) => Math.round(((ci + 1) / clumps.length) * settleEnd);

  clumps.forEach((clump, ci) => {
    const land = landAt(ci);
    const src = srcs[ci % srcs.length];
    const color = clump[0].color;
    const cx = site.x + clump.reduce((a, c) => a + c.x, 0) / clump.length;
    const cy = site.y + clump.reduce((a, c) => a + c.y, 0) / clump.length;

    if (t >= land) { for (const c of clump) cell(ctx, site.x + c.x, site.y + c.y, c.color); return; }
    const age = t - (land - EXTRUDE);
    if (age < 0) return;
    const u = ease(age / EXTRUDE);

    // the ribbon: finger lip -> clump centroid, thick at the lip, tapering,
    // sagging and wobbling like something with surface tension
    const tipX = src.x + (cx - src.x) * u, tipY = src.y + (cy - src.y) * u;
    const span = Math.max(1, Math.round(Math.hypot(tipX - src.x, tipY - src.y)));
    for (let s = 0; s <= span; s++) {
      const v = s / span;
      const x = src.x + (tipX - src.x) * v;
      const y = src.y + (tipY - src.y) * v
        + Math.sin(v * Math.PI) * (2.2 - 1.6 * u)                 // sag, pulled taut as it stretches
        + Math.sin(v * 5 + t * 0.4) * 0.5 * (1 - v);              // wobble near the lip
      const neck = 1 - u * 0.85;                                   // the ribbon necks off as it stretches
      const thick = v < 0.3 ? 3 * neck : v > 0.8 ? 2.2 : 2 * neck;
      const a = 0.45 + 0.4 * v;
      for (let w = 0; w < Math.max(1, Math.round(thick)); w++)
        cell(ctx, Math.round(x), Math.round(y) + w, mixOnBg(color, Math.min(1, a * (pal.trace > 0.8 ? 1.15 : 1))));
    }
    // the bulge at the tip thickens into the clump's own cells as it lands
    const shown = Math.floor(clump.length * Math.min(1, (age + 1) / EXTRUDE));
    clump.slice(0, shown).forEach((c, k) => {
      const w = 1 - Math.min(1, (age + 1) / EXTRUDE);
      cell(ctx, Math.round(site.x + c.x - (site.x + c.x - tipX) * w),
        Math.round(site.y + c.y - (site.y + c.y - tipY) * w), c.color);
      void k;
    });
  });

  // a bead of colour always standing on the lip of each emitting finger
  srcs.forEach((s, i) => {
    const color = body[Math.min(body.length - 1, i * CLUMP)].color;
    const swell = 1 + Math.round(Math.abs(Math.sin((t / T) * Math.PI * 6 + i * 1.7)) * 2);
    for (let d = 0; d < swell; d++)
      for (let w = 0; w < (d === 0 ? 3 : 2); w++)
        cell(ctx, s.x + d, s.y - 1 + w, mixOnBg(color, 0.85 - 0.12 * d));
  });
  return canvas;
}

// ---------------------------------------------------------------------------
// The blend: couriers feed streams, streams feed the interface
// ---------------------------------------------------------------------------
//
// Cody loves both treatments, and they compose into one directed ecosystem:
// small fast COURIERS launch from sources all over the board and run local
// journeys into a trunk hub; a long flowing STREAM departs that hub the instant
// a courier arrives, carrying the colour through the routing to a gold finger,
// where it ESCAPES the board; the escape then feeds the ooze. Many sources ->
// maze -> trunks -> connector -> life.
//
// Timing is slot-exact rather than approximate: every flow owns an array of
// exactly `T * SLOTS_PER_FRAME` entries, so a courier's final cell and its
// stream's first cell can be placed on the *same* slot. The merge is causal by
// construction, and the whole schedule is cyclic mod T with no seam handling.

const SLOTS_PER_FRAME = 3;   // cells a flow advances per frame

interface Sched {
  slots: (Pt | null)[];
  trail: number;
  color: string;
  kind: 'courier' | 'stream' | 'interior';
  stops: { at: number; node: number }[];   // slot indices
  thread?: { from: number; to: number; color: string };  // a courier's colour woven into a stream's tail
}

function placeBlock(slots: (Pt | null)[], cells: Pt[], endSlot: number): number {
  const start = mod(endSlot - cells.length, slots.length);
  for (let i = 0; i < cells.length; i++) slots[mod(start + i, slots.length)] = cells[i];
  return start;
}

interface Blend { flows: Sched[]; events: EscapeEvent[] }

/**
 * Components a stream must transit before it reaches the gold. This is the knob
 * that turns "the colour arrives at a chip and stops" into "the signal travels
 * through the machine's organs to the interface".
 */
const MIN_TRANSITS = 3;

/**
 * ROUND 9 — ONE STREAM PER FINGER.
 *
 * Cody: "there should be pixels released from all the connector interfaces on
 * the right not just that middle one". The old build let each journey stop at
 * whatever finger it happened to reach first, and since the board's three bands
 * were disjoint trees whose only connector-reachable hub was the row-M one,
 * every journey ended in the middle group. The board fabric fix makes all nine
 * reachable; this schedules exactly one stream per finger, staggered around the
 * loop, so the whole gold interface takes turns.
 *
 * Escapes are scheduled escape-FIRST — the arrival frame is what the void cares
 * about — and departure is back-computed. Every slot index is taken mod N, so a
 * stream whose departure lands before frame 0 simply starts before the wrap and
 * arrives after it: circular by construction.
 */
function buildBlend(rng: Rng, g: Graph, dToC: number[], T: number): Blend {
  const N = T * SLOTS_PER_FRAME;
  const flows: Sched[] = [];
  const events: EscapeEvent[] = [];

  // Trunk hubs: well-connected nodes already close to the connector. These are
  // where couriers hand off and streams are born.
  const hubs = g.nodes
    .map((n, i) => ({ i, n, deg: g.adj[i].length, d: dToC[i] }))
    .filter(h => h.n.comp && h.deg >= 2 && h.d >= 2 && h.d <= 6)
    .sort((a, b) => b.deg - a.deg || a.d - b.d)
    .slice(0, 9);
  const chosen = shuffled(rng, hubs);
  const sources = pickSources(rng, g, dToC, 40);
  let si = 0;
  const nextSource = (): number => sources[(si++) % sources.length];

  const fingerNodes = g.nodes
    .map((n, i) => ({ i, f: n.fingerIdx })).filter(x => x.f >= 0)
    .sort((a, b) => a.f - b.f);
  // stagger which finger goes when, so consecutive escapes are not a top-to-bottom sweep
  const order = shuffled(rng, fingerNodes);

  order.forEach((fn, m) => {
    const escFrame = mod(Math.round(((m + 0.5 + (rng() - 0.5) * 0.5) / order.length) * T), T);
    const dTo = distanceToNode(g, fn.i);

    // ROUND 10 — start streams DEEP in the board, not at a trunk hub.
    //
    // Cody: "i'd still like more signals to be able to propagate through
    // components over to connector". A hub sits 2–6 hops from the connector, so a
    // hub-launched stream transited one or two parts and was done. Launching from
    // the far side means the signal has to cross the machine's organs to get out:
    // source -> IC -> IC -> trunk -> finger, every hop visibly lighting.
    const far = g.nodes
      .map((n, i) => ({ i, d: dTo[i] }))
      .filter(c => g.nodes[c.i].comp && Number.isFinite(c.d) && c.d >= MIN_TRANSITS)
      .sort((a2, b2) => b2.d - a2.d);
    const reach = far.length ? far : chosen.filter(h => Number.isFinite(dTo[h.i])).map(h => ({ i: h.i, d: dTo[h.i] }));
    if (!reach.length) return;

    // prefer the deepest starts, but keep it seeded so the day varies
    const deep = reach.slice(0, Math.max(3, Math.ceil(reach.length * 0.5)));
    let journey: Journey | null = null;
    let start = deep[0].i;
    for (let k = 0; k < 24 && !journey; k++) {
      start = deep[(m * 5 + k * 3 + 1) % deep.length].i;
      const j = buildJourneyTo(rng, g, start, fn.i, dTo);
      // insist on a real chain of parts, not a hop next door
      if (j && j.stops.filter(st => g.nodes[st.node].comp).length >= MIN_TRANSITS) journey = j;
    }
    if (!journey) for (let k = 0; k < 12 && !journey; k++) journey = buildJourneyTo(rng, g, start, fn.i, dTo);
    if (!journey || !journey.cells.length) return;
    const hub = { i: start };

    const courierColor = ACCENT_LIST[m % ACCENT_LIST.length];
    const streamColor = ACCENT_LIST[(m + 2) % ACCENT_LIST.length];

    // --- the stream: deep source -> this finger -> out of the board ---
    const exit = exitCells(fn.f);
    const streamCells = [...journey.cells,
      ...segment(journey.cells[journey.cells.length - 1], exit[0],
        Math.abs(exit[0].x - journey.cells[journey.cells.length - 1].x)
        >= Math.abs(exit[0].y - journey.cells[journey.cells.length - 1].y)).slice(0, -1),
      ...exit];
    const sSlots: (Pt | null)[] = new Array(N).fill(null);
    const arriveSlot = escFrame * SLOTS_PER_FRAME;
    const sStart = placeBlock(sSlots, streamCells, mod(arriveSlot - journey.cells.length, N) + streamCells.length);
    flows.push({
      slots: sSlots, trail: 24, color: streamColor, kind: 'stream',
      stops: journey.stops.map(st => ({ at: mod(sStart + st.at, N), node: st.node })),
      thread: { from: sStart, to: sStart + 12, color: courierColor },
    });
    events.push({
      frame: mod(Math.round((sStart + journey.cells.length) / SLOTS_PER_FRAME), T),
      finger: fn.f, color: streamColor,
    });

    // --- the courier that feeds it: a source somewhere on the board -> the
    //     stream's launch point, arriving on the exact slot the stream departs ---
    //
    // ROUND 10: this used to be a random wander that was *hoped* to pass through
    // the launch point, with a reversed-prefix fallback when it did not. The
    // fallback carried NO stops, so those couriers slid straight across every
    // component they crossed without lighting any of them — a signal visibly
    // passing through a chip that stayed dark. Measured at seed 20260724: the
    // green courier crossed the CPU socket at frames 268–274 with the socket
    // unwashed. Couriers are now aimed walks into the launch point, using the
    // same machinery as the streams, so they transit and light like everything else.
    const dToStart = distanceToNode(g, hub.i);
    let feed: Journey | null = null;
    for (let k = 0; k < 14 && !feed; k++) {
      const src = nextSource();
      if (src === hub.i || !Number.isFinite(dToStart[src])) continue;
      feed = buildJourneyTo(rng, g, src, hub.i, dToStart);
    }
    if (!feed) {
      // last resort: start from the nearest node that can reach the launch point
      const near = g.nodes
        .map((n, i) => ({ i, d: dToStart[i] }))
        .filter(c => g.nodes[c.i].comp && c.i !== hub.i && Number.isFinite(c.d) && c.d >= 1)
        .sort((x, y) => x.d - y.d)[0];
      if (near) for (let k = 0; k < 8 && !feed; k++) feed = buildJourneyTo(rng, g, near.i, hub.i, dToStart);
    }
    if (!feed || !feed.cells.length) return;
    // land the courier exactly where the stream begins, so the handoff is one
    // continuous motion rather than two flows that happen to be near each other
    const join = segment(feed.cells[feed.cells.length - 1], streamCells[0],
      Math.abs(streamCells[0].x - feed.cells[feed.cells.length - 1].x)
      >= Math.abs(streamCells[0].y - feed.cells[feed.cells.length - 1].y));
    feed.cells.push(...join);
    const cSlots: (Pt | null)[] = new Array(N).fill(null);
    const cStart = placeBlock(cSlots, feed.cells, sStart);
    flows.push({
      slots: cSlots, trail: 7, color: courierColor, kind: 'courier',
      stops: feed.stops.map(st => ({ at: mod(cStart + st.at, N), node: st.node })),
    });
  });

  // a couple of interior wanderers: pure interaction, never leaves the board
  for (let i = 0; i < 2; i++) {
    const r = buildRoute(rng, g, nextSource(), 150);
    if (!r) continue;
    const slots: (Pt | null)[] = new Array(N).fill(null);
    for (let k = 0; k < N; k++) slots[k] = r.path[Math.floor((k / N) * r.path.length)];
    flows.push({
      slots, trail: 14, color: ACCENT_LIST[(i + 3) % ACCENT_LIST.length], kind: 'interior',
      stops: r.stops.map(st => ({ at: Math.round((st.at / r.path.length) * N), node: st.node })),
    });
  }
  return { flows, events };
}

function drawBlend(ctx: Ctx, flows: Sched[], t: number, T: number, pal: Palette): void {
  const N = T * SLOTS_PER_FRAME;
  // couriers under streams, so a merge reads as the small flow being absorbed
  for (const kind of ['interior', 'courier', 'stream'] as const)
    for (const f of flows) {
      if (f.kind !== kind) continue;
      const head = Math.round(t * SLOTS_PER_FRAME);
      for (let d = f.trail - 1; d >= 0; d--) {
        const idx = mod(head - d, N);
        const p = f.slots[idx];
        if (!p) continue;
        // a courier's colour threaded into the first stretch of the stream it fed
        const woven = f.thread && mod(idx - f.thread.from, N) <= f.thread.to - f.thread.from;
        const col = woven ? f.thread!.color : f.color;
        if (d === 0) { cell(ctx, p.x, p.y, P.white); continue; }
        const u = 1 - d / f.trail;
        if (d <= 3) { cell(ctx, p.x, p.y, hot(col, 0.55 * u)); continue; }
        if (u > 0.45) { cell(ctx, p.x, p.y, hot(col, 0.3 * u)); continue; }
        const a = Math.max(pal.flowTail, 0.75) * (u * 2) ** 2;
        if (a >= 0.12) cell(ctx, p.x, p.y, mixOnBg(col, Math.min(1, a)));
      }
    }
}

// ---------------------------------------------------------------------------
// The combined view: maze -> connector -> escape -> genesis
// ---------------------------------------------------------------------------
//
// Escape events ARE the ooze's supply. Each stream that makes it out of a finger
// pushes one clump of its own colour into the extrusion, so the creature in the
// void is visibly built out of the colour that escaped the board.

function renderEscapeFrame(
  b: Board, flows: Sched[], hits: Map<number, Hit[]>,
  body: OozeCell[], site: Pt, events: EscapeEvent[], t: number, T: number, pal: Palette,
): Canvas {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(b.base, 0, 0);

  // component conversions
  hits.forEach((list, node) => {
    const w = washAt(list, t, T);
    const comp = b.graph.nodes[node].comp;
    if (w && comp) washComp(ctx, b.baseData, comp, w.color, w.k, pal.washCeil);
  });
  drawInteractions(ctx, b.graph, b.baseData, hits, t, T, pal);

  // the connector lights in the colour currently passing through it
  events.forEach(e => {
    const age = mod(t - e.frame, T);
    if (age > 10) return;
    const f = FINGERS[e.finger];
    box(ctx, f.x, f.y, FINGER_W, f.h, mixOnBg(e.color, Math.max(0.35, 1 - age / 10)));
  });

  drawBlend(ctx, flows, t, T, pal);

  // ooze: one clump per escape, extruded from the finger that escape used
  events.forEach((e, ci) => {
    const clump = body.filter(c => c.clump === ci);
    if (!clump.length) return;
    const f = FINGERS[e.finger];
    const src = { x: f.x + FINGER_W + 1, y: f.y + 1 };
    const land = mod(e.frame + EXTRUDE, T);
    const settled = mod(t - land, T) < T - EXTRUDE - 2;
    const age = mod(t - e.frame, T);
    if (settled && age >= EXTRUDE) { for (const c of clump) cell(ctx, site.x + c.x, site.y + c.y, c.color); return; }
    if (age > EXTRUDE) return;
    const u = ease(age / EXTRUDE);
    const cx = site.x + clump.reduce((a, c) => a + c.x, 0) / clump.length;
    const cy = site.y + clump.reduce((a, c) => a + c.y, 0) / clump.length;
    const tipX = src.x + (cx - src.x) * u, tipY = src.y + (cy - src.y) * u;
    const span = Math.max(1, Math.round(Math.hypot(tipX - src.x, tipY - src.y)));
    for (let sIdx = 0; sIdx <= span; sIdx++) {
      const v = sIdx / span;
      const x = src.x + (tipX - src.x) * v;
      const y = src.y + (tipY - src.y) * v + Math.sin(v * Math.PI) * (2.2 - 1.6 * u)
        + Math.sin(v * 5 + t * 0.4) * 0.5 * (1 - v);
      const neck = 1 - u * 0.85;
      const thick = v < 0.3 ? 3 * neck : v > 0.8 ? 2.2 : 2 * neck;
      for (let w = 0; w < Math.max(1, Math.round(thick)); w++)
        cell(ctx, Math.round(x), Math.round(y) + w, mixOnBg(e.color, Math.min(1, 0.5 + 0.45 * v)));
    }
    const shown = Math.floor(clump.length * Math.min(1, (age + 1) / EXTRUDE));
    clump.slice(0, shown).forEach(c => {
      const w = 1 - Math.min(1, (age + 1) / EXTRUDE);
      cell(ctx, Math.round(site.x + c.x - (site.x + c.x - tipX) * w),
        Math.round(site.y + c.y - (site.y + c.y - tipY) * w), c.color);
    });
  });
  return canvas;
}

// ---------------------------------------------------------------------------
// Genesis v3 — the soup, ported to zero-g
// ---------------------------------------------------------------------------
//
// Cody: "it should be more like the pixels are released into a zero g
// environment where they more float around, bouncing off of things, sticking to
// interface on the board, etc. interaction rules form those into entities. like
// the soup part of my codyslater.github.io"
//
// Behaviour re-expressed (not imported) from that sim's own rules — see
// src/components/soup/sim/{rules,freePixels}.ts. What carries over:
//   * brownian jitter as the thermostat, exponential drag, a speed clamp
//   * short-range pairwise chemistry inside FORCE_RADIUS with an asymmetric
//     affinity matrix: same colour attracts (SAME_ATTRACT), most cross pairs
//     mildly repel, a seeded few attract — that asymmetry is what makes the soup
//     *chase* rather than homogenise
//   * bonding gated on contact AND low relative speed; nucleation slow,
//     snapping onto an existing cluster fast
//   * eyes only once a body is big enough to have enclosed cells
// What changes for the banner: **gravity is removed** (zero-g), there is no
// ground/sedimentation cycle, and the left wall is the board's own edge — so
// pixels bounce off the interface and some stick to it.
const SOUP_DEFAULTS = {
  JITTER: 42,          // cells/s^2 brownian heat
  DRAG: 0.55,          // 1/s — low: in zero g momentum persists and the cloud crosses the void
  TERMINAL: 13,        // cells/s speed clamp
  FORCE_RADIUS: 6,
  GATHER_RADIUS: 20,   // a body is a gravity well: it draws in what drifts past.
  GATHER: 3.2,         // cells/s^2 at the centre, independent of the body's size.
                       // Without a well the soup fragments into dozens of 3-cell
                       // specks — in zero g nothing ever finds anything again.
                       // Per-PAIR long range does not work: with 150 particles the
                       // summed force saturates the speed clamp, every particle
                       // flies at terminal velocity, and BOND_MAX_SPEED then makes
                       // bonding impossible. The well has to be per-BODY.
  FORCE_STRENGTH: 13,
  BONDED_PULL: 2.6,    // bonded matter attracts harder — how a body gathers stragglers
  SAME_ATTRACT: 0.55,
  RESTITUTION: 0.8,
  CAPTURE_RADIUS: 1.9,
  BOND_MAX_SPEED: 9,
  NUCLEATE_RATE: 0.09, // /s — rare seeds; growth happens by accretion onto a seed.
                       // Round 9 cut it hard: a standing population nucleates far
                       // more readily than round 8's trickle did, and the result
                       // was a shoal of rival lumps instead of creatures.
  ACCRETE_RATE: 3.0,   // /s while a free pixel touches a bonded one. Also cut — at
                       // 3.5 essentially everything bonded on contact and the void
                       // held ~9 free pixels out of 200, so nothing was adrift.
  DRIFT: 0.22,
  WANDER: 3.0,          // cells/s^2 of brownian roam on a whole cluster          // cells/s^2 — the void is a slow river. See the note below.
  STICK_RATE: 0.9,     // /s chance to stick when nudging the interface
  BOND_EASE: 0.11,     // per frame — how fast a new bond tightens (≈9 frames to firm)
  SPRING_K: 34,        // slot spring stiffness, scaled by bond strength
  SPRING_DAMP: 6,
  EYE_MIN_SIZE: 20,
  ASSIMILATE: 2.6,     // /s per eligible minority cell — bodies trend monochrome
  STICKY_PULL_RATE: 0.8,   // /s per unmirrored slot
  STICKY_RADIUS: 7,
  STICKY_ACCEL: 26,    // pull on a free pixel of the body's own colour
  STICKY_BONUS: 9,     // accretion weight multiplier for a mirror slot
  FORMED_MIN: 40, FORMED_MONO: 0.9, FORMED_SYM: 0.8,
  FORM_FROM: 22, FORM_FULL: 40,   // cells over which anatomy takes hold
  FORM_BONUS: 5.0,                // pull toward the profile
  FORM_PENALTY: 8,              // push out of it
  SHED_RATE: 0.8,                 // /s per stray nub outside the silhouette
  UPRIGHT: 0.94,                  // a settled creature stops tumbling and stands up
  MAX_NUCLEI: 4,       // seeds per arc (see nucleiBudget: scaled by material).
                       // Nucleation is the rarest event in the sim; everything
                       // else is accretion onto what exists.
  // --- round 9: release cadence, GLOBAL --------------------------------------
  BEAT: 4,             // frames between release beats — one beat, one finger, 1–2 pixels
  DRAIN_SPAN: 48,      // frames a finger keeps trickling after its stream escapes

  // --- round 9: the generation arc -----------------------------------------
  COPIES: 3,           // generation arcs alive at once; S = COPIES * T (see ARC_COPIES)
  EXIT_WIND: 6.5,      // cells/s^2 the exit current pushes at full strength...
  SPAN_REF: 360,       // ...when it has this many frames to clear the void in
  EXIT_TERMINAL: 1.5,  // speed-clamp multiplier at full exit
  CRUST_MAX: 12,       // stuck pixels per arc (x COPIES on screen)
  CRUST_DWELL_LO: 90,  // frames a stuck pixel dwells on the interface before letting go
  CRUST_DWELL_HI: 380,

  // --- round 12c: material flux, which is the ONLY physical difference between
  //     the two loop lengths ---------------------------------------------------
  DOUBLE_P: 0.45,      // chance a beat releases 2 pixels rather than 1 (see below)
  BEATS_REF: 90,       // the 30 s arc's beats-per-arc, ...
  WINDOW_REF: 720,     // ...over this many frames of release window: the reference FLUX
  FEEDERS_MAX: 2,      // arcs a beat train may be shared between — see below
  NUCLEI_PER: 26,      // one seed per this many releases an arc receives
  NUCLEI_MIN: 2,
  MERGE_FREE_SIZE: 25, // below this the smaller body fuses on contact...
  MERGE_MATURE_RATE: 0.25,  // ...above it, /s, divided by resistance squared
  SEPARATE: 5.0,       // cells/s^2 two bodies that declined to fuse push apart with
} as const;

/**
 * ROUND 12c — the tuning hook.
 *
 * `PROTO_TUNE=KEY=value,KEY=value` overrides any numeric SOUP constant for one
 * process. Diagnostic only: unset — the shipped default — it changes nothing,
 * and every number in the round 12c report was taken either with it unset or at
 * a value that was then written into the table above. It exists because one
 * sweep over the eight-seed corpus costs a minute, and editing a constant
 * between each of a dozen of them costs the afternoon.
 */
const TUNE: Record<string, number> = {};
{
  const spec = process.env.PROTO_TUNE;
  if (spec)
    for (const kv of spec.split(',')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) {
        if (!(k.trim() in SOUP_DEFAULTS)) throw new Error(`PROTO_TUNE: no SOUP constant ${k.trim()}`);
        TUNE[k.trim()] = Number(v);
      }
    }
}
// Resolved once into a plain object: SOUP is read in the innermost particle
// loops, and a Proxy trap there costs more than the whole rest of the sim.
const SOUP = { ...SOUP_DEFAULTS, ...TUNE } as typeof SOUP_DEFAULTS;

/**
 * ROUND 9 — CIRCULAR SCHEDULING, AND WHY THE ARC IS LONGER THAN THE LOOP.
 *
 * Round 8 metered the release but did not reschedule it, so the void was starved
 * and the body was part-formed for most of the loop. The fix is to stop treating
 * the loop as a timeline with an empty arc at both ends, and use the codebase's
 * own mod-T circle trick instead.
 *
 * A *generation* of soup is one finite arc of `S = COPIES * T` frames: released
 * -> drifts -> interacts -> bonds -> matures -> is carried off the right edge of
 * the canvas, ending genuinely empty. Because `S > T`, the arc wraps: at loop
 * frame `t` the void shows generation ages `t mod T`, `+T`, `+2T` — the same
 * simulation observed at three ages at once. Periodicity is by construction, not
 * by tuning: the rendered void is a pure function of `t mod T`, so frame T is
 * bit-identical to frame 0.
 *
 * Why COPIES = 3 rather than a hair over 1: standing population is
 * `releaseRate x meanLifetime`. The release cadence is fixed by Cody at 1–2
 * pixels a beat, so the ONLY way to fill the void is to make lifetimes long, and
 * a lifetime cannot exceed its arc. A 3T arc buys ~3x the standing population at
 * exactly the same calm cadence — density from persistence, not from bursts.
 *
 * The three ages also give the ecosystem its strata for free: fresh pixels at the
 * lip, a middle-aged soup with part-bonded goo and forming clusters, and mature
 * bodies drifting out on the right. They are the same arc, so they never read as
 * a duplicate of each other.
 *
 * Flat density across the loop falls out of the release/exit shape. With release
 * uniform over ages [0, 2T) and removal uniform over [2T, 3T), writing p for the
 * per-arc population:
 *     p(a) = P.a/2T for a<=2T,  p(2T+u) = P.(1 - u/T)
 *     p(a) + p(a+T) + p(a+2T) = P[a/2T + (a+T)/2T + 1 - a/T] = 1.5P — constant.
 * So there is no denser or sparser moment to give the phase away.
 *
 * The one hard requirement the sim must meet is that the arc really is finite:
 * empty at age S (no particles, no clusters, no crust), or the oldest copy
 * vanishing at the wrap is a visible pop. That is a qualifying condition below.
 */
/** Overridable at the CLI (--copies): arc length is decoupled from loop length. */
let ARC_COPIES: number = SOUP.COPIES;
const genLength = (T: number): number => ARC_COPIES * T;

/** The generation ages visible at loop frame `t` — COPIES of them, always. */
function visibleAges(t: number, T: number): number[] {
  const a = mod(t, T), S = genLength(T), out: number[] = [];
  for (let k = a; k < S; k += T) out.push(k);
  return out;
}

interface Release { finger: number; color: string }

/**
 * The GLOBAL beat train.
 *
 * Cody wants every finger trickling AND the cadence to stay "one... two...
 * one...". Those pull against each other if each finger runs its own drain, so
 * the trickle is distributed, not multiplied: one beat every BEAT frames fires
 * 1–2 pixels from exactly ONE finger — whichever fingers are currently draining
 * take turns. Nine live interfaces, one calm countable stream of pixels.
 *
 * Each beat is also assigned to one generation copy (never the oldest, which is
 * on its way out), which is what keeps releases confined to ages [0, (COPIES-1)T)
 * and gives the flat-density shape above. On screen exactly one release happens
 * per beat no matter how many arcs are alive.
 */
function buildReleaseSchedule(events: EscapeEvent[], T: number): Map<number, Release[]> {
  const m = new Map<number, Release[]>();
  if (!events.length) return m;
  /**
   * ROUND 12c — THE FEEDER CAP, and why the 24 s creatures were small.
   *
   * Round 9 shared the beat train between every arc except the oldest
   * (`COPIES - 1`). At 3 copies that is 2 feeders and each arc is fed over
   * 2T = 720 frames; at 4 copies it silently became 3 feeders and 864 frames.
   * The on-screen cadence is identical either way — one beat, one finger, 1-2
   * pixels — but the material reaching ANY ONE arc fell from 90 releases / 720
   * frames to 72 / 864, i.e. to 67 % of the rate. That, not the exit shaping,
   * is why the 24 s body crossed 40 cells at age 769/1152 instead of 547/1080
   * and had almost no formed window left.
   *
   * Capping feeders at 2 restores the reference flux exactly (72 / 576 = 0.125
   * releases per frame, same as 90 / 720) while changing nothing a viewer can
   * count. Flat density survives it: with release ramping over [0, 2T), a flat
   * coast over [2T, 3T) and removal over [3T, 4T), the four visible ages sum to
   *     P.a/2T + P.(a+T)/2T + P + P(1 - a/T) = 2.5P — constant in a.
   */
  const feeders = Math.max(1, Math.min(SOUP.FEEDERS_MAX, ARC_COPIES - 1));
  let bi = 0;
  for (let b = 0; b < T; b += SOUP.BEAT, bi++) {
    const active = events.filter(e => mod(b - e.frame, T) < SOUP.DRAIN_SPAN);
    const pool = active.length ? active : events;
    const e = pool[bi % pool.length];
    const age = b + (bi % feeders) * T;
    m.set(age, [...(m.get(age) ?? []), { finger: e.finger, color: e.color }]);
  }
  return m;
}

/**
 * ONE particle type, one integrator — there is no "free pixel" object and no
 * separate "body" object (Cody, round 8: "a more seamless transition from pixels
 * flowing out, interacting, piecewise forming complex life"). A particle that
 * has bonded simply carries a cluster id, a lattice slot, and a bond strength
 * that eases 0→1; the only difference in its physics is an added spring toward
 * its slot and proportionally damped jitter. It never teleports, it keeps
 * obeying chemistry, and it keeps attracting the pixels still drifting. Being
 * part of a body is a matter of degree, not a mode.
 */
interface Particle {
  x: number; y: number; vx: number; vy: number;
  c: number;          // colour index
  streak: number;     // emission trail, seconds
  cluster: number;    // -1 while unattached
  sx: number; sy: number;   // lattice slot in cluster-local cells
  bond: number;       // 0..1, eases in — spring stiffness and jitter damping scale with it
  eye: number;        // 0..1 eyeness, eases in late; a blink eases it back down
}

/**
 * ROUND 11 — the soup's own body language, read from
 * `codyslater.github.io/src/components/soup/sim/clusters.ts` (behaviour ported,
 * no code imported). Cody: "creatures forming are just multicolor blobs, not
 * really following the style from soup simulator".
 *
 * What the reference's formed creatures actually ARE (`isFormed`, and the rules
 * that drive bodies toward it):
 *   * NEAR-MONOCHROME, not multicoloured. `FORMED_MONO = 0.9`: at least 90 % of
 *     non-eye cells carry the cluster's `dominant` colour. `assimilate()` flips
 *     minority cells that have >= 3 dominant 4-neighbours, at 0.5/s — "bodies
 *     trend monochrome, like the species". A few foreign flecks survive; that is
 *     the multicolour that remains.
 *   * BILATERALLY SYMMETRIC about a vertical axis. `FORMED_SYMMETRY = 0.8`:
 *     >= 80 % of cells have their mirror across `axis2` occupied, where
 *     `axis2 = round(2 * mean column)` — half-cell resolution, so the axis can sit
 *     between columns. Symmetry is not templated: unmirrored slots become
 *     `sticky`, and `mirrorPull()` actively lures the nearest FREE pixel of the
 *     dominant colour into them (0.8/s, radius 6). Asymmetry fills itself in.
 *   * EYES ARE A MIRRORED PAIR OF 2x1 BLOCKS — four cells, `#f0f0f0`, placed on
 *     *enclosed* cells in the UPPER THIRD of the body, on a column and its
 *     distinct mirror column. Minimum body 20 cells.
 *   * Blinking shows the DOMINANT BODY COLOUR in the eye sockets, not black, and
 *     is draw-time only. Breathing is a whole-cell bob, also draw-time, and only
 *     once `formed`.
 *   * `formed` = eyes && size >= 40 && mono >= 0.9 && symmetry >= 0.8.
 *
 * Ours now grows toward all of that gradually: a young cluster is loose
 * multicolour goo, and assimilation + mirror-pull + sticky-slot-preferring
 * accretion resolve it into a structured creature over the arc. There is no
 * snap-to-template moment anywhere.
 */
interface Cluster {
  id: number; x: number; y: number; vx: number; vy: number;
  theta: number; omega: number;   // slow zero-g tumble
  n: number; maturity: number;    // 0..1, rises with size — breathing fades in with it
  form: number;                   // 0..1, how strongly anatomy is shaping growth
  originSy: number; half: number; anchored: boolean;   // the body's own anatomical frame
  blink: number;
  dominant: number;   // the species colour this body is trending toward
  axis2: number;      // mirror axis, doubled so it can fall between slot columns
  mono: number; sym: number; formed: boolean;
}

/**
 * ROUND 12 — ANATOMY. Cody: "give some of the creatures a little more form".
 *
 * The site's own creature generator (`src/components/creature/generation.ts`)
 * builds every body from a 12-row fill profile, mirrored about the vertical
 * centre. That profile IS the anatomy, and reading it off gives the silhouette
 * we were missing:
 *
 *   rows 0-1   0.05 0.15   a narrow crown
 *   rows 2-3   0.80 0.85   the HEAD — wide, and where the eye pair sits
 *   row  4     0.55        a NECK PINCH
 *   rows 5-7   0.95 0.95 0.90   the TORSO, widest part (plus optional arm nubs
 *                               at the extreme columns, 60 % of the time)
 *   row  9     0.55        hips
 *   rows 10-11 0.50 0.45   LEGS — and critically the generator CLEARS the two
 *                          centre columns here, so the body ends in two legs
 *                          with a gap between them
 *
 * That last detail is most of what makes it read as a little being rather than
 * a symmetric mass, so it is reproduced: below the hips, slots near the mirror
 * axis are pushed away and the silhouette splits.
 *
 * Applied as a WEIGHT on accretion scoring that fades in between FORM_FROM and
 * FORM_FULL cells — a young cluster is unaffected loose goo, and the anatomy
 * arrives as late-stage organisation. Nothing is ever stamped from a template.
 */
const ROW_PROFILE = [0.05, 0.15, 0.80, 0.85, 0.55, 0.95, 0.95, 0.90, 0.65, 0.55, 0.50, 0.45];

/** How strongly a slot at (sx,sy) agrees with the body's silhouette. */
function formFit(sx: number, sy: number, minSy: number, maxSy: number, axis: number, half: number): number {
  const rows = Math.max(1, maxSy - minSy);
  const ri = Math.max(0, Math.min(11, Math.round(((sy - minSy) / rows) * 11)));
  if (sy < minSy || sy > maxSy) return -1;   // outside the anatomy entirely
  const w = ROW_PROFILE[ri] * half;
  const d = Math.abs(sx - axis);
  if (ri >= 10 && d < w * 0.42) return -1;   // the gap between the legs
  return d <= w ? 1 : -1;
}

const N8: readonly (readonly [number, number])[] =
  [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

interface FormFrame { w: number; minSy: number; maxSy: number; axis: number; half: number }

/**
 * The one place a cell is assigned a slot on a body: packing + mirror repair +
 * anatomy, tie-broken toward where the cell already is. Shared by accretion AND
 * by merging — see the note on merging below for why that sharing is the whole
 * point.
 */
function pickSlot(
  occ: Set<string>, sticky: Set<string> | undefined, fit: FormFrame | undefined,
  rx: number, ry: number,
): { x: number; y: number } | null {
  const seen = new Set<string>();
  let best: { x: number; y: number; score: number } | null = null;
  for (const key of occ) {
    const ci = key.indexOf(',');
    const ox = Number(key.slice(0, ci)), oy = Number(key.slice(ci + 1));
    for (const [ax, ay] of N8) {
      const sx = ox + ax, sy = oy + ay;
      const sk = slotKey(sx, sy);
      if (occ.has(sk) || seen.has(sk)) continue;
      seen.add(sk);
      const nb = N8.filter(([dx, dy]) => occ.has(slotKey(sx + dx, sy + dy))).length;
      const mirrorBonus = sticky?.has(sk) ? SOUP.STICKY_BONUS : 0;
      const f = fit ? formFit(sx, sy, fit.minSy, fit.maxSy, fit.axis, fit.half) : 0;
      const anat = fit ? fit.w * f * (f > 0 ? SOUP.FORM_BONUS : SOUP.FORM_PENALTY) : 0;
      const score = nb * 2.5 + mirrorBonus + anat - Math.hypot(sx - rx, sy - ry);
      if (!best || score > best.score) best = { x: sx, y: sy, score };
    }
  }
  return best;
}

/** The unmirrored slots of a body — the repair targets symmetry grows into. */
function stickyOfSlots(occ: Set<string>, axis2: number): Set<string> {
  const out = new Set<string>();
  for (const key of occ) {
    const ci = key.indexOf(',');
    const sx = Number(key.slice(0, ci)), sy = Number(key.slice(ci + 1));
    const mk = slotKey(axis2 - sx, sy);
    if (!occ.has(mk)) out.add(mk);
  }
  return out;
}

const VOID_X0 = BOARD_RIGHT + 1, VOID_X1 = GRID_W - 2, VOID_Y0 = 2, VOID_Y1 = GRID_H - 4;

/** Asymmetric affinity: diagonal attracts, most pairs repel mildly, a seeded few attract. */
function rollAffinity(rng: Rng, n: number): number[][] {
  return Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_2, b) =>
    a === b ? SOUP.SAME_ATTRACT : rng() < 0.25 ? rng() * 0.6 : -(0.1 + rng() * 0.5)));
}

/**
 * A pixel stuck to the board's own interface. Round 9 gives it a dwell: the crust
 * is an equilibrium, not an accumulator — a stuck pixel eventually lets go and
 * rejoins the soup. Without that the crust only ever grows, and a generation that
 * ends with 20 stuck cells cannot end empty, which is what the wrap needs.
 */
interface Crust { x: number; y: number; c: number; born: number; dwell: number }

interface SoupState { parts: Particle[]; clusters: Cluster[]; crust: Crust[] }

const slotKey = (x: number, y: number) => `${x},${y}`;

/**
 * One deterministic pass of the soup across the whole loop, recorded per frame.
 * Emergent-looking, exactly replayable: same seed, same frames, every time.
 *
 * Ported behaviour from the site's own soup (src/components/soup/sim/*): brownian
 * jitter, exponential drag, short-range pairwise chemistry over an asymmetric
 * affinity matrix, bonding gated on contact AND low relative speed, rare
 * nucleation vs fast accretion, eyes only once there are enclosed cells.
 * Removed for the banner: gravity, floor, sedimentation — this is zero-g, and
 * the left wall is the board's own interface.
 */
function simulateSoup(
  rng: Rng, releaseAt: Map<number, Release[]>, S: number, colors: string[],
): SoupState[] {
  const aff = rollAffinity(rng, colors.length);
  const idxOf = new Map(colors.map((c, i) => [c, i]));
  const parts: Particle[] = [];
  const clusters: Cluster[] = [];
  const occupied = new Map<number, Set<string>>();   // cluster id -> occupied slots
  let crust: Crust[] = [];
  const frames: SoupState[] = [];
  const dt = 1 / 12;
  let nextCluster = 0, nucleated = 0;
  // A seed only forms if the arc has matter to feed another body. The 4-generation
  // arc receives 72 release events against the 3-generation arc's 90, so holding
  // the nuclei count fixed split 20 % less material across the same number of
  // bodies and none of them reached the size band.
  const releasesPerArc = [...releaseAt.values()].reduce((n, v) => n + v.length, 0);
  const nucleiBudget = Math.max(SOUP.NUCLEI_MIN,
    Math.min(SOUP.MAX_NUCLEI, Math.floor(releasesPerArc / SOUP.NUCLEI_PER)));
  /**
   * ROUND 12c — the flux GUARD. With the feeder cap above, an arc is fed at the
   * reference rate for any COPIES >= 3 and this resolves to DOUBLE_P unchanged;
   * it only bites if a future config puts the release window somewhere else.
   * Cody pinned the cadence as "just a one two at a time" — the mix of ones and
   * twos inside that is the only free variable, so that is what it moves.
   */
  const releaseWindow = Math.max(...releaseAt.keys(), 0) + SOUP.BEAT;
  const flux = releasesPerArc / Math.max(1, releaseWindow);
  const fluxRef = SOUP.BEATS_REF / SOUP.WINDOW_REF;
  const doubleP = Math.max(0, Math.min(1, (1 + SOUP.DOUBLE_P) * (fluxRef / flux) - 1));
  const stickyOf = new Map<number, Set<string>>();
  const formOf = new Map<number, { w: number; minSy: number; maxSy: number; axis: number; half: number }>();

  // The generation's exit: a current that ramps in over the last third of the
  // arc. It has to actually finish the job — the arc must be empty at age S — so
  // the clamp is lifted with it and the right wall stops reflecting. NOTHING is
  // removed while it is still visible: a particle leaves this world by drifting
  // off the right-hand edge of the canvas, never by dimming out (Cody: "why
  // fading away after a few seconds").
  const EXIT_SPAN = S / ARC_COPIES;
  const EXIT_START = S - EXIT_SPAN;
  const GONE_X = GRID_W + 2;
  // ROUND 12c — the exit is a FIXED JOB (clear the void) given a span that
  // shrinks with the loop: 288 frames at 24 s against the reference 360. Holding
  // the wind constant therefore under-delivers, and 11 of 80 candidates failed
  // the seam purely because the last body had not left by age S. Scaling the
  // wind by SPAN_REF/EXIT_SPAN matches the impulse and is a no-op at the
  // reference span.
  const exitWind = SOUP.EXIT_WIND * (SOUP.SPAN_REF / EXIT_SPAN);

  const clusterOf = (id: number) => clusters.find(c => c.id === id)!;
  const slotWorld = (cl: Cluster, sx: number, sy: number): Pt => {
    const cos = Math.cos(cl.theta), sin = Math.sin(cl.theta);
    return { x: cl.x + sx * cos - sy * sin, y: cl.y + sx * sin + sy * cos };
  };

  for (let t = 0; t < S; t++) {
    // --- release: metered trickle out of each draining finger ---
    for (const e of releaseAt.get(t) ?? []) {
      const f = FINGERS[e.finger];
      const ci = idxOf.get(e.color) ?? 0;
      const n = rng() < doubleP ? 2 : 1;   // "just a one two at a time"
      for (let k = 0; k < n; k++) {
        const cling = rng() < 0.25;
        parts.push({
          x: cling ? VOID_X0 : VOID_X0 + 1 + rng() * 1.5,
          y: f.y + 1 + (rng() - 0.5) * 2.5,
          vx: cling ? -0.3 - rng() * 0.4 : 0.8 + rng() * 1.7,
          vy: (rng() - 0.5) * 3.2, c: ci, streak: 0.4,
          cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
        });
      }
    }

    // The void exhales: a current that ramps in smoothly over the tail of the
    // generation, carrying whatever is still in the void off the right edge.
    // Ramped, not switched — there is no "now everyone leaves" frame. Round 9
    // also lifts the speed clamp with it and opens the right wall, because round
    // 8's body could never leave: the cluster wall-clamp kept bouncing it back.
    // The void is a slow river, not a still tank. A gentle rightward drift runs
    // for the WHOLE arc, so material migrates away from the interface as it ages
    // and the far side of the void gets inhabited instead of staying blank. It
    // also stratifies the three visible copies in space — the oldest arc is
    // naturally furthest right — so they read as separate neighbourhoods of one
    // ecosystem rather than as three clouds sharing a box. The exit is the same
    // current turned up, which is why leaving never looks like a mode change.
    const exitU = Math.min(1, Math.max(0, (t - EXIT_START) / EXIT_SPAN));
    const exhale = SOUP.DRIFT + exitU * exitWind;
    const terminal = SOUP.TERMINAL * (1 + SOUP.EXIT_TERMINAL * exitU);
    const rightWall = exitU <= 0;

    // --- the crust breathes: stuck pixels let go after their dwell, and the exit
    //     current strips whatever is left, so the interface is bare at age S ---
    const strip = Math.min(1, Math.max(0, (t - (EXIT_START + 40)) / 80)) * 0.2;
    if (crust.length) {
      const keep: Crust[] = [];
      for (const cr of crust) {
        if (t - cr.born < cr.dwell && rng() >= strip) { keep.push(cr); continue; }
        parts.push({
          x: VOID_X0 + 0.4, y: cr.y, vx: 1.0 + rng() * 1.6, vy: (rng() - 0.5) * 2.6,
          c: cr.c, streak: 0.25, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
        });
      }
      crust = keep;
    }

    // --- one integrator for every particle, bonded or not ---
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const free = p.cluster < 0;
      const jitter = SOUP.JITTER * (1 - 0.85 * p.bond);
      p.vx += (rng() - 0.5) * jitter * dt + exhale * dt;
      p.vy += (rng() - 0.5) * jitter * dt;

      // chemistry — bonded particles keep exerting and feeling it, which is how
      // a growing body attracts the pixels still adrift. Same rule, no special case.
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const q = parts[j];
        // particles of the SAME body do not pull on each other — their geometry
        // is the lattice, and letting them attract as well collapses a 58-cell
        // creature into a 2x3 stack that is invisible on screen
        if (p.cluster >= 0 && p.cluster === q.cluster) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d2 = dx * dx + dy * dy;
        const R = SOUP.FORCE_RADIUS;
        if (d2 > R * R || d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        // Bonded matter is stickier — the reference carries the same idea as a
        // per-colour `stickiness` profile. Expressing it here keeps convergence
        // inside the chemistry rule instead of adding a "seek the body" mode:
        // a growing cluster simply pulls harder, so stragglers find it.
        // Free pairs feel the signed affinity — that asymmetry is what makes the
        // soup chase. Bonded matter is *sticky*: it attracts regardless of
        // colour, which is why a body gathers stragglers of every colour instead
        // of same-colour clumps repelling each other into a shoal. Same force
        // law, one term — not a "seek the body" mode.
        const a = q.cluster >= 0 ? Math.abs(aff[p.c][q.c]) * SOUP.BONDED_PULL : aff[p.c][q.c];
        const fmag = SOUP.FORCE_STRENGTH * a * (1 - d / R) * dt * (1 - 0.6 * p.bond);
        p.vx += (dx / d) * fmag; p.vy += (dy / d) * fmag;
      }

      // the gravity well of every body in range — this is how a growing creature
      // gathers the pixels still adrift instead of waiting to be bumped into
      if (free)
        for (const cl of clusters) {
          const dx = cl.x - p.x, dy = cl.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d > SOUP.GATHER_RADIUS || d < 0.5) continue;
          const f = SOUP.GATHER * (1 - d / SOUP.GATHER_RADIUS) * dt;
          p.vx += (dx / d) * f; p.vy += (dy / d) * f;
        }

      // spring toward the slot — a bonded particle eases into place along its own
      // trajectory instead of being repositioned. Stiffness grows with the bond.
      if (!free) {
        const cl = clusterOf(p.cluster);
        const w = slotWorld(cl, p.sx, p.sy);
        const k = SOUP.SPRING_K * p.bond;
        p.vx += ((w.x - p.x) * k - p.vx * SOUP.SPRING_DAMP * p.bond) * dt;
        p.vy += ((w.y - p.y) * k - p.vy * SOUP.SPRING_DAMP * p.bond) * dt;
        p.bond = Math.min(1, p.bond + SOUP.BOND_EASE);
      }

      const drag = Math.exp(-SOUP.DRAG * dt);
      p.vx *= drag; p.vy *= drag;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > terminal) { p.vx *= terminal / sp; p.vy *= terminal / sp; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.streak > 0) p.streak -= dt;

      // walls — the left one is the board's own interface, and a pixel nudging it
      // slowly may simply stay there
      if (p.x < VOID_X0) {
        p.x = VOID_X0; p.vx = Math.abs(p.vx) * SOUP.RESTITUTION;
        if (free && exitU === 0 && rng() < SOUP.STICK_RATE * dt * 12 && crust.length < SOUP.CRUST_MAX) {
          crust.push({
            x: BOARD_RIGHT, y: Math.round(p.y), c: p.c, born: t,
            dwell: randInt(rng, SOUP.CRUST_DWELL_LO, SOUP.CRUST_DWELL_HI),
          });
          parts.splice(i--, 1); continue;
        }
      } else if (p.x > VOID_X1 && rightWall) { p.x = VOID_X1; p.vx = -Math.abs(p.vx) * SOUP.RESTITUTION; }
      if (p.y < VOID_Y0) { p.y = VOID_Y0; p.vy = Math.abs(p.vy) * SOUP.RESTITUTION; }
      else if (p.y > VOID_Y1) { p.y = VOID_Y1; p.vy = -Math.abs(p.vy) * SOUP.RESTITUTION; }
    }

    // --- bonding: what interactions sometimes do, not a stage ---
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.cluster >= 0) continue;
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const q = parts[j];
        if (Math.abs(p.x - q.x) > SOUP.CAPTURE_RADIUS || Math.abs(p.y - q.y) > SOUP.CAPTURE_RADIUS) continue;
        if (Math.hypot(p.vx - q.vx, p.vy - q.vy) > SOUP.BOND_MAX_SPEED) continue;
        if (q.cluster < 0 && aff[p.c][q.c] <= 0) continue;   // compatibility gates nucleation only
        if (q.cluster < 0 && nucleated >= nucleiBudget) continue;
        const rate = q.cluster >= 0 ? SOUP.ACCRETE_RATE : SOUP.NUCLEATE_RATE;
        if (rng() >= rate * dt) continue;

        if (q.cluster < 0) {
          // nucleation: a brand-new two-particle cluster, anchored where they met
          const cl: Cluster = {
            id: nextCluster++, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2,
            vx: (p.vx + q.vx) / 2, vy: (p.vy + q.vy) / 2,
            theta: 0, omega: (rng() - 0.5) * 0.3, n: 2, maturity: 0, blink: 0,
            dominant: p.c, axis2: 0, mono: 0, sym: 0, formed: false, form: 0,
            originSy: 0, half: 3.4, anchored: false,
          };
          clusters.push(cl);
          nucleated++;
          const occ = new Set<string>();
          occupied.set(cl.id, occ);
          const dirx = p.x <= q.x ? -1 : 1;
          q.cluster = cl.id; q.sx = 0; q.sy = 0; q.bond = 0; occ.add(slotKey(0, 0));
          p.cluster = cl.id; p.sx = dirx; p.sy = 0; p.bond = 0; occ.add(slotKey(dirx, 0));
        } else {
          // Accretion is EDEN-like: of the open slots on the body's boundary near
          // the contact, take the one with the most occupied neighbours, breaking
          // ties toward where this particle actually is. Taking the nearest open
          // slot instead (round 8) grows chains — the void filled with stringy
          // filaments rather than creatures, because each newcomer extended the
          // last one's free end. Preferring concave positions makes lumpy,
          // asymmetric bodies, which is what `growOoze` already did for the posed
          // creature and what the reference soup's packing looks like.
          const cl = clusterOf(q.cluster);
          const occ = occupied.get(cl.id)!;
          const cos = Math.cos(-cl.theta), sin = Math.sin(-cl.theta);
          const rx = (p.x - cl.x) * cos - (p.y - cl.y) * sin;
          const ry = (p.x - cl.x) * sin + (p.y - cl.y) * cos;
          // Candidates are every empty lattice slot on the WHOLE body boundary,
          // not just the eight around the contact point. The reference targets
          // its sticky (mirror) slots globally, and it has to: a slot that
          // completes the body's mirror is almost never adjacent to wherever the
          // pixel happened to touch, so a local-only search can never build
          // symmetry no matter how large the bonus.
          const best = pickSlot(occ, stickyOf.get(cl.id), formOf.get(cl.id), rx, ry);
          if (!best) break;
          // The reference: "mutation limbs grow in the body color regardless of
          // the food's color". A pixel that completes the mirror is repair tissue,
          // so it arrives as body matter — this is most of what drives mono and
          // symmetry up together instead of trading one against the other.
          if (stickyOf.get(cl.id)?.has(slotKey(best.x, best.y))) p.c = cl.dominant;
          p.cluster = cl.id; p.sx = best.x; p.sy = best.y; p.bond = 0;
          occ.add(slotKey(best.x, best.y));
          cl.n++;
          cl.vx = cl.vx * 0.92 + p.vx * 0.08; cl.vy = cl.vy * 0.92 + p.vy * 0.08;
        }
        break;
      }
    }

    // --- clusters: drift, tumble, mature. Same continuum: a cluster is just the
    //     biggest thing in the soup, and two of them touching merge. ---
    for (const cl of clusters) {
      // A body roams. Without this, clusters froze where they nucleated and the
      // far half of the void stayed blank no matter how much material arrived —
      // 95 % of the soup was bonded and bonded matter did not move.
      cl.vx += exhale * dt + (rng() - 0.5) * SOUP.WANDER * dt;
      cl.vy += (rng() - 0.5) * SOUP.WANDER * dt;
      cl.vx *= 0.985; cl.vy *= 0.985;
      // a body must not outrun its own particles or the springs stretch and it
      // reads as being yanked rather than carried
      const csp = Math.hypot(cl.vx, cl.vy), cmax = terminal * 0.8;
      if (csp > cmax) { cl.vx *= cmax / csp; cl.vy *= cmax / csp; }
      cl.x += cl.vx * dt * 0.75; cl.y += cl.vy * dt * 0.75;
      cl.theta += cl.omega * dt;
      cl.omega *= 0.99;
      // n is the LIVE particle count, recomputed every frame. Trusting the
      // accretion counter over-reported badly: particles carried off the canvas
      // were never subtracted, so a body that had shed half its mass still
      // claimed its peak size and the size band was measuring a fiction.
      const mine = parts.filter(p => p.cluster === cl.id);
      cl.n = mine.length;
      cl.maturity = Math.min(1, cl.n / 46);
      const occ0 = occupied.get(cl.id)!;

      // ---- body meta: species colour, mirror axis, unmirrored slots ----------
      const counts = new Array(colors.length).fill(0);
      let sumSx = 0, minSy = Infinity, maxSy = -Infinity, bodyN = 0;
      const bySlot = new Map<string, Particle>();
      for (const q of mine) {
        bySlot.set(slotKey(q.sx, q.sy), q);
        sumSx += q.sx;
        if (q.sy < minSy) minSy = q.sy;
        if (q.sy > maxSy) maxSy = q.sy;
        if (q.eye === 0) { counts[q.c]++; bodyN++; }
      }
      if (mine.length) {
        let dom = cl.dominant, bestN = -1;
        counts.forEach((v, i) => { if (v > bestN) { bestN = v; dom = i; } });
        cl.dominant = dom;
        cl.axis2 = Math.round((2 * sumSx) / mine.length);
        let mirrored = 0;
        const sticky: string[] = [];
        for (const q of mine) {
          const mk = slotKey(cl.axis2 - q.sx, q.sy);
          if (bySlot.has(mk)) mirrored++; else sticky.push(mk);
        }
        cl.sym = mirrored / mine.length;
        cl.mono = bodyN ? counts[dom] / bodyN : 0;
        stickyOf.set(cl.id, new Set(sticky));

        // ---- anatomy: fades in with size, so goo first, creature later -------
        const fw = Math.max(0, Math.min(1,
          (cl.n - SOUP.FORM_FROM) / (SOUP.FORM_FULL - SOUP.FORM_FROM)));
        cl.form = fw;
        // The anatomical frame is ANCHORED the moment form engages, not
        // recomputed from the bounding box each tick. A rescaling frame chases
        // itself: every cell the body adds shifts which profile row every other
        // cell belongs to, so the silhouette can never settle and the shed rule
        // eats the body from the outside in. Anchored, the creature simply grows
        // into a fixed 12-row anatomy.
        if (!cl.anchored && fw > 0) {
          cl.anchored = true;
          cl.originSy = minSy - 1;
          cl.half = 3.2;
        }
        // The silhouette SCALES with the creature instead of capping it. A fixed
        // half-width of 3.6 bounded every body at roughly 2 x 3.6 x sum(ROW_PROFILE)
        // = 53 cells, which quietly put the whole upper half of the 45-70 size
        // band out of reach. Ratcheted (monotonic) so the frame still never
        // chases itself.
        if (cl.anchored) cl.half = Math.max(cl.half, Math.min(5.2, cl.n / 13));
        if (cl.anchored)
          formOf.set(cl.id, {
            w: fw, minSy: cl.originSy, maxSy: cl.originSy + 11,
            axis: cl.axis2 / 2, half: cl.half,
          });

        // A creature that has found its shape stops tumbling and stands up —
        // a head only reads as a head if it is on top.
        if (fw > 0.5) { cl.omega *= SOUP.UPRIGHT; cl.theta *= SOUP.UPRIGHT; }

        // ---- silhouette cleanup: a lone nub hanging off the outline lets go
        //      back into the soup (matter conserved, as the reference does) ----
        if (fw > 0.6)
          for (const q of mine) {
            if (q.eye > 0) continue;
            const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
              .filter(([dx, dy]) => bySlot.has(slotKey(q.sx + dx, q.sy + dy))).length;
            if (nbs > 1) continue;
            if (formFit(q.sx, q.sy, cl.originSy, cl.originSy + 11, cl.axis2 / 2, cl.half) > 0) continue;
            if (rng() >= SOUP.SHED_RATE * dt) continue;
            q.cluster = -1; q.bond = 0; q.sx = 0; q.sy = 0;
            occ0.delete(slotKey(q.sx, q.sy));
          }

        // ---- assimilation: a minority cell well inside dominant matter turns.
        //      Gradual by rate, so the blob resolves rather than snapping. ------
        for (const q of mine) {
          if (q.c === dom || q.eye > 0) continue;
          let domN = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nb = bySlot.get(slotKey(q.sx + dx, q.sy + dy));
            if (nb && nb.eye === 0 && nb.c === dom) domN++;
          }
          // The reference needs 3 dominant neighbours, but its bodies are twice
          // ours and have far more interior; at 3 the conversion never cascades
          // past the boundary of a merged half. 2 is the same rule at our scale.
          if (domN >= 2 && rng() < SOUP.ASSIMILATE * dt) q.c = dom;
        }

        // ---- mirror pull: an unmirrored slot lures the nearest free pixel of
        //      the body's own colour. Bilateral symmetry emerges; nothing is
        //      placed by template. ------------------------------------------
        for (const mk of sticky) {
          if (rng() >= SOUP.STICKY_PULL_RATE * dt) continue;
          const [msx, msy] = mk.split(',').map(Number);
          const w = slotWorld(cl, msx, msy);
          let best: Particle | null = null, bestD = SOUP.STICKY_RADIUS ** 2;
          for (const q of parts) {
            if (q.cluster >= 0 || q.c !== dom) continue;
            const dx = w.x - q.x, dy = w.y - q.y, d2 = dx * dx + dy * dy;
            if (d2 < bestD) { bestD = d2; best = q; }
          }
          if (!best) continue;
          const d = Math.sqrt(bestD) || 1;
          best.vx += ((w.x - best.x) / d) * SOUP.STICKY_ACCEL * dt;
          best.vy += ((w.y - best.y) / d) * SOUP.STICKY_ACCEL * dt;
        }
      }
      const xs = mine.map(p => p.x), ys = mine.map(p => p.y);
      if (xs.length) {
        // keep the body's own frame with its mass — if the centre is allowed to
        // run away from the particles the springs squash them into a stack
        // keep the body's own frame with its mass — if the centre is allowed to
        // run away from the particles the springs stretch and it reads as a yank
        const cx = mine.reduce((a2, q) => a2 + q.x, 0) / mine.length;
        const cy = mine.reduce((a2, q) => a2 + q.y, 0) / mine.length;
        cl.x += (cx - cl.x) * 0.05; cl.y += (cy - cl.y) * 0.05;
        if (Math.min(...xs) < VOID_X0) { cl.x += VOID_X0 - Math.min(...xs); cl.vx = Math.abs(cl.vx) * 0.6; }
        // the right wall opens with the exit current — round 8's body kept being
        // bounced back off it, which is why the void never emptied
        if (rightWall && Math.max(...xs) > VOID_X1) { cl.x -= Math.max(...xs) - VOID_X1; cl.vx = -Math.abs(cl.vx) * 0.6; }
        if (Math.min(...ys) < VOID_Y0) { cl.y += VOID_Y0 - Math.min(...ys); cl.vy = Math.abs(cl.vy) * 0.6; }
        if (Math.max(...ys) > VOID_Y1) { cl.y -= Math.max(...ys) - VOID_Y1; cl.vy = -Math.abs(cl.vy) * 0.6; }
      }

      // Eyes, the reference's way: a MIRRORED PAIR OF 2x1 BLOCKS on enclosed
      // cells in the upper third, on a column and its distinct mirror column.
      // Four cells, not two, and their placement is what makes the finished
      // creature read as a face rather than as a lump with two dots.
      if (cl.n >= SOUP.EYE_MIN_SIZE && !mine.some(p => p.eye > 0)) {
        const upper = minSy + Math.ceil((maxSy - minSy + 1) / 3);
        const solid = (sx: number, sy: number): boolean => {
          const q = bySlot.get(slotKey(sx, sy));
          return !!q && q.eye === 0;
        };
        const enclosed = (sx: number, sy: number): boolean => solid(sx, sy)
          && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => bySlot.has(slotKey(sx + dx, sy + dy)));
        const cands = [...mine].sort((a2, b2) => a2.sy - b2.sy || a2.sx - b2.sx);
        for (const q of cands) {
          if (q.sy > upper) continue;
          const mc = cl.axis2 - q.sx;
          if (mc === q.sx) continue;   // needs a distinct mirror column
          if (!(enclosed(q.sx, q.sy) && enclosed(q.sx, q.sy + 1)
            && enclosed(mc, q.sy) && enclosed(mc, q.sy + 1))) continue;
          for (const [ex, ey] of [[q.sx, q.sy], [q.sx, q.sy + 1], [mc, q.sy], [mc, q.sy + 1]]) {
            const e = bySlot.get(slotKey(ex, ey));
            if (e) e.eye = 0.01;   // eases open; never snaps
          }
          break;
        }
      }
      cl.formed = mine.some(p => p.eye > 0.5) && cl.n >= SOUP.FORMED_MIN
        && cl.mono >= SOUP.FORMED_MONO && cl.sym >= SOUP.FORMED_SYM;
      // blink and breath are draw-time only, and only once the creature is formed
      if (cl.formed) {
        cl.blink -= dt;
        if (cl.blink < -0.18) cl.blink = 2 + rng() * 4;
      } else cl.blink = 1;
      for (const p of mine) if (p.eye > 0) p.eye = Math.min(1, p.eye + 0.06);
    }

    // merging: two clusters in contact become one — slots recomputed from where
    // the particles already are, so nothing jumps
    for (let a = 0; a < clusters.length; a++)
      for (let b = clusters.length - 1; b > a; b--) {
        const A = clusters[a], B = clusters[b];
        const pa = parts.filter(p => p.cluster === A.id), pb = parts.filter(p => p.cluster === B.id);
        if (!pa.length || !pb.length) continue;
        const touch = pa.some(p => pb.some(q => Math.abs(p.x - q.x) <= 3.4 && Math.abs(p.y - q.y) <= 3.4));
        if (!touch) continue;
        /**
         * ROUND 12c — MERGES ARE GATED, which is what stops mono collapsing.
         *
         * Ours fused any two touching clusters, instantly, at any size. The
         * reference does not (`sim/clusters.ts`, the cluster-pair loop):
         *
         *   * compatibility first — it averages the affinity of the two
         *     DOMINANTS and only considers fusing when that is positive;
         *   * then resistance — `MERGE_FREE_SIZE = 25`: below that the smaller
         *     body fuses on positive contact, above it the chance is
         *     `MERGE_MATURE_RATE * dt / resist^2`, so big late fusions are rare.
         *
         * Both matter here for one reason. A merge dumps ~n foreign cells into
         * a body at once, and assimilation can only convert them layer by layer
         * from the seam inward. On an open-ended lifetime that always catches
         * up; on a finite arc with an exit coming it often does not — measured,
         * candidates ran mono 0.60-0.85 and never recovered before age S.
         * Compatibility gating means the cells that DO arrive are mostly a
         * colour the body is already trending toward, and resistance means a
         * 40-cell creature is no longer swallowing a 30-cell stranger at age
         * 800. Nothing is clamped and no colour is rewritten: the physics
         * simply stops creating the damage.
         */
        const affAB = (aff[A.dominant][B.dominant] + aff[B.dominant][A.dominant]) / 2;
        const small = Math.min(A.n, B.n);
        const resist = small / SOUP.MERGE_FREE_SIZE;
        const fuse = affAB > 0
          && (resist <= 1 || rng() < (SOUP.MERGE_MATURE_RATE * dt) / (resist * resist));
        if (!fuse) {
          // Declining to fuse has to mean something physically, or the two
          // bodies simply interpenetrate and read as one mush. The reference
          // separates formed adults on contact; this is that, as an impulse.
          const dx = A.x - B.x, dy = A.y - B.y, d = Math.hypot(dx, dy) || 1;
          const f = SOUP.SEPARATE * dt;
          A.vx += (dx / d) * f; A.vy += (dy / d) * f;
          B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
          continue;
        }
        // ROUND 12b — a merge REBUILDS the absorbed matter into the body's own
        // anatomy instead of dropping it wherever it happened to be floating.
        //
        // Assigning slots by rounded world position (rounds 8–12) was the single
        // largest source of malformed creatures, and it was invisible until the
        // arc timeline was plotted: at 24 s the biggest body ran sym 1.00 while
        // it grew 4 -> 16 cells by accretion, then jumped 16 -> 24 -> 42 in one
        // merge and symmetry collapsed to 0.76, where it stayed for the rest of
        // the arc. Mirror-pull cannot repair damage at that scale — it needs a
        // free pixel of the right colour per slot, and by then the body is large
        // and the soup around it is thin. So the merge must not do the damage in
        // the first place: every absorbed particle is re-slotted through the same
        // scorer accretion uses, nearest-first so the shape stays plausible, with
        // the sticky set recomputed as the body grows.
        const occA = occupied.get(A.id)!;
        const cos = Math.cos(-A.theta), sin = Math.sin(-A.theta);
        const incoming = pb.map(q => ({
          q,
          rx: (q.x - A.x) * cos - (q.y - A.y) * sin,
          ry: (q.x - A.x) * sin + (q.y - A.y) * cos,
        })).sort((u, v) => Math.hypot(u.rx, u.ry) - Math.hypot(v.rx, v.ry));
        for (const { q, rx: qx, ry: qy } of incoming) {
          const slot = pickSlot(occA, stickyOfSlots(occA, A.axis2), formOf.get(A.id), qx, qy);
          if (!slot) break;
          occA.add(slotKey(slot.x, slot.y));
          q.cluster = A.id; q.sx = slot.x; q.sy = slot.y; q.bond = Math.min(q.bond, 0.35);
        }
        A.n += B.n;
        A.vx = (A.vx + B.vx) / 2; A.vy = (A.vy + B.vy) / 2;
        occupied.delete(B.id);
        clusters.splice(b, 1);
      }

    // Anything carried clear off the canvas has left the world. The cull line is
    // two cells BEYOND the right edge, so no pixel is ever removed while a viewer
    // can still see it — the only way out is to keep moving.
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].x >= GONE_X) parts.splice(i, 1);
    for (let i = clusters.length - 1; i >= 0; i--)
      if (!parts.some(p => p.cluster === clusters[i].id)) { occupied.delete(clusters[i].id); clusters.splice(i, 1); }

    frames.push({
      parts: parts.map(p => ({ ...p })),
      clusters: clusters.map(c => ({ ...c })),
      crust: crust.map(c => ({ ...c })),
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Qualifying-seed search
// ---------------------------------------------------------------------------
//
// The emergent sim cannot be *made* to land in a size band — round 8 measured
// 45 / 52 / 26 / 32 across four seeds and found the outcome chaotically sensitive
// to every constant it tried. So don't fight the physics; use the spec's own
// resampling pattern (§4: "the generator resamples until the body is in range").
// Candidate sub-seeds are a deterministic hash chain off the date seed, each
// costs one ~1 s simulation, and the first candidate whose generation qualifies
// is the one that ships. Everything stays a pure function of the date.

interface SoupRun {
  frames: SoupState[]; peak: number; peakAt: number;
  meanPop: number; minPop: number; meanBodies: number;
  eyes: boolean; empty: boolean; tailEmptyFrom: number;
  formedFrames: number; mono: number; sym: number;
}

const biggestCluster = (st: SoupState): number => Math.max(0, ...st.clusters.map(c => c.n));

/**
 * Qualifying criteria, round 9. The single-body focus is relaxed: Cody wants
 * "pixels/goo/creatures formed/interacting taking up more of the blank space",
 * so the arc has to deliver an inhabited void, not one lonely creature.
 *
 *   BAND     at least one cluster reaches 52–68 cells while still forming
 *   POP      standing population on screen (all COPIES) inside a target range
 *   BODIES   at least ~2 formed-or-forming clusters (>= 8 cells) coexisting on
 *            average — the interacting ecosystem rather than one blob
 *   EYES     a body actually matures far enough to open eyes
 *   EMPTY    the arc is bare at age S — the seam requirement, non-negotiable
 *
 * The measurements below are taken on the arc; POP and BODIES are summed over the
 * COPIES ages visible together, i.e. what a viewer actually sees.
 */
function assess(frames: SoupState[], T: number): SoupRun {
  const S = frames.length;
  // Peak is measured over the *formative* part of the arc only. A body that only
  // reaches size while it is already being carried out of frame is not a body the
  // viewer ever sees, so it must not satisfy the band.
  const formative = S - S / ARC_COPIES;
  let peak = 0, peakAt = 0;
  frames.slice(0, formative).forEach((st, i) => {
    const b = biggestCluster(st); if (b > peak) { peak = b; peakAt = i; }
  });
  let popSum = 0, minPop = Infinity, bodySum = 0;
  for (let t = 0; t < T; t++) {
    let pop = 0, bodies = 0;
    for (const age of visibleAges(t, T)) {
      const st = frames[age];
      pop += st.parts.length + st.crust.length;
      bodies += st.clusters.filter(c => c.n >= 8).length;
    }
    popSum += pop; bodySum += bodies; minPop = Math.min(minPop, pop);
  }
  // how far back from the end the arc has been continuously empty — the wrap
  // needs at least the final frame bare
  let tail = S;
  while (tail > 0) {
    const st = frames[tail - 1];
    if (st.parts.length || st.clusters.length || st.crust.length) break;
    tail--;
  }
  // body style, measured on the biggest cluster once it is big enough to have one
  const big = frames.map(st => st.clusters.slice().sort((x, y) => y.n - x.n)[0]).filter(Boolean) as Cluster[];
  const grown = big.filter(c => c.n >= 24);
  const formedFrames = big.filter(c => c.formed).length;
  return {
    frames, peak, peakAt,
    formedFrames,
    mono: grown.length ? grown.reduce((s2, c) => s2 + c.mono, 0) / grown.length : 0,
    sym: grown.length ? grown.reduce((s2, c) => s2 + c.sym, 0) / grown.length : 0,
    meanPop: popSum / T, minPop, meanBodies: bodySum / T,
    eyes: frames.some(st => st.parts.some(p => p.eye > 0.5)),
    empty: tail <= S - 1,
    tailEmptyFrom: tail,
  };
}

const POP_BAND: [number, number] = [130, 340];   // standing pixels on screen
const MIN_MEAN_BODIES = 1.8;                     // coexisting formed-or-forming clusters

/**
 * ROUND 11 adds STYLE to the criteria. The physics cannot guarantee that a body
 * organises — it can stall as goo, or a late merge can scramble it — so the same
 * resampling that enforces the size band now also insists the creature actually
 * becomes one: monochrome, symmetric, eyed, for a real stretch of the arc.
 */
const MIN_FORMED_FRAMES = 120;

/**
 * ROUND 12c — THE RELAXATION LADDER.
 *
 * Round 9-12 ran ONE threshold set against `--tries` candidates and, if none
 * passed, fell back to "the seam-safe run nearest the band centre" with a
 * printed warning. That is a shipped failure waiting for a date: production
 * regenerates daily off the date seed, so a seed whose whole candidate chain
 * misses the band produces an unreviewed banner. Measured at round 12 it was
 * not hypothetical — 2 of 8 corpus seeds satisfied nothing inside 20 tries.
 *
 * The ladder replaces the cliff with a staircase. Rungs are walked in order;
 * each rung extends the SAME deterministic sub-seed chain a little further and
 * tests it against slightly looser bounds, so an ordinary date stops at rung 0
 * after one or two simulations and only a genuinely awkward one pays for the
 * lower rungs. Nothing is random and nothing depends on wall-clock: the rung
 * that ships is a pure function of the date.
 *
 * What relaxes, and what never does:
 *
 *   * BAND widens both ways, but its floor never goes below FORMED_MIN — a body
 *     under 40 cells cannot satisfy the soup's own `formed` test at all, so
 *     accepting one would just be accepting a lump.
 *   * FORMED FRAMES, POP and BODIES relax — they are richness targets, and a
 *     thinner void is worse than the benchmark but is not broken.
 *   * EYES never relaxes above the last resort. A creature is a face.
 *   * EMPTY never relaxes at all. It is the wrap invariant: a generation that
 *     is not bare at age S pops at the seam, which is the one defect a viewer
 *     cannot un-see. The last-resort rung still ranks empty runs above
 *     non-empty ones and, failing everything, takes the run that comes closest
 *     to bare — so the ladder always terminates, but never terminates by
 *     preferring a visible seam.
 */
interface Rung { upto: number; grow: [number, number]; formed: number; pop: [number, number]; bodies: number }

const RUNGS: readonly Rung[] = [
  { upto: 6, grow: [0, 0], formed: MIN_FORMED_FRAMES, pop: POP_BAND, bodies: MIN_MEAN_BODIES },
  { upto: 12, grow: [-3, 8], formed: 90, pop: [120, 360], bodies: 1.5 },
  { upto: 20, grow: [-5, 18], formed: 60, pop: [110, 380], bodies: 1.2 },
  { upto: 28, grow: [-5, 1e9], formed: 30, pop: [100, 420], bodies: 1.0 },
];

const rungBand = (band: [number, number], g: [number, number]): [number, number] =>
  [Math.max(SOUP.FORMED_MIN, band[0] + g[0]), band[1] + g[1]];

const meets = (r: SoupRun, band: [number, number], rung: Rung): boolean => {
  const [lo, hi] = rungBand(band, rung.grow);
  return r.peak >= lo && r.peak <= hi && r.empty && r.eyes
    && r.meanPop >= rung.pop[0] && r.meanPop <= rung.pop[1]
    && r.meanBodies >= rung.bodies
    && r.formedFrames >= rung.formed;
};

/** Rung 0 — the strict set, and what every metric in the report is quoted at. */
const qualifies = (r: SoupRun, band: [number, number]): boolean => meets(r, band, RUNGS[0]);

/**
 * Walk the ladder over a candidate chain reachable through `get`.
 *
 * Each rung raises the candidate budget AND loosens the bounds, but inside a
 * rung's budget the STRICTEST bounds are always tried first — so the ladder
 * never ships a relaxed candidate when a strict one exists at a cost it was
 * already willing to pay. Assessments are cached by the caller, so the whole
 * walk costs exactly `highest candidate index reached + 1` simulations.
 */
function walkLadder(band: [number, number], budget: number, get: (i: number) => SoupRun):
{ rung: number; cand: number; sims: number } {   // rung -1 => nothing met any rung
  let deepest = -1;
  const fetch = (i: number): SoupRun => { deepest = Math.max(deepest, i); return get(i); };
  for (let k = 0; k < RUNGS.length; k++) {
    const upto = Math.min(RUNGS[k].upto, budget);
    for (let j = 0; j <= k; j++)
      for (let i = 0; i < upto; i++)
        if (meets(fetch(i), band, RUNGS[j])) return { rung: j, cand: i, sims: deepest + 1 };
    if (RUNGS[k].upto >= budget) break;
  }
  return { rung: -1, cand: -1, sims: deepest + 1 };
}

interface SoupPick extends SoupRun { candidate: number; subSeed: number; qualified: boolean; rung: number }

/** Deterministic hash chain of candidate sub-seeds off the date seed. */
const subSeeds = (seed: number, n: number): number[] => {
  const chain = mulberry32(seed ^ 0x50a9);
  return Array.from({ length: n }, () => (chain() * 4294967296) >>> 0);
};

/**
 * Walk the ladder. `tries` caps the total number of simulations; the last-resort
 * rung then ranks whatever was simulated, so this ALWAYS returns a pick for any
 * seed and any tries >= 1. Candidates are simulated once and reused across
 * rungs — a rung costs only the candidates it adds.
 */
function findSoup(
  seed: number, releaseAt: Map<number, Release[]>, S: number, T: number, colors: string[],
  band: [number, number], tries: number, log = false,
): SoupPick {
  const budget = Math.max(1, Math.min(tries, RUNGS[RUNGS.length - 1].upto));
  const cands = subSeeds(seed, budget);
  const runs: SoupRun[] = [];
  const simulate = (i: number): SoupRun => {
    while (runs.length <= i) {
      const r = assess(simulateSoup(mulberry32(cands[runs.length]), releaseAt, S, colors), T);
      if (log) console.log(`    cand ${runs.length}: peak ${String(r.peak).padStart(3)} @${String(r.peakAt).padStart(4)} ` +
        `pop ${r.meanPop.toFixed(0).padStart(3)}/min ${String(r.minPop).padStart(3)} ` +
        `bodies ${r.meanBodies.toFixed(1)} mono ${r.mono.toFixed(2)} sym ${r.sym.toFixed(2)} ` +
        `formed ${String(r.formedFrames).padStart(3)} ` +
        `empty-from ${r.tailEmptyFrom}/${S}${qualifies(r, band) ? '   QUALIFIES' : ''}`);
      runs.push(r);
    }
    return runs[i];
  };

  const hit = walkLadder(band, budget, simulate);
  if (hit.rung >= 0)
    return {
      ...runs[hit.cand], candidate: hit.cand, subSeed: cands[hit.cand],
      qualified: hit.rung === 0, rung: hit.rung,
    };

  // Last resort: nothing met even the loosest rung. Rank what was simulated —
  // seam first (never trade the wrap away), then the longest formed window,
  // then nearest the requested band centre. Deterministic and total.
  const mid = (band[0] + band[1]) / 2;
  const best = runs.map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.empty) - Number(a.r.empty)
      || (b.r.empty ? 0 : a.r.tailEmptyFrom - b.r.tailEmptyFrom)
      || b.r.formedFrames - a.r.formedFrames
      || Math.abs(a.r.peak - mid) - Math.abs(b.r.peak - mid))[0];
  return { ...best.r, candidate: best.i, subSeed: cands[best.i], qualified: false, rung: RUNGS.length };
}

/**
 * Every particle draws the same way whether it is drifting or belonging — the
 * only difference an observer can see is that bonded ones have settled into a
 * lattice. Eyes are just particles whose colour has eased toward off-white.
 */
function drawSoup(ctx: Ctx, st: SoupState, colors: string[]): void {
  for (const c of st.crust) cell(ctx, c.x, c.y, mixOnBg(colors[c.c], 0.85));
  // Breath and blink are draw-time only — never sim mutations, exactly as the
  // reference does it. A blinking eye shows the DOMINANT BODY COLOUR in the
  // socket rather than going dark, which is what makes the blink read as a lid.
  const meta = new Map(st.clusters.map(cl => [cl.id, cl]));
  const bob = new Map<number, number>();
  for (const cl of st.clusters)
    bob.set(cl.id, cl.formed && Math.sin(cl.theta * 3 + cl.n) > 0 ? 1 : 0);
  for (const p of st.parts) {
    const base = colors[p.c];
    const cl = p.cluster >= 0 ? meta.get(p.cluster) : undefined;
    let col: string;
    if (p.eye > 0.05) {
      col = cl && cl.formed && cl.blink < 0
        ? colors[cl.dominant]
        : mixHexTo(base, P.offwhite, Math.min(1, p.eye));
    } else col = p.streak > 0 ? hot(base, 0.45) : base;
    const dy = p.cluster >= 0 ? (bob.get(p.cluster) ?? 0) : 0;
    cell(ctx, Math.round(p.x), Math.round(p.y) + dy, col);
  }
}

/** Blend two hexes — used only for the gradual emergence of eyes. */
function mixHexTo(a: string, b: string, k: number): string {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const m = (sa: number, sb: number) => Math.round(sa + (sb - sa) * k);
  return `#${((m(A >> 16, B >> 16) << 16) | (m((A >> 8) & 255, (B >> 8) & 255) << 8) | m(A & 255, B & 255))
    .toString(16).padStart(6, '0')}`;
}


/**
 * ROUND 10 — takeovers are derived from the DRAWN GEOMETRY, not from the walk's
 * stop list.
 *
 * Deriving them from stops left 217 of 1457 flow-in-component events (15 %)
 * happening through an unlit part: a fixed 14-frame hold could expire while a
 * long trail was still crossing a big component, and a spine that merely clipped
 * a component it did not stop at never lit it at all. Scanning the slot array for
 * the runs where a flow's own cells lie inside a component's footprint makes the
 * invariant exact — the part is lit precisely while the signal is inside it, for
 * as long as the whole comet takes to pass through, then releases.
 */
function collectTransitHits(flows: Sched[], graph: Graph, T: number): Map<number, Hit[]> {
  const N = T * SLOTS_PER_FRAME;
  const comps = graph.nodes
    .map((n, i) => ({ i, r: n.comp?.rect }))
    .filter((c): c is { i: number; r: NonNullable<typeof c.r> } => !!c.r);
  const hits = new Map<number, Hit[]>();
  // Per COMPONENT, not per slot: component footprints overlap (a fan seated on a
  // heatsink, a QFP's pin ring reaching under its neighbour), and taking only the
  // first match left the other part dark while a signal crossed it.
  for (const f of flows)
    for (const c of comps) {
      const inside = new Array<boolean>(N);
      for (let k = 0; k < N; k++) {
        const p = f.slots[k];
        inside[k] = !!p && p.x >= c.r.x && p.x < c.r.x + c.r.w && p.y >= c.r.y && p.y < c.r.y + c.r.h;
      }
      for (let k = 0; k < N;) {
        if (!inside[k]) { k++; continue; }
        let end = k;
        while (end + 1 < N && inside[end + 1]) end++;
        // lit from the moment the head enters until the last trail cell has left
        hits.set(c.i, [...(hits.get(c.i) ?? []), {
          frame: mod(Math.floor(k / SLOTS_PER_FRAME), T),
          hold: Math.ceil((end - k + f.trail) / SLOTS_PER_FRAME) + 2,
          color: f.color,
        }]);
        k = end + 1;
      }
    }
  return hits;
}

interface Assembled {
  b: Board; flows: Sched[]; events: EscapeEvent[]; hits: Map<number, Hit[]>;
  pick: SoupPick; S: number;
}

function assemble(seed: number, pal: Palette, T: number, band: [number, number], tries: number, log = false): Assembled {
  const b = buildBoard(seed, pal);
  const rng = mulberry32(seed ^ 0x5eed);
  const dToC = distanceToConnector(b.graph);
  const { flows, events } = buildBlend(rng, b.graph, dToC, T);

  const hits = collectTransitHits(flows, b.graph, T);

  // Genesis: what escapes is released into the void as free soup, one generation
  // arc per loop, scheduled circularly (see the ROUND 9 note above).
  const S = genLength(T);
  const releaseAt = buildReleaseSchedule(events, T);
  const pick = findSoup(seed, releaseAt, S, T, ACCENT_LIST, band, tries, log);
  return { b, flows, events, hits, pick, S };
}

function renderLoop(a: Assembled, T: number, pal: Palette): Canvas[] {
  const { b, flows, events, hits, pick } = a;
  return Array.from({ length: T }, (_, t) => {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(b.base, 0, 0);
    hits.forEach((list, node) => {
      const w = washAt(list, t, T);
      const comp = b.graph.nodes[node].comp;
      if (w && comp) washComp(ctx, b.baseData, comp, w.color, w.k, pal.washCeil);
    });
    drawInteractions(ctx, b.graph, b.baseData, hits, t, T, pal);
    events.forEach(e => {
      const age = mod(t - e.frame, T);
      if (age > 10) return;
      const f = FINGERS[e.finger];
      box(ctx, f.x, f.y, FINGER_W, f.h, mixOnBg(e.color, Math.max(0.35, 1 - age / 10)));
    });
    drawBlend(ctx, flows, t, T, pal);
    // the wrap: the outgoing generation and the incoming one share the void
    if (!process.env.PROTO_NOSOUP) for (const age of visibleAges(t, T)) drawSoup(ctx, pick.frames[age], ACCENT_LIST);
    return canvas;
  });
}

/** Void population at each loop frame — the standing-population check. */
function voidCensus(pick: SoupPick, T: number): { free: number; bonded: number; crust: number; body: number }[] {
  return Array.from({ length: T }, (_, t) => {
    let free = 0, bonded = 0, crust = 0, body = 0;
    for (const age of visibleAges(t, T)) {
      const st = pick.frames[age];
      free += st.parts.filter(p => p.cluster < 0).length;
      bonded += st.parts.filter(p => p.cluster >= 0).length;
      crust += st.crust.length;
      body = Math.max(body, biggestCluster(st));
    }
    return { free, bonded, crust, body };
  });
}

function runEscape(seed: number, pal: Palette, out: string, T: number, band: [number, number], tries: number): void {
  const a = assemble(seed, pal, T, band, tries, true);
  write(out, Buffer.from(gifOf(renderLoop(a, T, pal), 12)));

  const k = (kind: string) => a.flows.filter(f => f.kind === kind).length;
  const census = voidCensus(a.pick, T);
  const total = census.map(c => c.free + c.bonded + c.crust);
  const minPop = Math.min(...total), maxPop = Math.max(...total);
  const meanPop = total.reduce((s, v) => s + v, 0) / T;
  const fingersUsed = new Set(a.events.map(e => e.finger));
  const streams = a.flows.filter(f => f.kind === 'stream');
  const transits = streams.map(f => f.stops.filter(st => a.b.graph.nodes[st.node].comp).length);
  const meanTransit = transits.reduce((s2, v) => s2 + v, 0) / Math.max(1, transits.length);
  const multi = transits.filter(v => v >= MIN_TRANSITS).length;
  console.log(`  ${k('courier')} couriers -> ${k('stream')} streams -> ${a.events.length} escapes/loop ` +
    `(+${k('interior')} interior), ${a.hits.size} responsive nodes`);
  console.log(`  fingers used: ${fingersUsed.size}/9  [${[...fingersUsed].sort((x, y) => x - y).join(',')}]`);
  console.log(`  component transits per stream: [${transits.join(', ')}]  mean ${meanTransit.toFixed(1)}; ` +
    `${multi}/${streams.length} streams cross >=${MIN_TRANSITS} components before escaping`);
  console.log(`  generation S=${a.S} (${ARC_COPIES} arcs x T=${T}); candidate ${a.pick.candidate} ` +
    `(sub-seed 0x${a.pick.subSeed.toString(16)}), ladder rung ${a.pick.rung}` +
    `${a.pick.rung === 0 ? ' (strict)' : a.pick.rung < RUNGS.length ? ' (relaxed)' : '  [LAST RESORT]'}` +
    `, ${a.pick.candidate + 1} simulation(s)`);
  console.log(`  body peak ${a.pick.peak} cells @age ${a.pick.peakAt}; ` +
    `eyes ${a.pick.eyes ? 'yes' : 'no'}; arc empty from age ${a.pick.tailEmptyFrom}/${a.S}`);
  console.log(`  standing void population per loop frame: min ${minPop}, mean ${meanPop.toFixed(1)}, max ${maxPop} ` +
    `(fill ${(100 * meanPop / ((VOID_X1 - VOID_X0 + 1) * (VOID_Y1 - VOID_Y0 + 1))).toFixed(1)}%)`);
  {
    const big = a.pick.frames.map(st => st.clusters.slice().sort((x, y) => y.n - x.n)[0]).filter(Boolean);
    const grown = big.filter(c => c!.n >= 24);
    const at = (f: (c: Cluster) => number) => grown.length
      ? (grown.reduce((s2, c) => s2 + f(c!), 0) / grown.length) : 0;
    const ripe = big.filter(c => c!.n >= SOUP.FORMED_MIN);
    console.log(`  body style (bodies >=24 cells): mono ${at(c => c.mono).toFixed(2)} ` +
      `(soup wants >=${SOUP.FORMED_MONO}), symmetry ${at(c => c.sym).toFixed(2)} ` +
      `(>=${SOUP.FORMED_SYM}); formed on ${ripe.filter(c => c!.formed).length}/${ripe.length} ripe frames`);
  }
  console.log(`  coexisting clusters >=8 cells: mean ${a.pick.meanBodies.toFixed(1)}; ` +
    `biggest on screen min ${Math.min(...census.map(c => c.body))} max ${Math.max(...census.map(c => c.body))}`);
  console.log(`  release: 1-2 px every ${SOUP.BEAT} frames, globally (${Math.ceil(T / SOUP.BEAT)} beats/loop)`);
}

/** Contact sheet of arbitrary loop frames — the phase test and the seam test. */
function runStills(seed: number, pal: Palette, out: string, T: number, list: number[],
  band: [number, number], tries: number): void {
  const a = assemble(seed, pal, T, band, tries, true);
  const all = renderLoop(a, T, pal);
  const canvas = createCanvas(WIDTH, (HEIGHT + 4) * list.length);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#303030'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  list.forEach((f, i) => ctx.drawImage(all[mod(f, T)], 0, i * (HEIGHT + 4)));
  write(out, canvas.toBuffer('image/png'));
  console.log(`  frames ${list.join(', ')}`);
}

/** Crop of the void only, stacked — cheap way to read the soup closely. */
function runVoid(seed: number, pal: Palette, out: string, T: number, list: number[],
  band: [number, number], tries: number): void {
  const a = assemble(seed, pal, T, band, tries, false);
  const all = renderLoop(a, T, pal);
  const x0 = (BOARD_RIGHT - 4) * CELL, w = WIDTH - x0, Z = 2;
  const canvas = createCanvas((w * Z + 4) * list.length, HEIGHT * Z);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#303030'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  list.forEach((f, i) => ctx.drawImage(all[mod(f, T)], x0, 0, w, HEIGHT, i * (w * Z + 4), 0, w * Z, HEIGHT * Z));
  write(out, canvas.toBuffer('image/png'));
  const census = voidCensus(a.pick, T);
  for (const f of list) {
    const ages = visibleAges(mod(f, T), T);
    for (const age of ages) {
      const st = a.pick.frames[age];
      const big = st.clusters.slice().sort((x, y) => y.n - x.n)[0];
      if (!big) { console.log(`    f${f} age${age}: no clusters`); continue; }
      const mine = st.parts.filter(p => p.cluster === big.id);
      const xs = mine.map(p => p.x), ys = mine.map(p => p.y);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      console.log(`    f${f} age${age}: biggest n=${big.n} bbox ${w.toFixed(1)}x${h.toFixed(1)} ` +
        `at (${big.x.toFixed(0)},${big.y.toFixed(0)}) density ${(big.n / Math.max(1, (w + 1) * (h + 1))).toFixed(2)}`);
    }
  }
  console.log(`  void crop, frames ${list.map(f => `${f}(free ${census[mod(f, T)].free}/bond ` +
    `${census[mod(f, T)].bonded}/crust ${census[mod(f, T)].crust}/body ${census[mod(f, T)].body})`).join('  ')}`);
}

// ---------------------------------------------------------------------------
// Continuity checker (round 10)
// ---------------------------------------------------------------------------
//
// Cody: "can you check all the colored lines though and make sure no
// discontinuities". Eyeballing a 360-frame loop cannot prove that, so this is a
// checker rather than an inspection. Three properties, over every frame:
//
//   A  every static copper run is one 8-connected set of cells end to end
//   B  every flow's slot array steps by at most one cell — a flow can never
//      teleport, at a chamfer, a junction, a component, or across the wrap
//   C  every flow's DRAWN cells in a given frame form one 8-connected run, so
//      no head or trail fragment is ever orphaned from its own comet
//
// B is the strong invariant: if consecutive slots are always adjacent then C
// follows for any trail length, at any frame, including the wrap. C is still
// checked directly because it is what a viewer actually sees.

const cheb = (a: Pt, b: Pt): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Number of 8-connected components in a cell set. */
function islandsOf(cells: Pt[]): number {
  const key = (p: Pt) => `${p.x},${p.y}`;
  const pool = new Set(cells.map(key));
  let n = 0;
  while (pool.size) {
    const start = pool.values().next().value as string;
    pool.delete(start);
    const [sx, sy] = start.split(',').map(Number);
    const q: Pt[] = [{ x: sx, y: sy }];
    while (q.length) {
      const p = q.pop()!;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${p.x + dx},${p.y + dy}`;
          if (!pool.has(k)) continue;
          pool.delete(k);
          q.push({ x: p.x + dx, y: p.y + dy });
        }
    }
    n++;
  }
  return n;
}

/** The cells `drawBlend` paints for one flow at one frame. */
function flowDrawn(f: Sched, t: number, N: number): Pt[] {
  const head = Math.round(t * SLOTS_PER_FRAME);
  const out: Pt[] = [];
  for (let d = f.trail - 1; d >= 0; d--) {
    const p = f.slots[mod(head - d, N)];
    if (p) out.push(p);
  }
  return out;
}

function runContinuity(seeds: number[], T: number, band: [number, number], tries: number): void {
  let grandTotal = 0;
  for (const seed of seeds) {
    const a = assemble(seed, VIVID, T, band, tries, false);
    const N = T * SLOTS_PER_FRAME;

    // --- A: static copper ---------------------------------------------------
    const netBad: string[] = [];
    a.b.scene.nets.forEach((n, i) => {
      const k = islandsOf(n.cells);
      if (k !== 1) netBad.push(`net${i}(${n.color}) ${k} islands, ${n.cells.length} cells`);
    });

    // --- B: flow slot adjacency --------------------------------------------
    const jumpsByKind = new Map<string, { n: number; max: number; sample: string }>();
    let runGaps = 0;
    for (const f of a.flows) {
      let prev: Pt | null = null, prevIdx = -1, runs = 0, inRun = false;
      for (let k = 0; k <= N; k++) {
        const p = f.slots[k % N];
        if (p && !inRun) { runs++; inRun = true; }
        if (!p) { inRun = false; prev = null; continue; }
        if (prev) {
          const d = cheb(prev, p);
          if (d > 1) {
            const e = jumpsByKind.get(f.kind) ?? { n: 0, max: 0, sample: '' };
            e.n++;
            if (d > e.max) {
              e.max = d;
              e.sample = `slot ${prevIdx}->${k % N} (${prev.x},${prev.y})->(${p.x},${p.y}) d=${d}`;
            }
            jumpsByKind.set(f.kind, e);
          }
        }
        prev = p; prevIdx = k % N;
      }
      // an interior wanderer runs continuously; a courier/stream is off for part
      // of the loop, so exactly one null gap is expected
      if (f.kind === 'interior' ? runs > 1 : runs > 1) runGaps += runs - 1;
    }

    // --- C: per-frame drawn contiguity -------------------------------------
    let frameBreaks = 0, worstFrame = -1, worstIslands = 0;
    for (let t = 0; t < T; t++)
      for (const f of a.flows) {
        const cells = flowDrawn(f, t, N);
        if (cells.length < 2) continue;
        const k = islandsOf(cells);
        if (k > 1) {
          frameBreaks++;
          if (k > worstIslands) { worstIslands = k; worstFrame = t; }
        }
      }

    // --- D: transit lighting ------------------------------------------------
    // The perceptual check a cell checker usually cannot do: whenever a flow's
    // cells are inside a component's footprint, that component must be lit. A
    // signal sliding through a dark chip is exactly the "jumping a component it
    // should pass through" failure, and it is measurable.
    const comps = a.b.graph.nodes
      .map((n, i) => ({ i, r: n.comp?.rect }))
      .filter((c): c is { i: number; r: NonNullable<typeof c.r> } => !!c.r);
    let dark = 0, wrongColour = 0, transitFrames = 0;
    for (let t = 0; t < T; t++)
      for (const f of a.flows) {
        const cells = flowDrawn(f, t, N);
        const touched = new Set<number>();
        for (const p of cells)
          for (const c of comps)
            if (p.x >= c.r.x && p.x < c.r.x + c.r.w && p.y >= c.r.y && p.y < c.r.y + c.r.h) touched.add(c.i);
        for (const i of touched) {
          transitFrames++;
          const w = washAt(a.hits.get(i), t, T);
          if (!w) dark++;
          else if (w.color !== f.color) wrongColour++;
        }
      }

    // --- E: everything travels on drawn copper -----------------------------
    // Cody: "some of the paths are not on wire or anything, make sure everything
    // travels on a path". Legal ground is drawn trace copper, a component's own
    // footprint (a signal inside a chip is on hardware), the connector gold, or
    // the void beyond the board edge (that is the escape, and it is the point).
    const copper = new Set<string>();
    for (const n of a.b.scene.nets) for (const c of n.cells) copper.add(`${c.x},${c.y}`);
    for (const c of a.b.fabric) copper.add(`${c.x},${c.y}`);
    for (const nd of a.b.graph.nodes) {
      const r = nd.comp?.rect;
      if (r) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) copper.add(`${x},${y}`);
    }
    for (const f of FINGERS)
      for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + FINGER_W; x++) copper.add(`${x},${y}`);
    const offCopper = new Map<string, number>();
    let offCells = 0, onCells = 0;
    for (const f of a.flows) {
      const seen = new Set<string>();
      for (const p of f.slots) {
        if (!p || p.x > BOARD_RIGHT) continue;
        const k = `${p.x},${p.y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (copper.has(k)) { onCells++; continue; }
        offCells++;
        offCopper.set(f.kind, (offCopper.get(f.kind) ?? 0) + 1);
      }
    }

    const totalJumps = [...jumpsByKind.values()].reduce((s, e) => s + e.n, 0);
    grandTotal += netBad.length + totalJumps + frameBreaks + dark + offCells;
    console.log(`seed ${seed}:`);
    console.log(`  A static copper : ${a.b.scene.nets.length} nets, ${netBad.length} discontinuous` +
      (netBad.length ? `\n      ${netBad.slice(0, 6).join('\n      ')}` : ''));
    console.log(`  B slot steps    : ${totalJumps} jumps > 1 cell` +
      (totalJumps ? `\n      ${[...jumpsByKind.entries()]
        .map(([k, e]) => `${k}: ${e.n} jumps, max ${e.max} cells — ${e.sample}`).join('\n      ')}` : ''));
    console.log(`  C drawn comets  : ${frameBreaks} flow-frames fragmented` +
      (frameBreaks ? ` (worst ${worstIslands} pieces at frame ${worstFrame})` : ''));
    console.log(`  D transit light : ${transitFrames} flow-in-component events, ${dark} through a DARK part` +
      `, ${wrongColour} lit in another flow's colour (contested, allowed)`);
    console.log(`  E on-copper     : ${onCells + offCells} distinct flow cells on board, ${offCells} OFF copper` +
      (offCells ? ` [${[...offCopper.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}]` : ''));
  }
  console.log(`\nTOTAL DEFECTS: ${grandTotal}${grandTotal ? '' : '   — CLEAN'}`);
}

/**
 * Fabric diagnostic — is the board actually one interconnected circuit, and does
 * its topology support real rerouting? Reports the cycle rank (E − V + C): 0
 * means a forest, i.e. exactly one path between any two nodes and no alternative
 * route to choose. Also reports whether every one of the nine fingers is
 * reachable, and from how much of the board.
 */
function runFabric(seeds: number[]): void {
  for (const seed of seeds) {
    const b = buildBoard(seed, VIVID);
    const g = b.graph;
    const V = g.nodes.length, E = g.edges.length;
    // connected components over the node set
    const comp = g.nodes.map(() => -1);
    let C = 0;
    for (let i = 0; i < V; i++) {
      if (comp[i] >= 0) continue;
      const q = [i]; comp[i] = C;
      while (q.length) {
        const n = q.shift()!;
        for (const ei of g.adj[n]) {
          const o = g.edges[ei].a === n ? g.edges[ei].b : g.edges[ei].a;
          if (comp[o] < 0) { comp[o] = C; q.push(o); }
        }
      }
      C++;
    }
    // cycle rank on the SIMPLE graph — a bundle's parallel wires are the same
    // lane, so counting them as separate edges would fake alternative routes
    const simple = new Set(g.edges.map(e => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`)).size;
    const fingers = g.nodes.map((n, i) => ({ i, f: n.fingerIdx })).filter(x => x.f >= 0);
    const wired = fingers.filter(x => g.adj[x.i].length > 0);
    // how many component nodes can reach each finger
    const feeders = fingers.map(x => {
      const d = distanceToNode(g, x.i);
      return g.nodes.filter((n, i) => n.comp && Number.isFinite(d[i])).length;
    });
    if (process.env.PROTO_EDGES)
      g.edges.forEach((e, i) => {
        const lbl = (n: number) => g.nodes[n].comp
          ? `C(${g.nodes[n].comp!.rect.x},${g.nodes[n].comp!.rect.y})` : `F${g.nodes[n].fingerIdx}`;
        console.error(`  e${i}: ${lbl(e.a)} <-> ${lbl(e.b)}  (${e.cells.length} cells)`);
      });
    const cells = b.scene.nets.reduce((s, n) => s + n.cells.length, 0);
    const uniq = new Set(b.scene.nets.flatMap(n => n.cells.map(c => `${c.x},${c.y}`))).size;
    const wiredV = g.nodes.filter((_, i) => g.adj[i].length > 0).length;
    console.log(`seed ${seed}: nodes ${V} (wired ${wiredV}), edges ${E} (simple ${simple}), ` +
      `islands ${C}, simple cycle rank ${simple - wiredV + (C - (V - wiredV))}`);
    console.log(`  fingers wired ${wired.length}/9  feeders per finger [${feeders.join(', ')}]  ` +
      `(of ${g.nodes.filter(n => n.comp).length} components)`);
    console.log(`  copper: ${cells} drawn cells, ${uniq} unique`);
  }
}

/** Arc timeline: how a generation's biggest body organises over its own life. */
function runArc(seed: number, T: number, band: [number, number], tries: number): void {
  const a = assemble(seed, VIVID, T, band, tries, false);
  const S = a.S;
  console.log(`seed ${seed}: S=${S} (${ARC_COPIES} x ${T}), releases/arc ${Math.ceil(T / SOUP.BEAT)}, ` +
    `exit from age ${S - S / ARC_COPIES}`);
  let firstNuc = -1, first40 = -1;
  a.pick.frames.forEach((st, age) => {
    if (firstNuc < 0 && st.clusters.length) firstNuc = age;
    if (first40 < 0 && biggestCluster(st) >= SOUP.FORMED_MIN) first40 = age;
  });
  console.log(`  first nucleation age ${firstNuc}; biggest body reaches ${SOUP.FORMED_MIN} cells at age ${first40}`);
  const step = Math.floor(S / 12);
  const rows: string[] = [];
  for (let age = step; age < S; age += step) {
    const st = a.pick.frames[age];
    const big = st.clusters.slice().sort((x, y) => y.n - x.n)[0];
    const free = st.parts.filter(p => p.cluster < 0).length;
    rows.push(`${String(age).padStart(4)}: n=${String(big?.n ?? 0).padStart(3)} ` +
      `free=${String(free).padStart(3)} bond=${String(st.parts.length - free).padStart(3)} ` +
      `cl=${st.clusters.length} ` +
      `mono=${(big?.mono ?? 0).toFixed(2)} sym=${(big?.sym ?? 0).toFixed(2)} ` +
      `form=${(big?.form ?? 0).toFixed(2)} ${big?.formed ? 'FORMED' : ''}`);
  }
  console.log('  ' + rows.join('\n  '));
}

/**
 * The restraint measurement, redone for the dynamic board.
 *
 * §12.6.4 capped "cells differing from the fully-lit steady-state frame" at
 * 2.5 %. That test does not survive this section: there is no steady state any
 * more — flows travel every frame and the void is populated — so the honest
 * replacement measures what is actually in motion, split by where it lives.
 */
function runRestraint(seed: number, T: number, band: [number, number], tries: number): void {
  const a = assemble(seed, VIVID, T, band, tries, false);
  const frames = renderLoop(a, T, VIVID);
  const base = a.b.baseData;
  const boardCells = (BOARD_RIGHT - 1) * GRID_H, voidCells = (VOID_X1 - VOID_X0 + 1) * (VOID_Y1 - VOID_Y0 + 1);
  let peakBoard = 0, peakVoid = 0, sumBoard = 0, sumVoid = 0;
  for (const c of frames) {
    const d = c.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
    let onBoard = 0, inVoid = 0;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) {
        const i = ((y * CELL) * WIDTH + x * CELL) * 4;
        if (d[i] === base[i] && d[i + 1] === base[i + 1] && d[i + 2] === base[i + 2]) continue;
        if (x <= BOARD_RIGHT) onBoard++; else inVoid++;
      }
    peakBoard = Math.max(peakBoard, onBoard); peakVoid = Math.max(peakVoid, inVoid);
    sumBoard += onBoard; sumVoid += inVoid;
  }
  const pc = (n: number, of: number) => `${(100 * n / of).toFixed(2)} %`;
  console.log(`seed ${seed}, T=${T}, ${ARC_COPIES} generations — cells differing from the static board:`);
  console.log(`  on board (of ${boardCells} board cells): peak ${peakBoard} (${pc(peakBoard, boardCells)}), ` +
    `mean ${(sumBoard / T).toFixed(0)} (${pc(sumBoard / T, boardCells)})`);
  console.log(`  in void  (of ${voidCells} void cells): peak ${peakVoid} (${pc(peakVoid, voidCells)}), ` +
    `mean ${(sumVoid / T).toFixed(0)} (${pc(sumVoid / T, voidCells)})`);
  console.log(`  whole canvas (of ${GRID_W * GRID_H}): peak ${peakBoard + peakVoid} ` +
    `(${pc(peakBoard + peakVoid, GRID_W * GRID_H)}), mean ${((sumBoard + sumVoid) / T).toFixed(0)} ` +
    `(${pc((sumBoard + sumVoid) / T, GRID_W * GRID_H)})`);

  // The liveness invariant that replaces §11's ">= 2 of 3 trees complete":
  // the copper is now always complete, so what must never fall to zero is
  // TRAFFIC — signals in flight, and components currently holding a colour.
  const N = T * SLOTS_PER_FRAME;
  let minFlows = Infinity, minWash = Infinity, sumFlows = 0, sumWash = 0;
  for (let t = 0; t < T; t++) {
    const inFlight = a.flows.filter(f => flowDrawn(f, t, N).length > 0).length;
    let washed = 0;
    a.hits.forEach(list => { if (washAt(list, t, T)) washed++; });
    minFlows = Math.min(minFlows, inFlight); minWash = Math.min(minWash, washed);
    sumFlows += inFlight; sumWash += washed;
  }
  console.log(`  flows in flight per frame: min ${minFlows}, mean ${(sumFlows / T).toFixed(1)} (of ${a.flows.length})`);
  console.log(`  components holding a colour per frame: min ${minWash}, mean ${(sumWash / T).toFixed(1)} ` +
    `(of ${a.hits.size} responsive)`);
}

/** Which flow is where, and what a node's wash is doing, at one frame. */
function runProbe(seed: number, T: number, frames: number[], rect: number[],
  band: [number, number], tries: number): void {
  const a = assemble(seed, VIVID, T, band, tries, false);
  const N = T * SLOTS_PER_FRAME;
  const [rx, ry, rw, rh] = rect;
  const inRect = (p: Pt) => p.x >= rx && p.x < rx + rw && p.y >= ry && p.y < ry + rh;
  const nodesIn = a.b.graph.nodes
    .map((n, i) => ({ i, n }))
    .filter(({ n }) => n.comp && n.comp.rect.x < rx + rw && n.comp.rect.x + n.comp.rect.w > rx
      && n.comp.rect.y < ry + rh && n.comp.rect.y + n.comp.rect.h > ry);
  for (const { i, n } of nodesIn) {
    const hs = a.hits.get(i);
    console.log(`node ${i} comp@(${n.comp!.rect.x},${n.comp!.rect.y}) ${n.comp!.rect.w}x${n.comp!.rect.h}` +
      `  hits: ${hs ? hs.map(h => `${h.color}@f${h.frame}`).join(' ') : 'NONE'}`);
    for (const f of frames) {
      const w = washAt(hs, f, T);
      console.log(`    frame ${f}: wash ${w ? `${w.color} k=${w.k.toFixed(2)}` : 'none'}`);
    }
  }
  for (const f of frames)
    a.flows.forEach((fl, k) => {
      const cells = flowDrawn(fl, f, N).filter(inRect);
      if (cells.length) {
        console.log(`frame ${f}: flow${k} ${fl.kind} ${fl.color} -> ` +
          `${cells.length} cells in rect, head ${JSON.stringify(cells[cells.length - 1])}`);
        console.log(`   stops: ${fl.stops.map(st => `n${st.node}@slot${st.at}(f${Math.round(st.at / SLOTS_PER_FRAME)})`).join(' ')}`);
        const filled = fl.slots.reduce((c, p2) => c + (p2 ? 1 : 0), 0);
        console.log(`   slots filled ${filled}/${N}`);
      }
    });
}

/** 4x magnified crop — for perceptual breaks a cell checker cannot see. */
function runZoom(seed: number, pal: Palette, out: string, T: number, list: number[],
  rect: number[], band: [number, number], tries: number): void {
  const a = assemble(seed, pal, T, band, tries, false);
  const all = renderLoop(a, T, pal);
  const [gx, gy, gw, gh] = rect;
  const Z = 4;
  const canvas = createCanvas(gw * CELL * Z, (gh * CELL * Z + 6) * list.length);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#303030'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  list.forEach((f, i) => ctx.drawImage(all[mod(f, T)], gx * CELL, gy * CELL, gw * CELL, gh * CELL,
    0, i * (gh * CELL * Z + 6), gw * CELL * Z, gh * CELL * Z));
  write(out, canvas.toBuffer('image/png'));
  console.log(`  zoom x4 on grid ${rect.join(',')}, frames ${list.join(', ')}`);
}

/**
 * The ladder's own guarantee, run as production would run it: the real lazy
 * search, one whole year of real date seeds, reporting which rung each date
 * lands on and what it cost. This is the check that "every date seed
 * eventually qualifies" is a measured property and not a hope.
 */
function runLadder(seeds: number[], T: number, band: [number, number], tries: number): void {
  const Sarc = genLength(T);
  const rungHist: Record<number, number> = {};
  let sims = 0, worst = 0;
  const t0 = Date.now();
  for (const seed of seeds) {
    const b = buildBoard(seed, VIVID);
    const dToC = distanceToConnector(b.graph);
    const { events } = buildBlend(mulberry32(seed ^ 0x5eed), b.graph, dToC, T);
    const pick = findSoup(seed, buildReleaseSchedule(events, T), Sarc, T, ACCENT_LIST, band, tries);
    const n = pick.candidate + 1;
    rungHist[pick.rung] = (rungHist[pick.rung] ?? 0) + 1;
    sims += n; worst = Math.max(worst, n);
    if (pick.rung !== 0) console.log(`  seed ${seed}: rung ${pick.rung === RUNGS.length ? 'LAST-RESORT' : pick.rung} ` +
      `at candidate ${pick.candidate} — peak ${pick.peak}, formed ${pick.formedFrames}, empty ${pick.empty}`);
  }
  console.log(`\n${seeds.length} date seeds, S=${Sarc} (${ARC_COPIES} x ${T}), band ${band[0]}-${band[1]}`);
  console.log(`rung histogram: ${Object.keys(rungHist).sort((x, y) => Number(x) - Number(y))
    .map(k => `${Number(k) === RUNGS.length ? 'last-resort' : `rung ${k}`}: ${rungHist[Number(k)]}`).join(', ')}`);
  console.log(`unplaced seeds: 0 by construction; mean ${(sims / seeds.length).toFixed(2)} simulations/seed, ` +
    `worst ${worst}; wall ${((Date.now() - t0) / 1000).toFixed(0)} s total`);
}

/** Qualify-rate measurement across a seed corpus. */
function runSearchStats(seeds: number[], T: number, band: [number, number], tries: number): void {
  const S = genLength(T);
  console.log(`criteria: peak body ${band[0]}-${band[1]} cells, standing pop ${POP_BAND[0]}-${POP_BAND[1]}, ` +
    `mean coexisting clusters >=${MIN_MEAN_BODIES}, eyes, arc empty at age S`);
  console.log(`S=${S} (${ARC_COPIES} x ${T}), up to ${tries} candidates per seed\n`);
  console.log(`ladder rungs: ${RUNGS.map((r, k) => {
    const [lo, hi] = rungBand(band, r.grow);
    return `${k}) <=${r.upto} cands, band ${lo}-${hi > 1e8 ? 'inf' : hi}, formed>=${r.formed}, ` +
      `pop ${r.pop[0]}-${r.pop[1]}, bodies>=${r.bodies}`;
  }).join('  |  ')}  |  ${RUNGS.length}) last resort\n`);
  let hits = 0, candTotal = 0, candQualifying = 0, firstIdxSum = 0, simsSum = 0;
  const rungHist: Record<number, number> = {};
  const failed = { band: 0, pop: 0, bodies: 0, eyes: 0, empty: 0, style: 0 };
  for (const seed of seeds) {
    const b = buildBoard(seed, VIVID);
    const dToC = distanceToConnector(b.graph);
    const { events } = buildBlend(mulberry32(seed ^ 0x5eed), b.graph, dToC, T);
    const releaseAt = buildReleaseSchedule(events, T);
    const cands = subSeeds(seed, tries);
    const peaks: number[] = [];
    const runs: SoupRun[] = [];
    let first = -1;
    for (let i = 0; i < tries; i++) {
      const r = assess(simulateSoup(mulberry32(cands[i]), releaseAt, S, ACCENT_LIST), T);
      runs.push(r);
      peaks.push(r.peak);
      candTotal++;
      if (!(r.peak >= band[0] && r.peak <= band[1])) failed.band++;
      if (!(r.meanPop >= POP_BAND[0] && r.meanPop <= POP_BAND[1])) failed.pop++;
      if (r.meanBodies < MIN_MEAN_BODIES) failed.bodies++;
      if (r.formedFrames < MIN_FORMED_FRAMES) failed.style++;
      if (!r.eyes) failed.eyes++;
      if (!r.empty) failed.empty++;
      if (qualifies(r, band)) { candQualifying++; if (first < 0) first = i; }
    }
    if (first >= 0) { hits++; firstIdxSum += first; }
    // What the LADDER does with exactly these assessments — no extra sims.
    const hit = walkLadder(band, Math.min(tries, RUNGS[RUNGS.length - 1].upto), i => runs[i]);
    const lr = hit.rung >= 0 ? hit.rung : RUNGS.length, lc = hit.cand;
    rungHist[lr] = (rungHist[lr] ?? 0) + 1;
    simsSum += hit.sims;
    console.log(`seed ${seed}: first strictly-qualifying candidate ${first < 0 ? 'NONE' : first}` +
      `  | ladder: rung ${lr === RUNGS.length ? 'LAST-RESORT' : lr} at candidate ${lc} ` +
      `(${hit.sims} sim${hit.sims > 1 ? 's' : ''})  peaks [${peaks.join(', ')}]`);
  }
  console.log(`\nfailures by criterion (of ${candTotal} candidate sims): ` +
    `band ${failed.band}, pop ${failed.pop}, bodies ${failed.bodies}, eyes ${failed.eyes}, empty ${failed.empty}, style ${failed.style}`);
  console.log(`\nseeds satisfied (rung 0, strict): ${hits}/${seeds.length}` +
    `   per-candidate qualify rate: ${candQualifying}/${candTotal} = ${(100 * candQualifying / candTotal).toFixed(1)}%` +
    `   mean first-hit index: ${hits ? (firstIdxSum / hits).toFixed(2) : 'n/a'}`);
  console.log(`LADDER: every seed placed; rung histogram ` +
    `${Object.keys(rungHist).sort().map(k => `${Number(k) === RUNGS.length ? 'last-resort' : `rung ${k}`}: ${rungHist[Number(k)]}`).join(', ')}` +
    `   mean simulations per seed: ${(simsSum / seeds.length).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
const gifOf = (frames: Canvas[], fps: number): Uint8Array =>
  encodeGif(frames.map(c => c.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data), WIDTH, HEIGHT, fps);

function write(out: string, data: Uint8Array | Buffer): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, data);
  console.log(`wrote ${out}  (${(data.length / 1048576).toFixed(2)} MB)`);
}

function runFlowMode(mode: 'couriers' | 'streams', seed: number, pal: Palette, out: string, T: number): void {
  const b = buildBoard(seed, pal);
  const rng = mulberry32(seed ^ 0x5eed);
  const flows = mode === 'couriers'
    ? buildFlows(rng, b.graph, 14, 5, 70)
    : buildFlows(rng, b.graph, 6, 26, 150);
  const hits = collectHits(flows.map(f => f.route), flows.map(f => f.color), T);
  const frames = Array.from({ length: T }, (_, t) => renderDynamicFrame(b, flows, hits, t, T, pal));
  write(out, Buffer.from(gifOf(frames, 12)));
  console.log(`  ${flows.length} flows, ${[...hits.keys()].length} responsive nodes, ${T} frames`);
}

function runOoze(seed: number, pal: Palette, out: string, T: number): void {
  const b = buildBoard(seed, pal);
  const rng = mulberry32(seed ^ 0x00e2);
  const colors = shuffled(rng, ACCENT_LIST).slice(0, 3);
  const body = growOoze(rng, randInt(rng, 52, 68), colors);
  const site = { x: 241, y: 33 };
  const srcs = [0, 1, 2].map(i => {
    const f = FINGERS.filter(g => g.index === 1)[i];
    return { x: f.x + FINGER_W, y: f.y + 1 };
  });
  const frames = Array.from({ length: T }, (_, t) => renderOozeFrame(b, body, site, srcs, t, T, pal));
  write(out, Buffer.from(gifOf(frames, 12)));
  console.log(`  body ${body.length} cells, ${new Set(body.map(c => c.color)).size} colours, ${T} frames`);
}

/** Side-by-side still: current muted values vs full-vibrancy site tokens. */
function runCompare(seed: number, out: string, T: number): void {
  const panels = [MUTED, VIVID].map(pal => {
    const b = buildBoard(seed, pal);
    const rng = mulberry32(seed ^ 0x5eed);
    const flows = buildFlows(rng, b.graph, 6, 26, 150);
    const hits = collectHits(flows.map(f => f.route), flows.map(f => f.color), T);
    return renderDynamicFrame(b, flows, hits, Math.floor(T * 0.4), T, pal);
  });
  const canvas = createCanvas(WIDTH, HEIGHT * 2 + 4);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = P.dim; ctx.fillRect(0, 0, canvas.width, canvas.height);
  panels.forEach((p, i) => ctx.drawImage(p, 0, i * (HEIGHT + 4)));
  write(out, canvas.toBuffer('image/png'));
}

function main(): void {
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? '' : next;
  }
  const seed = Number(args.seed || 20260724);
  const pal = args.vivid !== undefined ? VIVID : MUTED;
  const mode = args.mode || 'streams';
  const T = Number(args.frames || 48);
  const tag = args.vivid !== undefined ? '-vivid' : '';
  const band = (args.band || '52-68').split('-').map(Number) as [number, number];
  const tries = Number(args.tries || 16);
  if (args.copies) ARC_COPIES = Number(args.copies);
  const list = (args.at || '').split(',').filter(Boolean).map(Number);
  switch (mode) {
    case 'couriers': runFlowMode('couriers', seed, pal, args.out || `review/dyn-couriers${tag}.gif`, T); break;
    case 'streams': runFlowMode('streams', seed, pal, args.out || `review/dyn-streams${tag}.gif`, T); break;
    case 'ooze': runOoze(seed, pal, args.out || `review/dyn-ooze${tag}.gif`, Number(args.frames || 84)); break;
    case 'escape': runEscape(seed, pal, args.out || `review/dyn-streams-vivid-v4.gif`, T, band, tries); break;
    case 'stills': runStills(seed, pal, args.out || 'review/r9-stills.png', T, list, band, tries); break;
    case 'void': runVoid(seed, pal, args.out || 'review/r9-void.png', T, list, band, tries); break;
    case 'search':
      runSearchStats((args.seeds || '20260724,20260101,20260315,20261111,20260602,20260930,20270101,20260218')
        .split(',').map(Number), T, band, tries);
      break;
    case 'continuity': runContinuity((args.seeds || '20260724,20260101,20260315').split(',').map(Number), T, band, tries); break;
    case 'arc': runArc(seed, T, band, tries); break;
    case 'restraint': runRestraint(seed, T, band, tries); break;
    case 'ladder': {
      const days = Number(args.days || 365);
      const start = new Date(Date.UTC(2026, 6, 25));
      const dates = Array.from({ length: days }, (_, i) => {
        const d = new Date(start.getTime() + i * 86400000);
        return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      });
      runLadder(dates, T, band, tries);
      break;
    }
    case 'probe': runProbe(seed, T, list, (args.rect || '6,20,40,28').split(',').map(Number), band, tries); break;
    case 'zoom': runZoom(seed, pal, args.out || 'review/r10-zoom.png', T, list,
      (args.rect || '150,20,50,26').split(',').map(Number), band, tries); break;
    case 'fabric': runFabric((args.seeds || '20260724,20260101,20260315').split(',').map(Number)); break;
    case 'compare': runCompare(seed, args.out || 'review/dyn-vivid-compare.png', T); break;
    default: throw new Error(`unknown --mode ${mode}`);
  }
}

main();
