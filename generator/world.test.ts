import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkContinuity, formatContinuity } from './continuity.js';
import {
  BAND, POP_BAND, RUNGS, VOID_FILL_PEAK_MAX, VOID_X0, VOID_X1, VOID_Y0, rungBand,
} from './creatures.js';
import {
  ISLAND_MIN_COMPONENTS, ISLAND_MIN_CYCLE_RANK, THESIS_ZONE,
  buildGraph, buildLayout, islandShape, HEIGHT, WIDTH,
} from './layout.js';
import { buildNets } from './growth.js';
import { MIN_TRANSITS, buildFlows, distanceToConnector } from './signals.js';
import { mulberry32 } from './rng.js';
import { createRenderer } from './render.js';
import {
  BONDED_MEAN_MIN, DEFAULT_FPS, DEFAULT_OUT, DEFAULT_SECONDS, DEFAULT_T, MIN_FLOWS_IN_FLIGHT,
  MIN_LIT_COMPONENTS, MOVING_BOARD_PEAK_MAX, MOVING_CANVAS_PEAK_MAX, VOID_FILL_MEAN_RANGE,
  buildWorld, checkInvariants, gateWorld, measureMovingCells, measureTraffic, transitsPerStream,
} from './timeline.js';
import type { Cell, Flow, Particle, World } from './types.js';

const T = DEFAULT_T;

/** The review corpus (§13.4's own eight) plus the two the brief adds. */
export const CORPUS = [
  20260724, 20260101, 20260315, 20261111, 20260602, 20260930, 20270101, 20260218, 20260115,
];

const cache = new Map<number, { world: World; ms: number }>();
function build(seed: number): { world: World; ms: number } {
  if (!cache.has(seed)) {
    const t0 = Date.now();
    const world = buildWorld(seed, T);
    cache.set(seed, { world, ms: Date.now() - t0 });
  }
  return cache.get(seed)!;
}

/** A stable digest of everything the renderer reads — determinism, cheaply. */
function digest(w: World): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({
    seed: w.seed, T: w.T, accents: w.accents, arc: w.arc,
    components: w.components, sections: w.sections, dressing: w.dressing,
    nets: w.nets, fabric: w.fabric,
    graph: { nodes: w.graph.nodes, edges: w.graph.edges },
    flows: w.flows, events: w.events,
    takeovers: [...w.takeovers.entries()],
    soup: {
      candidate: w.soup.candidate, subSeed: w.soup.subSeed, rung: w.soup.rung,
      peak: w.soup.peak, peakAt: w.soup.peakAt, formedFrames: w.soup.formedFrames,
      meanPop: w.soup.meanPop, tailEmptyFrom: w.soup.tailEmptyFrom,
    },
  }));
  // the soup itself, sampled across the whole arc
  for (let age = 0; age < w.arc; age += 37) h.update(JSON.stringify(w.soup.frames[age]));
  return h.digest('hex');
}

describe('§13.4 the default configuration', () => {
  it('is T = 288 frames = 24 s at 12 fps, 4 overlapping generations', () => {
    expect(DEFAULT_T).toBe(288);
    expect(DEFAULT_T / 12).toBe(24);
    const w = build(20260724).world;
    expect(w.arc).toBe(4 * T);
  });
});

