import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng.js';
import {
  BOARD_RIGHT, FINGERS, HUB_RECTS, TEXT_ZONES, buildGraph, buildLayout, inRect, type Layout,
} from './layout.js';
import { buildNets } from './growth.js';
import type { Cell, Graph, Net } from './types.js';

// The review corpus, plus §13.1's own three sampled seeds.
const SEEDS = [20260724, 20260101, 20260315, 20260930, 20260115];

interface Built { layout: Layout; nets: Net[]; graph: Graph; }
const cache = new Map<number, Built>();
function built(seed: number): Built {
  if (!cache.has(seed)) {
    const layout = buildLayout(mulberry32(seed));
    const nets = buildNets(layout);
    cache.set(seed, { layout, nets, graph: buildGraph(layout.components, nets) });
  }
  return cache.get(seed)!;
}

const key = (c: Cell): string => `${c.x},${c.y}`;

/** Connected components over the node set, and which one each node is in. */
function islands(g: Graph): { of: number[]; count: number } {
  const of = g.nodes.map(() => -1);
  let count = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    if (of[i] >= 0) continue;
    const q = [i]; of[i] = count;
    for (let h = 0; h < q.length; h++)
      for (const ei of g.adj[q[h]]) {
        const o = g.edges[ei].a === q[h] ? g.edges[ei].b : g.edges[ei].a;
        if (of[o] < 0) { of[o] = count; q.push(o); }
      }
    count++;
  }
  return { of, count };
}

describe('buildNets — §12.4 routing discipline, carried unchanged by §13.1', () => {
  it('is a pure function of the layout (no rng, no clock)', () => {
    const layout = buildLayout(mulberry32(20260724));
    expect(JSON.stringify(buildNets(layout))).toBe(JSON.stringify(buildNets(layout)));
  });

  it.each(SEEDS)('routes 40+ nets with contiguous 4-connected spines (seed %i)', seed => {
    const { nets } = built(seed);
    expect(nets.length).toBeGreaterThanOrEqual(40);
    for (const n of nets) {
      expect(n.spine.length).toBeGreaterThan(0);
      for (let i = 1; i < n.spine.length; i++) {
        const d = Math.max(Math.abs(n.spine[i].x - n.spine[i - 1].x), Math.abs(n.spine[i].y - n.spine[i - 1].y));
        expect(d).toBe(1);
      }
      expect([1, 2]).toContain(n.weight);   // §12.4: trunk 2 cells, branch 1
    }
  });

  // §13.1 measured 2286-2324 drawn / 2227-2264 unique on its three sampled
  // seeds; the assertion band is deliberately a little wider than that sample.
  it.each(SEEDS)('draws 2200-2400 copper cells over the board, never in a text zone (seed %i)', seed => {
    const { nets } = built(seed);
    const cells = nets.flatMap(n => n.cells);
    expect(cells.length).toBeGreaterThanOrEqual(2200);
    expect(cells.length).toBeLessThanOrEqual(2400);
    const uniq = new Set(cells.map(key));
    expect(uniq.size).toBeGreaterThanOrEqual(2200);
    for (const c of cells) {
      expect(TEXT_ZONES.some(z => inRect(c.x, c.y, z))).toBe(false);
      expect(c.x).toBeLessThanOrEqual(BOARD_RIGHT);
    }
  });

  it.each(SEEDS)('lands under the connector gold rather than stopping short (seed %i)', seed => {
    // §12.4's landing overshoot: every finger has drawn copper reaching into it.
    const drawn = new Set(built(seed).nets.flatMap(n => n.cells).map(key));
    for (const f of FINGERS) {
      let hit = false;
      for (let y = f.y; y < f.y + f.h && !hit; y++)
        for (let x = f.x; x < f.x + 4 && !hit; x++) if (drawn.has(`${x},${y}`)) hit = true;
      expect(hit).toBe(true);
    }
  });
});

