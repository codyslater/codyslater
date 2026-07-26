import type {
  BoardComponent, Cell, EscapeEvent, Flow, FlowStop, Graph, Takeover,
} from './types.js';
import {
  ACCENT_LIST, BOARD_RIGHT, FINGERS, orientEdge, segment, stubPath, transit,
} from './layout.js';
import { shuffled, type Rng } from './rng.js';

// ---------------------------------------------------------------------------
// signals.ts — §13.2's flows: couriers, streams, and the component takeover.
//
// One directed ecosystem, three flow kinds, all on ONE slot-exact schedule of
// `T * SLOTS_PER_FRAME` entries, so a courier's final cell and its stream's
// first cell occupy the *same* slot and the handoff is causal by construction.
// Every slot index is taken mod N, so a stream departing before frame 0 simply
// arrives after the wrap: circular, with no seam handling anywhere.
//
// The walk geometry (`segment` / `stubPath` / `transit`) is imported from
// layout.ts rather than restated, because that is the SAME function that decides
// where the gray fabric is drawn — which is what makes §13.1's on-copper
// invariant hold by construction instead of by patching.
// ---------------------------------------------------------------------------

/** §13.2: cells a flow advances per frame. */
export const SLOTS_PER_FRAME = 3;

/** §13.2: a stream must cross at least three components before reaching the
 * gold. This is the knob that turns "the colour arrives at a chip and stops"
 * into "the signal travels through the machine's organs to the interface". */
export const MIN_TRANSITS = 3;

/** §13.2's trail lengths, one per flow kind. */
export const TRAIL = { courier: 7, stream: 24, interior: 14 } as const;

/** §13.2: frames a component keeps a colour at full, then releases it over. */
export const HOLD = 14, FADE = 16;

/** §13.2: a finger flashes its stream's colour for this many frames on arrival. */
export const FINGER_FLASH = 10;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// Graph distances
// ---------------------------------------------------------------------------

const bfs = (g: Graph, sources: number[]): number[] => {
  const dist = g.nodes.map(() => Infinity);
  const q: number[] = [];
  for (const s of sources) { dist[s] = 0; q.push(s); }
  for (let head = 0; head < q.length; head++) {
    const n = q[head];
    for (const ei of g.adj[n]) {
      const o = g.edges[ei].a === n ? g.edges[ei].b : g.edges[ei].a;
      if (dist[o] <= dist[n] + 1) continue;
      dist[o] = dist[n] + 1;
      q.push(o);
    }
  }
  return dist;
};

/** Graph distance from every node to the nearest connector finger. */
export const distanceToConnector = (g: Graph): number[] =>
  bfs(g, g.nodes.map((n, i) => (n.finger >= 0 ? i : -1)).filter(i => i >= 0));

/** Graph distance from every node to one specific node (used to aim at one finger). */
export const distanceToNode = (g: Graph, target: number): number[] => bfs(g, [target]);

// ---------------------------------------------------------------------------
// Walks
// ---------------------------------------------------------------------------

/**
 * Append edge `ei` (oriented away from node `cur`) to `path`, crossing `cur`'s
 * own component on the way in — §13.1's through-path. This is the single place a
 * walk grows, so no caller can reintroduce a teleport.
 *
 * `pinAt` is the last cell before the flow leaves the copper and enters the
 * part: "flow arrives at a component's pin → the component takes the colour →
 * the flow continues out another pin".
 */
function pushHop(g: Graph, path: Cell[], cur: number, ei: number): { cells: Cell[]; pinAt: number } {
  const cells = orientEdge(g, ei, cur);
  if (!cells.length) return { cells, pinAt: Math.max(0, path.length - 1) };
  if (!path.length) path.push({ ...g.nodes[cur].center });
  const pinAt = path.length - 1;
  const link = transit(path[path.length - 1], g.nodes[cur].center, cells[0]);
  path.push(...link);
  path.push(...cells.slice(link.length ? 1 : 0));
  return { cells, pinAt };
}

/** Walk into a node and stop on it, so a journey ends on the part it reached. */
function pushInto(g: Graph, path: Cell[], node: number): number {
  if (!path.length) return 0;
  const pinAt = path.length - 1;
  path.push(...stubPath(path[path.length - 1], g.nodes[node].center));
  return pinAt;
}

interface Route { path: Cell[]; stops: FlowStop[]; }

/**
 * A CLOSED walk through the graph — §13.2's interior flow. The colour wanders the
 * maze, picking a different branch at each junction, and returns to where it
 * began so the whole thing is periodic. At every node of degree > 1 the walk
 * genuinely chooses (excluding the edge it arrived on where an alternative
 * exists), so it takes a different branch next time it passes through.
 */