describe('§5 determinism and the amended CLI', () => {
  // "All randomness flows from `mulberry32(seed)` — no `Date.now`, no
  // `Math.random` anywhere in simulation or render." That is a property of the
  // SOURCE, and the only way to assert it is to read the source: a single
  // `Math.random()` in a rarely-taken branch would pass every corpus test and
  // still break byte-identical daily regeneration.
  const SIM_AND_RENDER = [
    'continuity.ts', 'creatures.ts', 'fonts.ts', 'gif.ts', 'growth.ts', 'layout.ts',
    'render.ts', 'rng.ts', 'signals.ts', 'sprites.ts', 'timeline.ts', 'types.ts',
  ];

  /** The scan, factored out so the SCANNER itself can be shown to work. */
  const scan = (src: string, label: string): string[] => {
    const out: string[] = [];
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      // `new Date(Date.UTC(...))` in `revFromSeed` parses the SEED, never the
      // clock, so only the no-argument form and the explicit clock reads count.
      if (/Math\.random|Date\.now|performance\.now|new Date\(\s*\)/.test(code))
        out.push(`${label}:${i + 1}: ${line.trim()}`);
    });
    return out;
  };

  it('no Math.random, no clock read, anywhere in simulation or render', () => {
    const offenders = SIM_AND_RENDER.flatMap(mod =>
      scan(readFileSync(new URL(mod, import.meta.url), 'utf8'), mod));
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous: it catches each forbidden form, and spares the seed-parsing one', () => {
    // Without this, "0 offenders" could mean "the regex matches nothing".
    for (const bad of [
      'const r = Math.random();',
      'const t0 = Date.now();',
      'const t = performance.now();',
      'const now = new Date();',
      'const now = new Date( );',
    ]) expect(scan(bad, 'fixture')).toHaveLength(1);
    // and the two forms the codebase legitimately uses are NOT flagged
    expect(scan('const dt = new Date(Date.UTC(y, m - 1, d));', 'fixture')).toEqual([]);
    expect(scan('// Math.random is banned here', 'fixture')).toEqual([]);
    expect(scan('const rng = mulberry32(seed);', 'fixture')).toEqual([]);
  });

  it('the only clock read in generator/ is main.ts\'s progress log, which output cannot see', () => {
    // main.ts is CLI plumbing, not simulation or render: its `Date.now` times the
    // build for a console line and never reaches a pixel. Pinned so a future
    // clock read there has to be a deliberate edit to this list.
    const src = readFileSync(new URL('main.ts', import.meta.url), 'utf8');
    const clock = src.split('\n').filter(l => /Date\.now|Math\.random/.test(l));
    expect(clock.every(l => l.includes('Date.now'))).toBe(true);
    expect(clock).toHaveLength(2);   // t0, and the elapsed-time log line
  });

  it('§13.5 supersedes §5\'s 15 fps / 30 s: the CLI defaults are 12 fps x 24 s -> DEFAULT_T', () => {
    expect(DEFAULT_FPS).toBe(12);
    expect(DEFAULT_SECONDS).toBe(24);
    expect(DEFAULT_FPS * DEFAULT_SECONDS).toBe(DEFAULT_T);
    expect(DEFAULT_T).toBe(288);
    expect(DEFAULT_OUT).toBe('banner.gif');
    // and main.ts consumes them rather than carrying its own literals, so the
    // loop the suite gates and the loop the daily workflow renders are one loop
    const src = readFileSync(new URL('main.ts', import.meta.url), 'utf8');
    for (const name of ['DEFAULT_FPS', 'DEFAULT_SECONDS', 'DEFAULT_OUT']) expect(src).toContain(name);
    const literalDefault = /arg\('(fps|seconds|out)',\s*'/;
    expect(src).not.toMatch(literalDefault);
    // and the guard is not vacuous: it is exactly the reverted form it must catch
    expect("const out = arg('out', 'banner.gif')!;").toMatch(literalDefault);
    expect("const fps = Number(arg('fps', '15'));").toMatch(literalDefault);
    expect("const fps = Number(arg('fps', String(DEFAULT_FPS)));").not.toMatch(literalDefault);
  });
});