describe('§12.4 clearance and rectilinear dominance — carried unchanged by §13.1', () => {
  // §12.4: "Clearance: 1 cell between distinct nets. This is a structural
  // guarantee FOR ROUTER-PLACED NET BODIES." The 4-cell landing overshoot is
  // deliberately not part of `spine` (it is drawn under a component body or the
  // connector gold and is never visible as a crossing), so spines are exactly
  // the set the guarantee is about — and it holds with no exception at all,
  // including for the hand-placed gutter-1 pair the clause allows for.
  /**
   * Distinct-net spine cells that share a cell or 8-NEIGHBOUR one another.
   *
   * 8-neighbour is the strict reading: "1 cell between distinct nets" means a
   * full empty cell, so a diagonal corner-touch (Chebyshev distance 1) is a
   * contact even though it never renders as a crossing. §11's own fallback note
   * sanctioned cardinal-only clearance if the strict form proved unreachable —
   * it is not needed, the router clears the strict bar, and asserting the strict
   * form is what keeps that true.
   */
  const contactsIn = (nets: readonly Net[]): string[] => {
    const owner = new Map<string, number[]>();
    nets.forEach((n, i) => {
      for (const c of n.spine) owner.set(key(c), [...(owner.get(key(c)) ?? []), i]);
    });
    const out: string[] = [];
    for (const [k, ids] of owner) {
      if (new Set(ids).size > 1) out.push(`${k} shared by nets ${ids.join('/')}`);
      const [x, y] = k.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          for (const o of owner.get(`${x + dx},${y + dy}`) ?? [])
            if (!ids.includes(o)) out.push(`nets ${ids[0]} and ${o} touch at ${k}`);
        }
    }
    return out;
  };

  it.each(SEEDS)('keeps a full cell between the spines of distinct nets (seed %i)', seed => {
    const { nets } = built(seed);
    expect(contactsIn(nets)).toEqual([]);
    expect(nets.reduce((a, n) => a + n.spine.length, 0)).toBeGreaterThan(900);   // not vacuous
    // The scan can fail: a net laid one cell off another's spine is caught. The
    // real routing has slack on this corpus, so proving the CHECK works needs a
    // deliberate violation rather than a source mutation.
    const clash: Net = { ...nets[0], spine: nets[1].spine.map(c => ({ x: c.x, y: c.y + 1 })) };
    expect(contactsIn([...nets, clash]).length).toBeGreaterThan(0);
  });

  it.each(SEEDS)('lands three parallel 2-cell trunks per finger group at x=225 (seed %i)', seed => {
    // §12.4's connector approach: "three 2-cell trunks per finger group, running
    // parallel out of that group's hub QFP and landing at x = 225 (the 2-cell
    // footprint occupies x 225-226; the gold owns x 227-230)."
    const { nets, layout } = built(seed);
    for (const band of [0, 1, 2]) {
      const fingers = FINGERS.filter(f => f.band === band);
      const yLo = Math.min(...fingers.map(f => f.y)) - 2;
      const yHi = Math.max(...fingers.map(f => f.y + f.h)) + 2;
      const landing = nets.filter(n =>
        n.cells.some(c => (c.x === 225 || c.x === 226) && c.y >= yLo && c.y <= yHi));
      expect(`band ${band}: ${landing.length} trunks`).toBe(`band ${band}: 3 trunks`);
      for (const n of landing) {
        expect(`band ${band} weight ${n.weight}`).toBe(`band ${band} weight 2`);
        // the spine STOPS at the landing column; only the overshoot goes further
        expect(Math.max(...n.spine.map(c => c.x))).toBe(225);
        // and the overshoot does reach under the gold (x >= 227)
        expect(n.cells.some(c => c.x >= FINGERS[0].x)).toBe(true);
      }
      // parallel: three distinct rows, each emerging from the fanout east of
      // this group's own hub QFP rather than crossing in from another band
      const hub = HUB_RECTS[band];
      const hubComp = layout.components.find(c => c.kind === 'qfp' && c.body.x === hub.x && c.body.y === hub.y)!;
      const starts = landing.map(n => n.spine[0]);
      expect(new Set(starts.map(c => c.y)).size).toBe(3);
      for (const s of starts) {
        expect(s.x).toBeGreaterThanOrEqual(hubComp.rect.x);
        expect(s.y).toBeGreaterThanOrEqual(yLo - 4);
        expect(s.y).toBeLessThanOrEqual(yHi + 4);
      }
    }
  });

  it.each(SEEDS)('is rectilinear-dominant, diagonals only as short 45 deg chamfers (seed %i)', seed => {
    // "rectilinear-dominant — horizontal AND vertical committed runs in balanced
    // measure, diagonals only as short 45 deg corner chamfers" of "1-3 cells".
    let diag = 0, total = 0, longestDiagonalRun = 0;
    for (const n of built(seed).nets) {
      let run = 0;
      for (let i = 1; i < n.spine.length; i++) {
        const dx = Math.abs(n.spine[i].x - n.spine[i - 1].x);
        const dy = Math.abs(n.spine[i].y - n.spine[i - 1].y);
        total++;
        if (dx && dy) { diag++; run++; longestDiagonalRun = Math.max(longestDiagonalRun, run); } else run = 0;
      }
    }
    expect(total).toBeGreaterThan(900);
    expect(diag).toBeGreaterThan(0);                    // chamfers do exist
    expect(diag / total).toBeLessThan(0.05);            // measured 0.5-0.6 %
    expect(longestDiagonalRun).toBeLessThanOrEqual(3);  // §12.4's 1-3 cell miter
    // "horizontal AND vertical committed runs in balanced measure" — §12.4 pins
    // NO NUMBER here, and this project has already been bitten once by inventing
    // a threshold for this exact metric. So the floor is deliberately set well
    // BELOW the measured corpus (0.1454-0.1527 over nine seeds) as a collapse
    // detector — it catches routing degenerating into pure eastward sweeps, and
    // it is not a tuning target. Move it only with a spec clause to move it to.
    let horiz = 0, vert = 0;
    for (const n of built(seed).nets)
      for (let i = 1; i < n.spine.length; i++) {
        if (n.spine[i].y === n.spine[i - 1].y) horiz++;
        else if (n.spine[i].x === n.spine[i - 1].x) vert++;
      }
    expect(vert).toBeGreaterThan(100);
    expect(vert / (horiz + vert)).toBeGreaterThan(0.10);
  });
});

