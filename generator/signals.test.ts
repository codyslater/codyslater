import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng.js';
import { ACCENT_LIST, BOARD_RIGHT, FINGERS, buildGraph, buildLayout } from './layout.js';
import { buildNets } from './growth.js';
import {
  FADE, HOLD, MIN_TRANSITS, SLOTS_PER_FRAME, TRAIL,
  buildFlows, buildRoute, collectTakeovers, contestedColors, contestedRingColor, distanceToConnector,
  exitCells, flowDrawn, pickSources, washAt,
} from './signals.js';
import type { Cell, EscapeEvent, Flow, Graph } from './types.js';
import type { BoardComponent } from './types.js';

const T = 288;
const SEEDS = [20260724, 20260101, 20260315];

interface Built { graph: Graph; components: BoardComponent[]; flows: Flow[]; events: EscapeEvent[]; }
const cache = new Map<number, Built>();
function built(seed: number): Built {
  if (!cache.has(seed)) {
    const layout = buildLayout(mulberry32(seed));
    const graph = buildGraph(layout.components, buildNets(layout));
    const { flows, events } = buildFlows(mulberry32(seed ^ 0x5eed), graph, distanceToConnector(graph), T);
    cache.set(seed, { graph, components: layout.components, flows, events });
  }
  return cache.get(seed)!;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

describe('§13.2 the blend', () => {
  it('is deterministic for a given seed', () => {
    const layout = buildLayout(mulberry32(20260724));
    const graph = buildGraph(layout.components, buildNets(layout));
    const a = buildFlows(mulberry32(20260724 ^ 0x5eed), graph, distanceToConnector(graph), T);
    const b = buildFlows(mulberry32(20260724 ^ 0x5eed), graph, distanceToConnector(graph), T);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each(SEEDS)('builds 9 couriers, 9 streams and 2 interiors at their pinned trails (seed %i)', seed => {
    const { flows } = built(seed);
    expect(flows.filter(f => f.kind === 'courier')).toHaveLength(9);
    expect(flows.filter(f => f.kind === 'stream')).toHaveLength(9);
    expect(flows.filter(f => f.kind === 'interior')).toHaveLength(2);
    for (const f of flows) expect(f.trail).toBe(TRAIL[f.kind]);
  });

  it.each(SEEDS)('gives every flow exactly T*3 slots (seed %i)', seed => {
    for (const f of built(seed).flows) expect(f.slots).toHaveLength(T * SLOTS_PER_FRAME);
    expect(SLOTS_PER_FRAME).toBe(3);
  });

  it.each(SEEDS)('escapes once per finger — 9/9 used, staggered around the loop (seed %i)', seed => {
    const { events } = built(seed);
    expect(events).toHaveLength(9);
    expect(new Set(events.map(e => e.finger)).size).toBe(9);
    // "escapeFrame ~ ((m + 0.5 +- 0.25)/9)*T" — sorted arrivals are spread, never a sweep
    const frames = events.map(e => e.frame).sort((a, b) => a - b);
    for (let i = 1; i < frames.length; i++) expect(frames[i] - frames[i - 1]).toBeGreaterThan(2);
  });

  it.each(SEEDS)('every stream crosses at least MIN_TRANSITS components before the gold (seed %i)', seed => {
    const { graph, flows } = built(seed);
    const transits = flows.filter(f => f.kind === 'stream')
      .map(f => f.stops.filter(st => graph.nodes[st.node].comp >= 0).length);
    expect(transits).toHaveLength(9);
    for (const n of transits) expect(n).toBeGreaterThanOrEqual(MIN_TRANSITS);
    expect(transits.reduce((a, b) => a + b, 0) / transits.length).toBeGreaterThanOrEqual(4);
  });

  it.each(SEEDS)('hands off courier -> stream on consecutive slots at the same cell (seed %i)', seed => {
    const { flows } = built(seed);
    const streams = flows.filter(f => f.kind === 'stream');
    const couriers = flows.filter(f => f.kind === 'courier');
    const N = T * SLOTS_PER_FRAME;
    couriers.forEach((c, i) => {
      const s = streams[i];
      // the stream's departure slot is where its `thread` window opens
      const dep = s.thread!.from;
      expect(c.slots[mod(dep - 1, N)]).not.toBeNull();
      expect(c.slots[mod(dep - 1, N)]).toEqual(s.slots[dep]);
    });
  });

  it.each(SEEDS)('weaves the courier colour into the first 12 slots of its stream tail (seed %i)', seed => {
    const { flows } = built(seed);
    const streams = flows.filter(f => f.kind === 'stream');
    const couriers = flows.filter(f => f.kind === 'courier');
    streams.forEach((s, i) => {
      expect(s.thread).toBeDefined();
      expect(s.thread!.to - s.thread!.from).toBe(12);
      expect(s.thread!.color).toBe(couriers[i].color);
      expect(ACCENT_LIST).toContain(s.color);
    });
  });

  it.each(SEEDS)('exits through the gold and off the board — the escape (seed %i)', seed => {
    const { flows } = built(seed);
    for (const f of flows.filter(x => x.kind === 'stream')) {
      const cells = f.slots.filter((c): c is NonNullable<typeof c> => !!c);
      expect(cells.some(c => c.x > BOARD_RIGHT)).toBe(true);
      expect(Math.max(...cells.map(c => c.x))).toBe(BOARD_RIGHT + 8);
    }
    for (const f of flows.filter(x => x.kind === 'interior'))
      expect(f.slots.every(c => !c || c.x <= BOARD_RIGHT)).toBe(true);
  });

  it('exitCells runs from the finger straight out past the board edge', () => {
    const cells = exitCells(4);
    expect(cells[0]).toEqual({ x: FINGERS[4].x, y: FINGERS[4].y + 1 });
    expect(cells[cells.length - 1].x).toBe(BOARD_RIGHT + 8);
    expect(new Set(cells.map(c => c.y)).size).toBe(1);
  });

  it.each(SEEDS)('interiors are closed walks: every slot filled, adjacent across the wrap (seed %i)', seed => {
    const N = T * SLOTS_PER_FRAME;
    for (const f of built(seed).flows.filter(x => x.kind === 'interior')) {
      expect(f.slots.every(c => c !== null)).toBe(true);
      const a = f.slots[N - 1]!, b = f.slots[0]!;
      expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeLessThanOrEqual(1);
    }
  });
});

describe('§13.2 the journey model', () => {
  /** A line 0-1-2 with a spur 1-3: node 1 has degree 3, so a walk arriving from
   * 0 has two genuine alternatives and must take one of them. */
  const chain = (): Graph => {
    const nodes = [0, 1, 2, 3].map((i): Graph['nodes'][number] =>
      ({ center: { x: 20 + i * 10, y: 30 }, comp: i, finger: -1 }));
    const seg = (a: Cell, b: Cell): Cell[] => {
      const out: Cell[] = [];
      for (let x = a.x; x <= b.x; x++) out.push({ x, y: a.y });
      return out;
    };
    const edges = [
      { a: 0, b: 1, cells: seg({ x: 20, y: 30 }, { x: 30, y: 30 }) },
      { a: 1, b: 2, cells: seg({ x: 30, y: 30 }, { x: 40, y: 30 }) },
      { a: 1, b: 3, cells: seg({ x: 30, y: 31 }, { x: 50, y: 31 }) },
    ];
    const adj: number[][] = nodes.map(() => []);
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
    return { nodes, edges, adj };
  };

  it('never leaves a junction by the edge it arrived on while an alternative exists', () => {
    // §13.2: "At every node of degree > 1 the walk GENUINELY CHOOSES an exit —
    // excluding the edge it arrived on where an alternative exists — so it takes
    // a different branch next time it passes through."
    const g = chain();
    let junctions = 0;
    for (let s = 0; s < 40; s++) {
      const r = buildRoute(mulberry32(s), g, 0, 30);
      if (!r) continue;
      for (let i = 1; i < r.stops.length; i++) {
        const from = r.stops[i - 1].node, at = r.stops[i].node;
        if (g.adj[at].length <= 1) continue;   // a dead end has no alternative
        junctions++;
        // an immediate return to the node it just came from is the failure
        if (i + 1 < r.stops.length) expect(r.stops[i + 1].node).not.toBe(from);
      }
    }
    expect(junctions).toBeGreaterThan(20);   // not vacuous
  });

  it.each(SEEDS)('takes a different branch on a second pass through a junction (seed %i)', seed => {
    // The property that matters on the real board: a node crossed twice by the
    // same walk is not crossed the same way twice. Measured over every flow.
    const { graph, flows } = built(seed);
    let revisited = 0, sameExit = 0;
    for (const f of flows) {
      const byNode = new Map<number, number[]>();
      f.stops.forEach((st, i) => {
        if (i + 1 >= f.stops.length) return;
        byNode.set(st.node, [...(byNode.get(st.node) ?? []), f.stops[i + 1].node]);
      });
      for (const [node, exits] of byNode) {
        if (exits.length < 2 || graph.adj[node].length < 2) continue;
        revisited++;
        if (new Set(exits).size === 1) sameExit++;
      }
    }
    // Junctions crossed twice exist, and most of them are left differently — the
    // walk is choosing, not following a printed arrow.
    expect(revisited).toBeGreaterThan(0);
    expect(sameExit).toBeLessThan(revisited);
  });

  it.each(SEEDS)('draws stream sources from §13.2\'s 3x3 buckets across the whole board (seed %i)', seed => {
    // "Sources are drawn from 40 nodes bucketed 3 x 3 across the board, so west
    // pads, mid ICs and far corners all fire."
    const { graph } = built(seed);
    const src = pickSources(mulberry32(seed ^ 0x5eed), graph, distanceToConnector(graph), 40);
    expect(src.length).toBeGreaterThanOrEqual(20);
    // §13.2 asks for spread, not distinctness — the round-robin may hand the
    // same node back twice and two couriers may share a source, which is legal.
    expect(new Set(src).size).toBeGreaterThanOrEqual(15);
    const bucket = (i: number): number => {
      const c = graph.nodes[i].center;
      return Math.min(2, Math.floor(c.x / 78)) * 3 + Math.min(2, Math.floor(c.y / 22));
    };
    const buckets = new Set(src.map(bucket));
    expect(buckets.size).toBeGreaterThanOrEqual(5);      // west, mid and far all fire
    // and the west of the board is genuinely represented, not just the hubs
    expect(src.some(i => graph.nodes[i].center.x < 78)).toBe(true);
  });
});

describe('§13.2 the component takeover', () => {
  it.each(SEEDS)('derives intervals from drawn geometry, not from the stop list (seed %i)', seed => {
    const { graph, components, flows } = built(seed);
    const takeovers = collectTakeovers(flows, graph, components, T);
    expect(takeovers.size).toBeGreaterThanOrEqual(20);
    // Every takeover must correspond to a run of slots actually inside that rect,
    // so a flow can never be inside a dark part (continuity check D).
    for (const [node, hits] of takeovers) {
      const r = components[graph.nodes[node].comp].rect;
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.hold).toBeGreaterThan(0);
      const anyInside = flows.some(f => f.slots.some(p =>
        !!p && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h));
      expect(anyInside).toBe(true);
    }
  });

  it('holds at full for HOLD frames, then releases over FADE', () => {
    const hits = [{ frame: 100, hold: HOLD, color: '#39ff14' }];
    expect(washAt(hits, 100, T)!.k).toBe(1);
    expect(washAt(hits, 100 + HOLD, T)!.k).toBe(1);
    expect(washAt(hits, 100 + HOLD + FADE / 2, T)!.k).toBeCloseTo(0.5, 5);
    expect(washAt(hits, 100 + HOLD + FADE + 1, T)).toBeNull();
    // periodic: the same answer one loop later
    expect(washAt(hits, 100 + T, T)!.k).toBe(1);
  });

  it('lets the MOST RECENT arrival own the body, and reports the second as contested', () => {
    const hits = [
      { frame: 100, hold: HOLD, color: '#39ff14' },
      { frame: 104, hold: HOLD, color: '#ff2d78' },
    ];
    expect(washAt(hits, 106, T)!.color).toBe('#ff2d78');
    expect(contestedColors(hits, 106, T)).toHaveLength(2);
    expect(contestedColors(hits, 100, T)).toHaveLength(1);
  });

  it('rings a contested part in a colour the OWNER is not wearing, whichever arrived first', () => {
    // The owner is the most recent arrival, so the ring cannot be chosen by
    // insertion order: in one of these two orderings `contestedColors()[1]` IS
    // the owner, and painting it would make the ring invisible.
    const later = [
      { frame: 100, hold: HOLD, color: '#39ff14' },
      { frame: 104, hold: HOLD, color: '#ff2d78' },
    ];
    const earlier = [
      { frame: 104, hold: HOLD, color: '#ff2d78' },
      { frame: 100, hold: HOLD, color: '#39ff14' },
    ];
    for (const hits of [later, earlier]) {
      const owner = washAt(hits, 106, T)!.color;
      expect(owner).toBe('#ff2d78');
      const ring = contestedRingColor(hits, 106, T);
      expect(ring).toBe('#39ff14');
      expect(ring).not.toBe(owner);
    }
    // the trap the prototype fell into: in `later` the owner IS cols[1], so
    // painting cols[1] would have rung the part in its own wash colour
    expect(contestedColors(later, 106, T)[1]).toBe(washAt(later, 106, T)!.color);
    expect(contestedRingColor(later, 106, T)).not.toBe(contestedColors(later, 106, T)[1]);
    expect(contestedRingColor(later, 100, T)).toBeNull();   // nothing pressing yet
    expect(contestedRingColor(undefined, 0, T)).toBeNull();
  });
});

describe('flowDrawn', () => {
  it.each(SEEDS)('never draws more cells than the trail, and is loop-periodic (seed %i)', seed => {
    for (const f of built(seed).flows) {
      for (const t of [0, 37, 144, 287]) expect(flowDrawn(f, t, T).length).toBeLessThanOrEqual(f.trail);
      expect(flowDrawn(f, 0, T)).toEqual(flowDrawn(f, T, T));
    }
  });
});