describe('§9.1 determinism', () => {
  it('same seed => identical world', () => {
    expect(digest(buildWorld(20260724, T))).toBe(digest(build(20260724).world));
  });

  it('same seed => identical pixels; a different seed => a different board', () => {
    const a = createRenderer(build(20260724).world);
    const b = createRenderer(buildWorld(20260724, T));
    const c = createRenderer(build(20260101).world);
    const px = (r: (t: number) => ReturnType<typeof a>, t: number): string =>
      createHash('sha256')
        .update(Buffer.from(r(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data))
        .digest('hex');
    for (const t of [0, 111]) expect(px(a, t)).toBe(px(b, t));
    expect(px(a, 111)).not.toBe(px(c, 111));
  });
});

describe('§13.5 the frame sweep', () => {
  it.each(CORPUS)('checkInvariants is clean for seed %i', seed => {
    expect(checkInvariants(build(seed).world)).toEqual([]);
  });

  it.each(CORPUS)('the five continuity checks report zero defects for seed %i', seed => {
    const r = checkContinuity(build(seed).world);
    expect(`${seed}: ${formatContinuity(r)}`).toContain('=> 0 defects');
  });

  it.each(CORPUS)('the traffic floor holds with margin for seed %i', seed => {
    const w = build(seed).world;
    const m = measureTraffic(w);
    expect(m.minFlows).toBeGreaterThanOrEqual(MIN_FLOWS_IN_FLIGHT);
    expect(m.minLit).toBeGreaterThanOrEqual(MIN_LIT_COMPONENTS);
    expect(m.minPop).toBeGreaterThanOrEqual(POP_BAND[0]);
    expect(m.maxPop).toBeLessThanOrEqual(POP_BAND[1]);
    // The searched statistic and the gated statistic are ONE function now, so
    // the number the ladder qualified on is exactly the number reported here.
    expect([m.minPop, m.maxPop, m.meanPop]).toEqual([w.soup.minPop, w.soup.maxPop, w.soup.meanPop]);
    // §13.5's fill band and §13.3's composition floor and whole-width read. All
    // three are searched by the ladder AND gated by checkInvariants; the corpus
    // is rung 0 throughout, so the strict bounds are the ones that apply here.
    expect(m.meanFill).toBeGreaterThanOrEqual(VOID_FILL_MEAN_RANGE[0]);
    expect(m.meanFill).toBeLessThanOrEqual(VOID_FILL_MEAN_RANGE[1]);
    expect(m.maxFill).toBeLessThanOrEqual(VOID_FILL_PEAK_MAX);
    expect(m.meanBonded).toBeGreaterThanOrEqual(BONDED_MEAN_MIN);
    expect(w.soup.bareQuarter).toBeLessThanOrEqual(RUNGS[0].bare);
    console.log(`seed ${seed}: void fill mean ${(100 * m.meanFill).toFixed(2)}% peak ${(100 * m.maxFill).toFixed(2)}%, `
      + `pop ${m.minPop}-${m.maxPop}, bonded min ${(100 * m.minBonded).toFixed(1)}% mean ${(100 * m.meanBonded).toFixed(1)}%, `
      + `worst quarter bare ${(100 * w.soup.bareQuarter).toFixed(1)}% of frames, `
      + `flows min ${m.minFlows}, lit min ${m.minLit}`);
  });

  it.each(CORPUS)('all nine fingers escape, and every stream crosses >= 3 parts, for seed %i', seed => {
    const w = build(seed).world;
    expect(new Set(w.events.map(e => e.finger)).size).toBe(9);
    const transits = transitsPerStream(w);
    expect(transits).toHaveLength(9);
    for (const n of transits) expect(n).toBeGreaterThanOrEqual(3);
  });

  it('detects a broken world — the sweep is not vacuous', () => {
    const w = build(20260724).world;
    const noFlows: World = { ...w, flows: [], takeovers: new Map() };
    const errs = checkInvariants(noFlows);
    expect(errs.some(e => e.includes('flows in flight'))).toBe(true);
    expect(errs.some(e => e.includes('components holding a colour'))).toBe(true);
  });

  it('detects a stream that never crosses MIN_TRANSITS components', () => {
    const w = build(20260724).world;
    const thin: World = {
      ...w,
      flows: w.flows.map(f => (f.kind === 'stream' ? { ...f, stops: f.stops.slice(0, 1) } : f)),
    };
    expect(checkInvariants(thin).some(e => e.includes('MIN_TRANSITS'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §13.4's contract, both ways round: every bound the sweep asserts is one the
  // ladder searched, AND every bound the ladder searched is swept at the rung
  // the pick actually landed on. The band and the formed-frame RATIO were gated
  // at rung 0 only while the ladder searched them at all four, so rungs 1-3
  // shipped unswept on two bounds their own rung had tested.
  // -------------------------------------------------------------------------
  describe('the relaxable soup bounds are gated at the PICK\'S OWN rung', () => {
    // Only soup *metadata* is overridden below, so the rendered pixels are the
    // real world's — the moving-cell measurement is injected rather than paid
    // for again, and the gate that reads it has its own negative test above.
    const withSoup = (over: Partial<World['soup']>): World => {
      const w = build(20260724).world;
      return { ...w, soup: { ...w.soup, ...over } };
    };
    const sweep = (over: Partial<World['soup']>): string[] =>
      checkInvariants(withSoup(over), measureMovingCells(build(20260724).world));

    it('gates §13.3\'s size band at every rung, not only at rung 0', () => {
      // rung 2 widens the band to [40, 88]; 200 cells is outside it either way.
      expect(rungBand(BAND, RUNGS[2].grow)).toEqual([40, 88]);
      expect(sweep({ rung: 2, peak: 200 }).some(e => e.includes('band'))).toBe(true);
      // ...and a peak the STRICT band would reject is accepted at the rung that
      // searched for it, which is what makes the gate rung-parameterized rather
      // than merely stricter.
      expect(sweep({ rung: 2, peak: 80 }).some(e => e.includes('band'))).toBe(false);
      expect(sweep({ rung: 0, peak: 80 }).some(e => e.includes('band'))).toBe(true);
    });

    it('gates §13.3\'s formed-frame RATIO at every rung, not only at rung 0', () => {
      for (const rung of [0, 1, 2, 3])
        expect(sweep({ rung, formedFrames: 10, ripeFrames: 100 }).some(e => e.includes('ripe frames')))
          .toBe(true);
      // 0.50 clears rung 3's 0.45 and fails rung 0's 0.70 — the rung is what decides
      expect(sweep({ rung: 3, formedFrames: 50, ripeFrames: 100 }).some(e => e.includes('ripe frames'))).toBe(false);
      expect(sweep({ rung: 0, formedFrames: 50, ripeFrames: 100 }).some(e => e.includes('ripe frames'))).toBe(true);
    });

    it('gates §13.3\'s small cast — searched by the ladder AND asserted here, at the pick\'s rung', () => {
      // Added 2026-07-25. The ladder always searched `meanBodies`; the sweep
      // never asserted it, so a 2.90-body "one creature plus confetti" void
      // could ship past a clean sweep (seed 20260101 did). Same statistic on
      // both sides now, which is §13.4's search-parity rule.
      for (const rung of [0, 1, 2, 3])
        expect(sweep({ rung, meanBodies: 1.0 }).some(e => e.includes('coexisting bodies'))).toBe(true);
      // rung-parameterized, not merely stricter: 3.3 clears rung 2's 3.2 floor
      // and fails rung 0's 4.0.
      expect(sweep({ rung: 2, meanBodies: 3.3 }).some(e => e.includes('coexisting bodies'))).toBe(false);
      expect(sweep({ rung: 0, meanBodies: 3.3 }).some(e => e.includes('coexisting bodies'))).toBe(true);
      // and the shipped pinned world clears its own rung with margin
      expect(sweep({}).some(e => e.includes('coexisting bodies'))).toBe(false);
    });

    it('exempts a LAST RESORT pick from the small cast, and reports it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const errs = sweep({ rung: RUNGS.length, meanBodies: 1.0 });
        expect(errs.some(e => e.includes('coexisting bodies'))).toBe(false);
        expect(warn.mock.calls.flat().join(' ')).toContain('coexisting bodies');
      } finally { warn.mockRestore(); }
    });

    it('exempts a LAST RESORT pick from eyes and REPORTS it — §13.4\'s own words', () => {
      // "It ranks and never tests, so it cannot promise population, fill,
      // composition or spread ANY MORE THAN IT CAN PROMISE EYES." Gating eyes at
      // rung 4 would fail CI on the very banner the ladder exists to return.
      // Above the last resort eyes never relaxes, and that is still gated.
      for (const rung of [0, 1, 2, 3])
        expect(sweep({ rung, eyes: false }).some(e => e.includes('eyes'))).toBe(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const errs = sweep({ rung: RUNGS.length, eyes: false });
        expect(errs.some(e => e.includes('eyes'))).toBe(false);
        expect(warn.mock.calls.flat().join(' ')).toContain('LAST RESORT');
        expect(warn.mock.calls.flat().join(' ')).toContain('eyes');
      } finally { warn.mockRestore(); }
    });

    it('exempts a LAST RESORT pick from the band and the formed ratio too', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const errs = sweep({ rung: RUNGS.length, peak: 200, formedFrames: 10, ripeFrames: 100 });
        expect(errs.some(e => e.includes('band'))).toBe(false);
        expect(errs.some(e => e.includes('ripe frames'))).toBe(false);
      } finally { warn.mockRestore(); }
    });
  });

  // -------------------------------------------------------------------------
  // §13.1's routed island is binding for EVERY date seed — the router is
  // best-effort and daily regeneration runs against whatever tomorrow is — so
  // the sweep asserts it, not only growth.test.ts's five sampled seeds.
  // -------------------------------------------------------------------------
  describe('§13.1 the routed island, in the sweep', () => {
    const injected = (over: Partial<World>): string[] => {
      const w = build(20260724).world;
      return checkInvariants({ ...w, ...over }, measureMovingCells(w));
    };

    it('holds on the pinned world with its measured margin', () => {
      const s = islandShape(build(20260724).world.graph);
      expect(s.fingers).toBe(9);
      expect(s.fingerIslands).toBe(1);
      expect(s.compNodes).toBeGreaterThanOrEqual(ISLAND_MIN_COMPONENTS);
      expect(s.cycleRank).toBeGreaterThanOrEqual(ISLAND_MIN_CYCLE_RANK);
      expect(s.minFingerReach).toBeGreaterThanOrEqual(ISLAND_MIN_COMPONENTS);
    });

    it('detects a shattered island — fingers apart, no components, no cycles', () => {
      const w = build(20260724).world;
      const errs = injected({ graph: { ...w.graph, edges: [], adj: w.graph.nodes.map(() => []) } });
      expect(errs.some(e => e.includes('islands'))).toBe(true);
      expect(errs.some(e => e.includes('component nodes <'))).toBe(true);
      expect(errs.some(e => e.includes('cycle rank'))).toBe(true);
    });

    it('detects an ACYCLIC island — connected, all nine fingers, but no branch to choose', () => {
      // §13.1: "Without a cycle there is no branch to choose and no rerouting."
      // Keep only a BFS spanning forest: connectivity, finger coverage and the
      // component count all survive; the cycle rank does not.
      const w = build(20260724).world;
      const seen = w.graph.nodes.map(() => false);
      const keep = new Set<number>();
      for (let s = 0; s < w.graph.nodes.length; s++) {
        if (seen[s]) continue;
        seen[s] = true;
        const q = [s];
        for (let h = 0; h < q.length; h++)
          for (const ei of w.graph.adj[q[h]]) {
            const o = w.graph.edges[ei].a === q[h] ? w.graph.edges[ei].b : w.graph.edges[ei].a;
            if (!seen[o]) { seen[o] = true; keep.add(ei); q.push(o); }
          }
      }
      const edges = w.graph.edges.filter((_, i) => keep.has(i));
      const adj: number[][] = w.graph.nodes.map(() => []);
      edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
      const tree = { ...w.graph, edges, adj };
      expect(islandShape(tree).fingerIslands).toBe(1);
      expect(islandShape(tree).compNodes).toBeGreaterThanOrEqual(ISLAND_MIN_COMPONENTS);
      const errs = injected({ graph: tree });
      expect(errs.some(e => e.includes('cycle rank'))).toBe(true);
      expect(errs.some(e => e.includes('islands'))).toBe(false);
    });
  });

  it('detects a flow riding through a text zone — the one §9.3 item §13.5 carries unchanged', () => {
    const w = build(20260724).world;
    const f = w.flows.find(x => x.kind === 'interior')!;
    const slots = [...f.slots];
    slots[50] = { x: THESIS_ZONE.x + 2, y: THESIS_ZONE.y + 2 };
    const errs = checkInvariants({ ...w, flows: [{ ...f, slots }] }, measureMovingCells(w));
    expect(errs.some(e => e.includes('flow slot cell in a text zone'))).toBe(true);
  });

  it('detects a rendered void over §13.5\'s 6 % ceiling — measured, and now gated', () => {
    const w = build(20260724).world;
    // 408 extra particles on distinct in-domain void cells, in the frame the loop
    // shows at t = 0: 408/5100 = 8.0 % of the void, comfortably over the ceiling.
    // The corpus measures 3.18-4.84 %, so this is real headroom being asserted.
    const extra: Particle[] = [];
    for (let y = VOID_Y0; y < VOID_Y0 + 6; y++)
      for (let x = VOID_X0; x <= VOID_X1; x++)
        extra.push({ x, y, vx: 0, vy: 0, c: 1, streak: 0, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0 });
    const frames = w.soup.frames.map((st, i) => (i === 0 ? { ...st, parts: [...st.parts, ...extra] } : st));
    const errs = checkInvariants({ ...w, soup: { ...w.soup, frames } });
    expect(errs.some(e => e.includes('rendered void cells'))).toBe(true);
    // and the real world is inside it on the same measurement
    expect(measureMovingCells(w).voidPeak).toBeLessThanOrEqual(VOID_FILL_PEAK_MAX);
  });

  it('exempts a LAST RESORT pick from the rendered-void ceiling, like its model twin', () => {
    // The ceiling's dominant term IS the soup population rung 4 explicitly
    // cannot promise, so gating it there would fail CI on exactly the banner the
    // exemption exists to return — and its model twin (`soup.fillPeak`) is
    // already exempt. Reported in the marker line instead.
    const w = build(20260724).world;
    const extra: Particle[] = [];
    for (let y = VOID_Y0; y < VOID_Y0 + 6; y++)
      for (let x = VOID_X0; x <= VOID_X1; x++)
        extra.push({ x, y, vx: 0, vy: 0, c: 1, streak: 0, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0 });
    const frames = w.soup.frames.map((st, i) => (i === 0 ? { ...st, parts: [...st.parts, ...extra] } : st));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const errs = checkInvariants({ ...w, soup: { ...w.soup, frames, rung: RUNGS.length } });
      expect(errs.some(e => e.includes('rendered void cells'))).toBe(false);
      expect(errs.some(e => e.includes('void fill'))).toBe(false);   // the model twin too
      expect(warn.mock.calls.flat().join(' ')).toContain('rendered void peak');
    } finally { warn.mockRestore(); }
  });

  it('detects a finger that never takes its turn, and a missing stream', () => {
    const w = build(20260724).world;
    const starved: World = {
      ...w,
      events: w.events.filter(e => e.finger !== 4),
      flows: w.flows.filter((f, i) => !(f.kind === 'stream' && i === w.flows.findIndex(x => x.kind === 'stream'))),
    };
    const errs = checkInvariants(starved);
    expect(errs.some(e => e.includes('fingers escape'))).toBe(true);
    expect(errs.some(e => e.includes('streams, expected one per finger'))).toBe(true);
  });
});

describe('§13.5 the moving-cell bounds', () => {
  it('the pinned configuration sits inside both bounds, measured on rendered frames', () => {
    const m = measureMovingCells(build(20260724).world);
    console.log(`seed 20260724 moving cells: board peak ${(100 * m.boardPeak).toFixed(2)}% mean ${(100 * m.boardMean).toFixed(2)}%, `
      + `void peak ${(100 * m.voidPeak).toFixed(2)}%, canvas peak ${(100 * m.canvasPeak).toFixed(2)}% mean ${(100 * m.canvasMean).toFixed(2)}%`);
    expect(m.boardPeak).toBeLessThanOrEqual(MOVING_BOARD_PEAK_MAX);
    expect(m.canvasPeak).toBeLessThanOrEqual(MOVING_CANVAS_PEAK_MAX);
    expect(m.voidPeak).toBeLessThanOrEqual(VOID_FILL_PEAK_MAX);
    // not vacuous: the board really is in motion
    expect(m.boardMean).toBeGreaterThan(0.02);
  });

  it('detects a board over the bound — the gate is not vacuous', () => {
    const w = build(20260724).world;
    // A world whose board genuinely moves too much. Repeating an existing flow
    // adds no geometry — the copies paint the cells the original already paints,
    // so the measurement does not move at all. Real extra area is needed, so
    // these flows carry synthetic slot arrays covering board cells nothing else
    // touches. A flow draws its trail while `0.75*(2u)^2 >= 0.12`, i.e. the
    // nearest ~80 % of it, and a slot array is only `T * SLOTS_PER_FRAME` long,
    // so one flow can paint at most ~691 cells however long its trail: clearing
    // 14 % of 18320 board cells takes several.
    const SLOTS = T * 3;
    const need = Math.ceil(MOVING_BOARD_PEAK_MAX * 18320 / (0.8 * SLOTS)) + 2;
    const painted: Cell[] = [];
    for (let y = 4; y < 76 && painted.length < need * SLOTS; y++)
      for (let x = 4; x < 224 && painted.length < need * SLOTS; x++) painted.push({ x, y });
    const smear: Flow[] = Array.from({ length: need }, (_, k) => ({
      kind: 'interior' as const,
      slots: painted.slice(k * SLOTS, (k + 1) * SLOTS),
      trail: SLOTS, color: '#00e5ff', stops: [],
    }));
    const busy: World = { ...w, flows: [...w.flows, ...smear] };

    const m = measureMovingCells(busy);
    expect(m.boardPeak).toBeGreaterThan(MOVING_BOARD_PEAK_MAX);
    // and checkInvariants, reading that same measurement, reports it
    expect(checkInvariants(busy).some(e => e.includes('differing from the static board'))).toBe(true);
    // the real world is inside the bound on the same measurement
    expect(measureMovingCells(w).boardPeak).toBeLessThanOrEqual(MOVING_BOARD_PEAK_MAX);
  });
});

describe('§13.6 the sweep is wired into the PRODUCTION render path', () => {
  // The suite sweeps the corpus and twelve sampled dates; production renders
  // §13.8's activity date, which is in neither. Without this the sweep is the
  // last line of defense for seeds it never sees.
  const violating = (): World => {
    const w = build(20260724).world;
    const f = w.flows.find(x => x.kind === 'interior')!;
    const slots = [...f.slots];
    slots[50] = { x: THESIS_ZONE.x + 2, y: THESIS_ZONE.y + 2 };
    return { ...w, flows: [{ ...f, slots }] };
  };

  it('gateWorld passes a clean world silently, with exit code 0', () => {
    const w = build(20260724).world;
    const lines: string[] = [];
    expect(gateWorld(w, measureMovingCells(w), l => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });

  it('gateWorld fails a violating world: exit code 1, the seed, and every violation', () => {
    const w = build(20260724).world;
    const lines: string[] = [];
    // the moving measurement is the clean world's — the injected violation is a
    // model one, and this keeps the test to zero extra render passes
    expect(gateWorld(violating(), measureMovingCells(w), l => lines.push(l))).toBe(1);
    const report = lines.join('\n');
    expect(report).toContain('refusing to ship seed 20260724');
    expect(report).toContain('flow slot cell in a text zone');
    expect(lines.length).toBe(1 + checkInvariants(violating(), measureMovingCells(w)).length);
  });

  it('main.ts runs the gate and exits non-zero on it, before writing the GIF', () => {
    // main.ts is a side-effectful entry point with no harness (importing it
    // renders a banner), so the wiring is asserted on its source: the guard is
    // called, its code reaches process.exit, and the encode happens after.
    const src = readFileSync(new URL('main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const\s+code\s*=\s*gateWorld\(world,\s*measureMovingCells\(world,\s*frames\)\)/);
    expect(src).toMatch(/if\s*\(code\s*!==\s*0\)\s*\{[\s\S]*process\.exit\(code\)/);
    expect(src.indexOf('gateWorld(')).toBeLessThan(src.indexOf('encodeGif('));
  });

  it('main.ts rejects a flag with no value instead of building a NaN world', () => {
    // `--seed` given last read undefined and became NaN, which built a silently
    // garbage world rather than failing.
    const src = readFileSync(new URL('main.ts', import.meta.url), 'utf8');
    expect(src).toContain('Number.isInteger');
    expect(src).not.toMatch(/Number\(arg\('(seed|fps|seconds)'/);
    // not vacuous: that pattern is exactly the unguarded form it must catch
    expect("const seed = Number(arg('seed', '20260725'));").toMatch(/Number\(arg\('(seed|fps|seconds)'/);
  });

  it('measures the moving cells identically from handed-in frames and from its own render', () => {
    const w = build(20260724).world;
    const render = createRenderer(w);
    const frames: Uint8ClampedArray[] = [];
    for (let t = 0; t < w.T; t++)
      frames.push(render(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data);
    // a spread copy is a fresh identity, so this is measured afresh rather than
    // served from the memo
    expect(measureMovingCells({ ...w }, frames)).toEqual(measureMovingCells(w));
    // and a caller that hands in the wrong loop is told, not quietly believed
    expect(() => measureMovingCells({ ...w }, frames.slice(0, 10)))
      .toThrow(/10 frames supplied for a 288-frame world/);
  });
});

describe('§13.2 the per-seed guarantees, over a whole year of date seeds', () => {
  // These two are binding for EVERY date seed, not just the corpus: daily
  // regeneration runs against whatever tomorrow is. The flow layer is cheap to
  // build on its own (no soup, no ladder), so a full year fits in the default
  // suite — this is the sweep that would catch a seed whose journey search comes
  // up short, and it is why the engine is left best-effort with checkInvariants
  // as the loud backstop rather than growing a second search.
  it('every one of 365 date seeds gets 9 streams, 9/9 fingers, and >= MIN_TRANSITS per stream', () => {
    const start = Date.UTC(2026, 6, 25);
    let worstTransit = Infinity, worstSeed = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(start + i * 86400000);
      const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      const layout = buildLayout(mulberry32(seed));
      const graph = buildGraph(layout.components, buildNets(layout));
      const { flows, events } = buildFlows(mulberry32(seed ^ 0x5eed), graph, distanceToConnector(graph), T);
      const streams = flows.filter(f => f.kind === 'stream');
      const transits = streams.map(f => f.stops.filter(st => graph.nodes[st.node].comp >= 0).length);
      const lo = Math.min(...transits);
      if (lo < worstTransit) { worstTransit = lo; worstSeed = seed; }
      expect(`${seed}: ${streams.length} streams`).toBe(`${seed}: 9 streams`);
      expect(`${seed}: ${new Set(events.map(e => e.finger)).size}/9 fingers`).toBe(`${seed}: 9/9 fingers`);
      expect(`${seed}: min transits ${lo}`).toBe(`${seed}: min transits ${Math.max(lo, MIN_TRANSITS)}`);
    }
    console.log(`365 date seeds: 9 streams and 9/9 fingers everywhere; worst single-stream transit count `
      + `${worstTransit} (seed ${worstSeed}), floor ${MIN_TRANSITS}`);
    expect(worstTransit).toBeGreaterThanOrEqual(MIN_TRANSITS);
  });
});

describe('§13.4 the ladder places every date seed', () => {
  it.each(CORPUS)('seed %i lands on a real rung with a real creature', seed => {
    const w = build(seed).world;
    expect(w.soup.rung).toBeLessThan(RUNGS.length);      // never the last resort
    expect(w.soup.eyes).toBe(true);                      // eyes never relax
    expect(w.soup.empty).toBe(true);                     // the seam never relaxes
    expect(w.soup.peak).toBeGreaterThanOrEqual(40);      // the band floor is FORMED_MIN
    expect(w.soup.sims).toBeGreaterThanOrEqual(1);
  });

  // A sampled date-seed sweep across the decade production actually regenerates
  // over. The full 365-day sweep is env-gated below.
  const SAMPLED_DATES = [
    20260725, 20261231, 20270214, 20280229, 20290704, 20300101,
    20310930, 20320815, 20330501, 20341120, 20350606, 20360319,
  ];
  it.each(SAMPLED_DATES)('date seed %i returns a banner the frame sweep accepts', seed => {
    const w = buildWorld(seed, T);
    expect(w.soup.frames).toHaveLength(w.arc);
    expect(w.soup.rung).toBeLessThanOrEqual(RUNGS.length);
    expect(w.soup.empty || w.soup.rung === RUNGS.length).toBe(true);
    expect(w.flows.length).toBeGreaterThanOrEqual(MIN_FLOWS_IN_FLIGHT);
    // THE search-vs-sweep REGRESSION GUARD. The corpus is nine hand-picked seeds
    // and every bound the sweep asserts is supposed to be one the ladder searches
    // on; the way that contract breaks is a date seed nobody sampled shipping a
    // pick checkInvariants then rejects, which is exactly what happened before
    // the mono gate was moved into the ladder (3 of 24 sampled dates). These
    // twelve already build full worlds, so running the sweep on them is the
    // cheapest committed check that the two halves still agree off-corpus.
    expect(`${seed}: ${checkInvariants(w).join(' | ') || 'clean'}`).toBe(`${seed}: clean`);
  });

  it.runIf(process.env.LIVING_BOARD_SLOW)('a full year of real date seeds, run as production runs it', () => {
    const start = Date.UTC(2026, 6, 25);
    const hist: Record<number, number> = {};
    let sims = 0, worst = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(start + i * 86400000);
      const seed = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      const w = buildWorld(seed, T);
      hist[w.soup.rung] = (hist[w.soup.rung] ?? 0) + 1;
      sims += w.soup.sims; worst = Math.max(worst, w.soup.sims);
      expect(w.soup.empty).toBe(true);
      expect(w.soup.eyes).toBe(true);
      // The last resort is exempt from the relaxable soup bounds (checkInvariants
      // reports them instead of gating them), so pinning "no date reaches it" is
      // what keeps that exemption latent rather than load-bearing.
      expect(`${seed} rung ${w.soup.rung}`).toBe(`${seed} rung ${Math.min(w.soup.rung, RUNGS.length - 1)}`);
    }
    console.log(`year sweep: rungs ${JSON.stringify(hist)}, mean ${(sims / 365).toFixed(2)} sims/seed, worst ${worst}`);
    expect(hist[RUNGS.length] ?? 0).toBe(0);   // nothing falls to the last resort
  });
});

describe('performance', () => {
  it('buildWorld averages <= 5 s and never exceeds 20 s across the corpus', () => {
    const times = CORPUS.map(s => build(s).ms);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`buildWorld(seed, 288): mean ${(mean / 1000).toFixed(2)} s, worst ${(Math.max(...times) / 1000).toFixed(2)} s `
      + `over ${times.length} seeds [${times.map(m => (m / 1000).toFixed(2)).join(', ')}]`);
    expect(mean).toBeLessThanOrEqual(5000);
    expect(Math.max(...times)).toBeLessThanOrEqual(20000);
  });

  it('renders a frame in well under a second', () => {
    const render = createRenderer(build(20260724).world);
    render(0);
    const t0 = Date.now();
    for (let t = 0; t < 20; t++) render(t * 7);
    const per = (Date.now() - t0) / 20;
    console.log(`render(t): ${per.toFixed(1)} ms/frame`);
    expect(per).toBeLessThan(1000);
  });
});