export function buildRoute(rng: Rng, g: Graph, start: number, minLen: number): Route | null {
  const path: Cell[] = [];
  const stops: FlowStop[] = [];
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
  for (let head = 0; head < q.length; head++) {
    const n = q[head];
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
  // Close the cycle in space as well as in topology: the last cell has to be
  // adjacent to the first, or the wrap frame shows the comet snapping back.
  if (path.length > 1) path.push(...stubPath(path[path.length - 1], path[0]).slice(0, -1));
  return { path, stops };
}

interface Journey { cells: Cell[]; stops: FlowStop[]; finger: number; }

/**
 * An AIMED walk: it follows a distance field computed to one specific target
 * node. At each junction it prefers an edge that gets it closer, but takes a
 * detour a quarter of the time — so it reads as finding its way through the maze
 * rather than following a printed arrow, and two runs from the same source
 * differ. The last two hops commit, so a detour can always get home.
 */
export function buildJourneyTo(rng: Rng, g: Graph, start: number, target: number, dTo: number[]): Journey | null {
  if (!Number.isFinite(dTo[start])) return null;
  const cells: Cell[] = [];
  const stops: FlowStop[] = [];
  let cur = start, lastEdge = -1;
  for (let step = 0; step < 30; step++) {
    if (cur === target) {
      stops.push({ at: pushInto(g, cells, cur), node: cur });
      return { cells, stops, finger: g.nodes[cur].finger };
    }
    const opts = g.adj[cur].map(ei => ({ ei, o: g.edges[ei].a === cur ? g.edges[ei].b : g.edges[ei].a }))
      .filter(c => c.ei !== lastEdge && Number.isFinite(dTo[c.o]));
    if (!opts.length) break;
    const closer = opts.filter(c => dTo[c.o] < dTo[cur]);
    const pool = closer.length && (rng() < 0.75 || dTo[cur] <= 2) ? closer : opts;
    const picked = pool[Math.floor(rng() * pool.length)];
    const { pinAt } = pushHop(g, cells, cur, picked.ei);
    stops.push({ at: pinAt, node: cur });
    cur = picked.o;
    lastEdge = picked.ei;
  }
  return null;
}

/** The visible exit: through the gold finger and out into the void. */
export function exitCells(fingerIdx: number): Cell[] {
  const f = FINGERS[fingerIdx];
  const out: Cell[] = [];
  for (let x = f.x; x <= BOARD_RIGHT + 8; x++) out.push({ x, y: f.y + 1 });
  return out;
}

/**
 * §13.2's sources: "drawn from 40 nodes bucketed 3 × 3 across the board, so west
 * pads, mid ICs and far corners all fire."
 */
export function pickSources(rng: Rng, g: Graph, dToC: number[], n: number): number[] {
  const eligible = g.nodes
    .map((nd, i) => ({ i, nd }))
    .filter(({ i, nd }) => nd.comp >= 0 && g.adj[i].length > 0 && dToC[i] >= 2 && dToC[i] < Infinity);
  const bucket = (nd: Graph['nodes'][number]): number =>
    Math.min(2, Math.floor(nd.center.x / 78)) * 3 + Math.min(2, Math.floor(nd.center.y / 22));
  const byBucket = new Map<number, number[]>();
  for (const e of eligible) {
    const b = bucket(e.nd);
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

/** Write `cells` into `slots` so that the block ENDS on `endSlot`; returns the
 * slot it starts on. Everything is mod N, which is what makes the schedule
 * circular by construction. */
function placeBlock(slots: (Cell | null)[], cells: Cell[], endSlot: number): number {
  const start = mod(endSlot - cells.length, slots.length);
  for (let i = 0; i < cells.length; i++) slots[mod(start + i, slots.length)] = cells[i];
  return start;
}

const joinTo = (from: Cell, to: Cell): Cell[] =>
  segment(from, to, Math.abs(to.x - from.x) >= Math.abs(to.y - from.y));

/**
 * §13.2's blend. Small fast COURIERS launch from sources all over the board and
 * run aimed journeys into a stream's launch point; a long flowing STREAM departs
 * that point on the exact slot the courier arrives, carrying the colour through
 * the routing to a gold finger, where it ESCAPES the board; the escape feeds the
 * void (§13.3). Two INTERIOR wanderers never leave the board — pure interaction.
 *
 * Escapes are scheduled escape-FIRST — the arrival frame is what the void cares
 * about — and departure is back-computed. One stream per finger, staggered
 * around the loop (`escapeFrame ≈ ((m + 0.5 ± 0.25)/9)·T`), so the whole gold
 * interface takes turns and consecutive escapes are not a top-to-bottom sweep.
 */
export function buildFlows(rng: Rng, g: Graph, dToC: number[], T: number): {
  flows: Flow[]; events: EscapeEvent[];
} {
  const N = T * SLOTS_PER_FRAME;
  const flows: Flow[] = [];
  const events: EscapeEvent[] = [];

  const sources = pickSources(rng, g, dToC, 40);
  let si = 0;
  const nextSource = (): number => sources[(si++) % sources.length];

  const fingerNodes = g.nodes
    .map((n, i) => ({ i, f: n.finger })).filter(x => x.f >= 0)
    .sort((a, b) => a.f - b.f);
  // §13.5's new seeded variation: the order in which the nine fingers escape,
  // which is what assigns each finger's stream (and its feeding courier) an
  // accent out of the fixed five.
  const order = shuffled(rng, fingerNodes);

  order.forEach((fn, m) => {
    const escFrame = mod(Math.round(((m + 0.5 + (rng() - 0.5) * 0.5) / order.length) * T), T);
    const dTo = distanceToNode(g, fn.i);

    // Streams launch from the DEEPEST reachable nodes, not from a trunk hub 2-6
    // hops out: a hub-launched stream transited one part and was done. Launching
    // from the far side means the signal has to cross the machine's organs to get
    // out — source -> IC -> IC -> trunk -> finger, every hop visibly lighting.
    const far = g.nodes
      .map((n, i) => ({ i, d: dTo[i] }))
      .filter(c => g.nodes[c.i].comp >= 0 && Number.isFinite(c.d) && c.d >= MIN_TRANSITS)
      .sort((a, b) => b.d - a.d);
    // Fallback (never taken on the corpus): if nothing sits MIN_TRANSITS hops
    // out, launch from whatever component can reach this finger at all rather
    // than leaving the finger unfed.
    const reach = far.length ? far : g.nodes
      .map((n, i) => ({ i, d: dTo[i] }))
      .filter(c => g.nodes[c.i].comp >= 0 && Number.isFinite(c.d) && c.d >= 1)
      .sort((a, b) => b.d - a.d);
    if (!reach.length) return;
    const deep = reach.slice(0, Math.max(3, Math.ceil(reach.length * 0.5)));

    let journey: Journey | null = null;
    let start = deep[0].i;
    for (let k = 0; k < 24 && !journey; k++) {
      start = deep[(m * 5 + k * 3 + 1) % deep.length].i;
      const j = buildJourneyTo(rng, g, start, fn.i, dTo);
      // insist on a real chain of parts, not a hop next door
      if (j && j.stops.filter(st => g.nodes[st.node].comp >= 0).length >= MIN_TRANSITS) journey = j;
    }
    if (!journey) for (let k = 0; k < 12 && !journey; k++) journey = buildJourneyTo(rng, g, start, fn.i, dTo);
    if (!journey || !journey.cells.length) return;

    const courierColor = ACCENT_LIST[m % ACCENT_LIST.length];
    const streamColor = ACCENT_LIST[(m + 2) % ACCENT_LIST.length];

    // --- the stream: deep source -> this finger -> out of the board ---------
    const exit = exitCells(fn.f);
    const tail = journey.cells[journey.cells.length - 1];
    const streamCells = [...journey.cells, ...joinTo(tail, exit[0]).slice(0, -1), ...exit];
    const sSlots: (Cell | null)[] = new Array(N).fill(null);
    const arriveSlot = escFrame * SLOTS_PER_FRAME;
    const sStart = placeBlock(sSlots, streamCells, mod(arriveSlot - journey.cells.length, N) + streamCells.length);
    flows.push({
      kind: 'stream', slots: sSlots, trail: TRAIL.stream, color: streamColor,
      stops: journey.stops.map(st => ({ at: mod(sStart + st.at, N), node: st.node })),
      thread: { from: sStart, to: sStart + 12, color: courierColor },
    });
    events.push({
      frame: mod(Math.round((sStart + journey.cells.length) / SLOTS_PER_FRAME), T),
      finger: fn.f, color: streamColor,
    });

    // --- the courier that feeds it -----------------------------------------
    // An AIMED walk into the launch point, using the same machinery as the
    // streams, so it transits and lights every part it crosses. (A random wander
    // hoping to pass through the launch point had a fallback that carried no
    // stops, so those couriers slid straight across components that stayed dark.)
    const dToStart = distanceToNode(g, start);
    let feed: Journey | null = null;
    for (let k = 0; k < 14 && !feed; k++) {
      const src = nextSource();
      if (src === start || !Number.isFinite(dToStart[src])) continue;
      feed = buildJourneyTo(rng, g, src, start, dToStart);
    }
    if (!feed) {
      const near = g.nodes
        .map((n, i) => ({ i, d: dToStart[i] }))
        .filter(c => g.nodes[c.i].comp >= 0 && c.i !== start && Number.isFinite(c.d) && c.d >= 1)
        .sort((x, y) => x.d - y.d)[0];
      if (near) for (let k = 0; k < 8 && !feed; k++) feed = buildJourneyTo(rng, g, near.i, start, dToStart);
    }
    if (!feed || !feed.cells.length) return;
    // Land the courier exactly where the stream begins, so the handoff is one
    // continuous motion rather than two flows that happen to be near each other.
    feed.cells.push(...joinTo(feed.cells[feed.cells.length - 1], streamCells[0]));
    const cSlots: (Cell | null)[] = new Array(N).fill(null);
    const cStart = placeBlock(cSlots, feed.cells, sStart);
    flows.push({
      kind: 'courier', slots: cSlots, trail: TRAIL.courier, color: courierColor,
      stops: feed.stops.map(st => ({ at: mod(cStart + st.at, N), node: st.node })),
    });
  });

  // A couple of interior wanderers: pure interaction, never leaves the board.
  for (let i = 0; i < 2; i++) {
    const r = buildRoute(rng, g, nextSource(), 150);
    if (!r) continue;
    const slots: (Cell | null)[] = new Array(N).fill(null);
    for (let k = 0; k < N; k++) slots[k] = r.path[Math.floor((k / N) * r.path.length)];
    flows.push({
      kind: 'interior', slots, trail: TRAIL.interior, color: ACCENT_LIST[(i + 3) % ACCENT_LIST.length],
      stops: r.stops.map(st => ({ at: Math.round((st.at / r.path.length) * N), node: st.node })),
    });
  }
  return { flows, events };
}

/**
 * §13.2's takeovers, DERIVED FROM THE DRAWN GEOMETRY rather than from the walk's
 * stop list: the lit interval is exactly the run of slots where the flow's own
 * cells lie inside the component's rect, extended by the trail so the part stays
 * lit until the last trail cell has left.
 *
 * Per COMPONENT, not per slot: footprints overlap (a fan seated on a heatsink, a
 * QFP's pin ring reaching under its neighbour), and taking only the first match
 * left the other part dark while a signal crossed it.
 */
export function collectTakeovers(
  flows: Flow[], graph: Graph, components: BoardComponent[], T: number,
): Map<number, Takeover[]> {
  const N = T * SLOTS_PER_FRAME;
  const comps = graph.nodes
    .map((n, i) => ({ i, r: n.comp >= 0 ? components[n.comp].rect : null }))
    .filter((c): c is { i: number; r: NonNullable<typeof c.r> } => !!c.r);
  const hits = new Map<number, Takeover[]>();
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

/** The colour currently owning a node, and how strongly (0..1): HOLD frames at
 * full, then FADE frames back to base. The most recent arrival wins. */
export function washAt(hits: Takeover[] | undefined, t: number, T: number): { color: string; k: number } | null {
  if (!hits) return null;
  let best: { color: string; k: number; age: number } | null = null;
  for (const h of hits) {
    const age = mod(t - h.frame, T);
    if (age > h.hold + FADE) continue;
    const k = age <= h.hold ? 1 : 1 - (age - h.hold) / FADE;
    if (!best || age < best.age) best = { color: h.color, k, age };
  }
  return best ? { color: best.color, k: best.k } : null;
}

/** The distinct colours holding a node at full right now, in arrival order. */
export function contestedColors(hits: Takeover[] | undefined, t: number, T: number): string[] {
  if (!hits) return [];
  const active = hits.filter(h => mod(t - h.frame, T) <= h.hold);
  return [...new Set(active.map(h => h.color))];
}

/**
 * §13.2's contested rule: "the MOST RECENT arrival owns the body wash, and the
 * SECOND COLOUR is drawn as a one-cell border ring around the component's
 * outline ... so a contested part reads as one colour holding the chip with
 * another pressing at its edge".
 *
 * The ring colour is therefore defined against the owner, not by insertion
 * order. Taking `contestedColors()[1]` — as the calibration prototype did —
 * paints the owner's own colour roughly half the time (whenever the most recent
 * arrival happens to be second in the list), which makes the ring invisible and
 * defeats the feature. Returns null when nothing is pressing.
 */
export function contestedRingColor(hits: Takeover[] | undefined, t: number, T: number): string | null {
  const owner = washAt(hits, t, T);
  if (!owner) return null;
  return contestedColors(hits, t, T).find(c => c !== owner.color) ?? null;
}

/**
 * The cells one flow occupies at one frame: the same slots over the same trail
 * window that `render.drawFlows` paints from, so the continuity checks measure
 * exactly the comet a viewer sees. (`drawFlows` additionally decides each cell's
 * COLOUR — the ramp and the woven courier thread — which is not this function's
 * concern.)
 */
export function flowDrawn(f: Flow, t: number, T: number): Cell[] {
  const N = T * SLOTS_PER_FRAME;
  const head = Math.round(t * SLOTS_PER_FRAME);
  const out: Cell[] = [];
  for (let d = f.trail - 1; d >= 0; d--) {
    const p = f.slots[mod(head - d, N)];
    if (p) out.push(p);
  }
  return out;
}