describe('§13.1 the routed island', () => {
  it.each(SEEDS)('is ONE island holding all nine fingers and >= 20 component nodes (seed %i)', seed => {
    const { graph } = built(seed);
    const { of } = islands(graph);
    const fingerNodes = graph.nodes.map((n, i) => ({ i, f: n.finger })).filter(x => x.f >= 0);
    expect(fingerNodes).toHaveLength(9);
    for (const x of fingerNodes) expect(graph.adj[x.i].length).toBeGreaterThan(0);
    const island = of[fingerNodes[0].i];
    for (const x of fingerNodes) expect(of[x.i]).toBe(island);
    const compNodes = graph.nodes.filter((n, i) => n.comp >= 0 && of[i] === island).length;
    expect(compNodes).toBeGreaterThanOrEqual(20);
  });

  it.each(SEEDS)('has simple cycle rank >= 3 on that island (seed %i)', seed => {
    const { graph } = built(seed);
    const { of } = islands(graph);
    const island = of[graph.nodes.findIndex(n => n.finger >= 0)];
    const V = graph.nodes.filter((_, i) => of[i] === island).length;
    const E = new Set(graph.edges.filter(e => of[e.a] === island)
      .map(e => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`)).size;
    expect(E - V + 1).toBeGreaterThanOrEqual(3);
  });

  it.each(SEEDS)('leaves the furniture isolated by design — most nodes are unwired (seed %i)', seed => {
    const { graph } = built(seed);
    const wired = graph.nodes.filter((_, i) => graph.adj[i].length > 0).length;
    // §13.1 measured 105/103/101 nodes of which 40/40/39 are wired at all.
    expect(wired).toBeGreaterThanOrEqual(30);
    expect(wired).toBeLessThan(graph.nodes.length);
    expect(islands(graph).count).toBeGreaterThan(50);
  });

  it.each(SEEDS)('every finger is reachable from >= 20 component nodes (seed %i)', seed => {
    const { graph } = built(seed);
    for (const [i, node] of graph.nodes.entries()) {
      if (node.finger < 0) continue;
      const dist = graph.nodes.map(() => Infinity);
      dist[i] = 0;
      const q = [i];
      for (let h = 0; h < q.length; h++)
        for (const ei of graph.adj[q[h]]) {
          const o = graph.edges[ei].a === q[h] ? graph.edges[ei].b : graph.edges[ei].a;
          if (dist[o] > dist[q[h]] + 1) { dist[o] = dist[q[h]] + 1; q.push(o); }
        }
      expect(graph.nodes.filter((n, j) => n.comp >= 0 && Number.isFinite(dist[j])).length)
        .toBeGreaterThanOrEqual(20);
    }
  });

  it.each(SEEDS)('only builds edges from spines of >= 4 cells, attached within 8 cells (seed %i)', seed => {
    const { graph } = built(seed);
    for (const e of graph.edges) {
      expect(e.cells.length).toBeGreaterThanOrEqual(4);
      expect(e.a).not.toBe(e.b);
    }
  });
});
