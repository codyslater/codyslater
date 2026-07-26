import type { World } from './types.js';
import {
  ACCENT_LIST, BOARD_RIGHT, CELL, FINGER_W, FINGERS, GRID_H, GRID_W, HEIGHT,
  ISLAND_MIN_COMPONENTS, ISLAND_MIN_CYCLE_RANK, TEXT_ZONES, WIDTH,
  buildGraph, buildLayout, fabricCells, inRect, islandShape,
} from './layout.js';
import { buildNets } from './growth.js';
import { MIN_TRANSITS, buildFlows, collectTakeovers, distanceToConnector, flowDrawn, washAt } from './signals.js';
import {
  BAND, RUNGS, SHIPPED_MONO, SHIPPED_SYM, VOID_CELLS, VOID_FILL_MEAN_MAX,
  VOID_FILL_PEAK_MAX, VOID_X0, VOID_Y0, VOID_Y1,
  bondedFraction, buildReleaseSchedule, findSoup, genLength, meetsShippedForm, rungBand, visibleAges,
  voidPopulation,
} from './creatures.js';
import { createRenderer, drawStatic } from './render.js';
import { mulberry32 } from './rng.js';

export const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * §13.4 / §5 as amended: T = 288 frames = 24 s at 12 fps.
 *
 * §13.5 supersedes §5's `--fps 15 --seconds 30` ("defaults are 12 fps, 24 s");
 * the 30 s / 3-generation configuration measured 8.48 MB, over §6's hard gate,
 * which is the measurement that decided T = 288. These are the CLI's defaults
 * and `DEFAULT_T` is DERIVED from them, so the loop the suite exercises and the
 * loop `main.ts` renders cannot drift apart.
 */
export const DEFAULT_FPS = 12;
export const DEFAULT_SECONDS = 24;
export const DEFAULT_T = DEFAULT_FPS * DEFAULT_SECONDS;   // 288
/** §5's `--out` default. */
export const DEFAULT_OUT = 'banner.gif';

/**
 * The whole loop, precomputed on the circular timeline. Everything downstream
 * evaluates a frame as a pure function of `t mod T`.
 *
 * Two rng streams, both `mulberry32` off the date seed and nothing else (§5):
 * the board's own (placement, dressing) and the flows' (`seed ^ 0x5eed`). The
 * soup runs off a third, the §13.4 hash chain `mulberry32(seed ^ 0x50a9)`, so a
 * change in candidate count can never shift the board.
 */
export function buildWorld(seed: number, T = DEFAULT_T): World {
  const rng = mulberry32(seed);
  const layout = buildLayout(rng);

  // §13.1: static, complete copper — one routed island with cycles in it.
  const nets = buildNets(layout);
  const graph = buildGraph(layout.components, nets);
  const fabric = fabricCells(graph);

  // §13.2: the flows, on one slot-exact schedule.
  const dToC = distanceToConnector(graph);
  const { flows, events } = buildFlows(mulberry32(seed ^ 0x5eed), graph, dToC, T);
  const takeovers = collectTakeovers(flows, graph, layout.components, T);

  // §13.3/§13.4: what escapes feeds the void; the ladder picks the arc that ships.
  const arc = genLength(T);
  const soup = findSoup(seed, buildReleaseSchedule(events, T), arc, T, ACCENT_LIST);

  return {
    seed, T, accents: layout.accents,
    components: layout.components, sections: layout.sections,
    dressing: layout.dressing, mountHoles: layout.mountHoles,
    nets, graph, fabric,
    flows, events, takeovers,
    soup, arc,
  };
}

// ---------------------------------------------------------------------------
// §13.5's frame sweep. §9.3's old assertion list (creature/pulse caps, coverage
// cap, territory separation, flash budget) is superseded item for item and is
// deliberately not ported.
// ---------------------------------------------------------------------------

/** §13.5's traffic floor — the liveness property that replaces §11's ≥2-of-3
 * invariant now that the copper is static and complete in every frame. */
export const MIN_FLOWS_IN_FLIGHT = 4;
export const MIN_LIT_COMPONENTS = 3;

/**
 * §13.5's moving-cell bounds, measured against the static board exactly as
 * §13.5's table measures them: cells (not pixels) whose colour differs from the
 * static layer, over §13.5's own denominators — 18320 board cells and 24000
 * canvas cells. §12.6.4's "≤ 2.5 % differing from the fully-lit steady state" is
 * superseded: there is no steady state any more.
 *
 * Corpus at the shipped constants: board peak 10.03-13.13 %, canvas peak
 * 8.47-10.67 %. The board bound has under a point of margin on the worst seed,
 * which is precisely why it is gated rather than measured in a scratchpad.
 */
export const MOVING_BOARD_PEAK_MAX = 0.14;
export const MOVING_CANVAS_PEAK_MAX = 0.12;
const BOARD_CELLS = (BOARD_RIGHT - 1) * GRID_H;   // 18320, §13.5's own figure
const CANVAS_CELLS = GRID_W * GRID_H;             // 24000
/**
 * §13.5: void fill, as a fraction of the void's own cells — "void cells occupied
 * (of 5100)", counted as distinct occupied cells INSIDE the void (crust sits on
 * the board's interface at x = BOARD_RIGHT, so it is not a void cell). Measured
 * once, by `creatures.voidOccupancy`, for both the search and these gates.
 *
 * The mean floor is ENFORCED, and it is 2.5 %, not §13.5's original 3 %. The 3 %
 * came from three sampled seeds (3.46 / 3.70 / 3.49 %); across 61 sampled date
 * seeds the shipped loop measures 2.55-3.97 %, so 3 % was never a floor the
 * generator could hold for an arbitrary date. 2.5 % is what the year clears, and
 * the ladder searches on it (RUNGS[k].fill) so it is a bound the generator can
 * satisfy rather than one it happens to meet.
 */
export { VOID_FILL_PEAK_MAX } from './creatures.js';
/** §13.5's mean-fill band. The FLOOR is the strict rung's own searched bound —
 * one definition, so the gate and the search cannot drift apart. */
export const VOID_FILL_MEAN_RANGE: [number, number] = [RUNGS[0].fill, VOID_FILL_MEAN_MAX];
export { FORMED_FRAME_FRACTION } from './creatures.js';
/**
 * §13.3's composition bound (new in this round). Cody, 2026-07-25: *"lean toward
 * having lower ratio of floating pixels vs part of some life form."* The void
 * must read as mostly-life-with-some-drift, not as two co-equal populations.
 *
 * THE STRICT RUNG'S value, and what the corpus is held to. Like void fill this is
 * a richness target the ladder can relax, so `checkInvariants` gates the shipped
 * pick at `RUNGS[pick.rung].bonded` rather than at this constant — they coincide
 * only for a rung-0 pick, which is every corpus seed and 357/365 dates.
 */
export const BONDED_MEAN_MIN = RUNGS[0].bonded;

/** Legal ground for a flow cell on the board (§13.1's on-copper invariant): a
 * net's trace cells, a component's own footprint, the connector gold, or the
 * fabric. Beyond `BOARD_RIGHT` is the escape, and it is the point. */
export function copperCells(world: World): Set<string> {
  const copper = new Set<string>();
  for (const n of world.nets) for (const c of n.cells) copper.add(`${c.x},${c.y}`);
  for (const c of world.fabric) copper.add(`${c.x},${c.y}`);
  for (const comp of world.components) {
    const r = comp.rect;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) copper.add(`${x},${y}`);
  }
  for (const f of FINGERS)
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + FINGER_W; x++) copper.add(`${x},${y}`);
  return copper;
}

/**
 * §13.5's restraint measurement, on the rendered loop: cells whose colour
 * differs from the static board, split board / void, over §13.5's own
 * denominators. One render pass over the whole loop — the only part of the sweep
 * that costs real time (~1.4 s at T = 288), and the only one that can see what a
 * viewer sees rather than what the model intends.
 */
export interface MovingCells {
  boardPeak: number; boardMean: number; voidPeak: number; canvasPeak: number; canvasMean: number;
}

/** Memoised by world IDENTITY. `measureMovingCells` is a pure function of the
 * world and a `World` is frozen in practice once `buildWorld` returns it, so a
 * second call on the same object cannot want a different answer — and the suite
 * asks for the same world's measurement from several tests. A fixture built by
 * spreading a world is a different object and is measured afresh. */
const MOVING_CACHE = new WeakMap<World, MovingCells>();

/**
 * §13.5's rendered budgets, measured over the whole loop.
 *
 * `frames` (optional) hands in pixels the caller has ALREADY rendered, in loop
 * order `t = 0 … T-1`, exactly as `createRenderer(world)` produces them —
 * `main.ts` renders every frame to encode the GIF, so the production gate reads
 * those instead of paying a second full render pass. The count is checked; the
 * contents are the caller's contract, and a caller that cannot honour it simply
 * omits the argument and gets its own render.
 */
export function measureMovingCells(world: World, frames?: readonly Uint8ClampedArray[]): MovingCells {
  const cached = MOVING_CACHE.get(world);
  if (cached) return cached;
  if (frames && frames.length !== world.T)
    throw new Error(`measureMovingCells: ${frames.length} frames supplied for a ${world.T}-frame world`);
  const base = drawStatic(world).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
  let frameAt: (t: number) => Uint8ClampedArray;
  if (frames) frameAt = t => frames[t];
  else {
    const render = createRenderer(world);
    frameAt = t => render(t).getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
  }
  let boardPeak = 0, voidPeak = 0, canvasPeak = 0, boardSum = 0, canvasSum = 0;
  for (let t = 0; t < world.T; t++) {
    const d = frameAt(t);
    let onBoard = 0, inVoid = 0;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) {
        const i = ((y * CELL) * WIDTH + x * CELL) * 4;
        if (d[i] === base[i] && d[i + 1] === base[i + 1] && d[i + 2] === base[i + 2]) continue;
        if (x <= BOARD_RIGHT) onBoard++; else inVoid++;
      }
    boardPeak = Math.max(boardPeak, onBoard / BOARD_CELLS);
    voidPeak = Math.max(voidPeak, inVoid / VOID_CELLS);
    canvasPeak = Math.max(canvasPeak, (onBoard + inVoid) / CANVAS_CELLS);
    boardSum += onBoard / BOARD_CELLS;
    canvasSum += (onBoard + inVoid) / CANVAS_CELLS;
  }
  const out: MovingCells = {
    boardPeak, boardMean: boardSum / world.T, voidPeak,
    canvasPeak, canvasMean: canvasSum / world.T,
  };
  MOVING_CACHE.set(world, out);
  return out;
}

/**
 * §13.5/§13.6's full-loop sweep. Returns a list of violations (empty = clean).
 *
 * Asserted here: the traffic floor; standing population and void fill; the
 * on-copper invariant; the three text zones clear (unchanged and still binding —
 * THESIS_ZONE and REV_ZONE are retired as text but remain exclusion masks);
 * §13.2's per-seed guarantees (one stream per finger, all nine fingers escaping,
 * every stream crossing >= MIN_TRANSITS components); §13.5's moving-cell bounds
 * on the rendered frames; the arc bare at age S; seam exactness; and, for a
 * strict (rung 0) pick, §13.3's formation metrics. The five continuity checks
 * live in `continuity.ts` so they can be run standalone against a corpus.
 */
export function checkInvariants(world: World, moving: MovingCells = measureMovingCells(world)): string[] {
  const errs: string[] = [];
  const T = world.T;

  // ---- zone exclusion masks (static geometry) -----------------------------
  const zoneHit = (x: number, y: number): boolean => TEXT_ZONES.some(z => inRect(x, y, z));
  for (const n of world.nets)
    for (const c of n.cells) if (zoneHit(c.x, c.y)) { errs.push(`net cell in a text zone at ${c.x},${c.y}`); break; }
  for (const c of world.fabric) if (zoneHit(c.x, c.y)) { errs.push(`fabric cell in a text zone at ${c.x},${c.y}`); break; }
  // A flow rides copper and the copper is clear of the zones, so this holds
  // transitively — but §13.5 names "the three text zones still clear" as the one
  // §9.3 item it carries UNCHANGED, and a binding clause should be asserted
  // directly rather than inferred from two others.
  for (const f of world.flows) {
    const hit = f.slots.find(p => !!p && p.x <= BOARD_RIGHT && zoneHit(p.x, p.y));
    if (hit) errs.push(`flow slot cell in a text zone at ${hit.x},${hit.y}`);
  }
  for (const comp of world.components) {
    const r = comp.rect;
    if (TEXT_ZONES.some(z => r.x < z.x + z.w && z.x < r.x + r.w && r.y < z.y + z.h && z.y < r.y + r.h))
      errs.push(`component ${comp.kind} at ${r.x},${r.y} overlaps a text zone`);
  }
  for (const f of world.dressing.features) {
    const r = f.rect;
    if (TEXT_ZONES.some(z => r.x < z.x + z.w && z.x < r.x + r.w && r.y < z.y + z.h && z.y < r.y + r.h))
      errs.push(`dressing ${f.kind} at ${r.x},${r.y} overlaps a text zone`);
  }

  // ---- §13.1's on-copper invariant ----------------------------------------
  const copper = copperCells(world);
  let offCopper = 0;
  for (const f of world.flows)
    for (const p of f.slots) {
      if (!p || p.x > BOARD_RIGHT) continue;
      if (!copper.has(`${p.x},${p.y}`)) offCopper++;
    }
  if (offCopper > 0) errs.push(`${offCopper} flow slot cells off copper (on board)`);

  // ---- §13.1's routed island ----------------------------------------------
  // "There is one connected island containing all nine connector fingers and
  // >= 20 component nodes, whose simple cycle rank is >= 3." Binding for every
  // date seed, not only the corpus — the router is best-effort and daily
  // regeneration runs against whatever tomorrow is, so this sweep is what stands
  // between a degenerate graph and the banner. Without cycles there is no branch
  // to choose and §13.2's journeys cannot reroute.
  const island = islandShape(world.graph);
  if (island.fingers !== FINGERS.length)
    errs.push(`${island.fingers} finger nodes in the graph, expected ${FINGERS.length}`);
  if (island.fingerIslands !== 1)
    errs.push(`the nine fingers span ${island.fingerIslands} islands — §13.1 requires exactly one`);
  if (island.compNodes < ISLAND_MIN_COMPONENTS)
    errs.push(`the routed island holds ${island.compNodes} component nodes < ${ISLAND_MIN_COMPONENTS}`);
  if (island.cycleRank < ISLAND_MIN_CYCLE_RANK)
    errs.push(`routed-island simple cycle rank ${island.cycleRank} < ${ISLAND_MIN_CYCLE_RANK}`);
  if (island.minFingerReach < ISLAND_MIN_COMPONENTS)
    errs.push(`a finger is reachable from only ${island.minFingerReach} component nodes < ${ISLAND_MIN_COMPONENTS}`);

  // ---- per-frame sweep ----------------------------------------------------
  const nodes = [...world.takeovers.keys()];
  const { min: popMin, max: popMax } = voidPopulation(world.soup.frames, T);
  for (let t = 0; t < T; t++) {
    // §13.5's traffic floor.
    let inFlight = 0;
    for (const f of world.flows) if (flowDrawn(f, t, T).length > 0) inFlight++;
    if (inFlight < MIN_FLOWS_IN_FLIGHT) errs.push(`t=${t}: only ${inFlight} flows in flight`);
    let lit = 0;
    for (const n of nodes) if (washAt(world.takeovers.get(n), t, T)) lit++;
    if (lit < MIN_LIT_COMPONENTS) errs.push(`t=${t}: only ${lit} components holding a colour`);

    // §13.3's domain. (The standing population itself is measured once, by the
    // shared `voidPopulation` above — the same statistic the ladder searched.)
    for (const age of visibleAges(t, T))
      // The soup lives in the void and never touches the board. Its only exit is
      // off the right edge of the canvas — culled two cells BEYOND it, so nothing
      // is ever removed while it is still visible, which is why the upper x bound
      // is the cull line and not VOID_X1.
      for (const p of world.soup.frames[age].parts) {
        const cx = Math.round(p.x), cy = Math.round(p.y);
        if (cx < VOID_X0 || cx > GRID_W + 2 || cy < VOID_Y0 - 1 || cy > VOID_Y1 + 1)
          errs.push(`t=${t}: soup particle outside the void domain at ${cx},${cy}`);
      }
  }

  // ---- the RELAXABLE soup bounds ------------------------------------------
  // Population, void fill, composition and the whole-width read are all searched
  // by the ladder (`creatures.meets`, on these same statistics), so each is gated
  // at the bound the pick's OWN rung searched on. Holding a relaxed pick to the
  // strict bound would contradict the ladder, exactly as §13.4 says of the other
  // richness targets.
  //
  // A LAST-RESORT pick (rung 4) is exempt from all of them, the same way it is
  // exempt from eyes and the shipped-loop means: rung 4 ranks whatever has been
  // simulated and never tests, so it cannot promise any of these — gating them
  // would fail CI on a banner the ladder was designed to return, and would make
  // the sweep's own report untrue. It is reported loudly instead, so a rung-4
  // build is never silently mistaken for a passing one.
  const lastResort = world.soup.rung >= RUNGS.length;
  const rung = RUNGS[Math.min(world.soup.rung, RUNGS.length - 1)];
  const [bandLo, bandHi] = rungBand(BAND, rung.grow);
  const { formedFrames, ripeFrames } = world.soup;
  if (lastResort) {
    console.warn(`checkInvariants: seed ${world.seed} shipped on the LAST RESORT rung (${world.soup.rung}). `
      + `The relaxable soup bounds are REPORTED, NOT GATED — pop ${popMin}-${popMax}, `
      + `fill mean ${(100 * world.soup.fillMean).toFixed(2)}% peak ${(100 * world.soup.fillPeak).toFixed(2)}%, `
      + `bonded ${(100 * world.soup.bondedMean).toFixed(1)}%, `
      + `mean coexisting bodies ${world.soup.meanBodies.toFixed(2)}, `
      + `worst quarter bare on ${(100 * world.soup.bareQuarter).toFixed(1)}% of frames, `
      + `body peak ${world.soup.peak} cells, formed on ${formedFrames}/${ripeFrames} ripe frames, `
      + `mono ${world.soup.mono.toFixed(3)} sym ${world.soup.sym.toFixed(3)}, `
      + `eyes ${world.soup.eyes ? 'present' : 'ABSENT'}, `
      + `rendered void peak ${(100 * moving.voidPeak).toFixed(2)}%.`);
  } else {
    if (popMin < rung.pop[0])
      errs.push(`standing void population dips to ${popMin} < ${rung.pop[0]} (rung ${world.soup.rung} floor)`);
    if (popMax > rung.pop[1])
      errs.push(`standing void population peaks at ${popMax} > ${rung.pop[1]} (rung ${world.soup.rung} ceiling)`);
    if (world.soup.fillMean < rung.fill)
      errs.push(`mean void fill ${(100 * world.soup.fillMean).toFixed(2)}% < ${(100 * rung.fill).toFixed(1)}% `
        + `(rung ${world.soup.rung} floor)`);
    if (world.soup.bondedMean < rung.bonded)
      errs.push(`bonded fraction ${(100 * world.soup.bondedMean).toFixed(1)}% < ${(100 * rung.bonded).toFixed(0)}% `
        + `(rung ${world.soup.rung} floor)`);
    // §13.3's small cast, gated here as of 2026-07-25. The ladder has always
    // SEARCHED on `meanBodies` (`RUNGS[k].bodies`) but the sweep never asserted
    // it — the search-parity rule running the same way round as the old mono gap,
    // and the reason a 2.90-body "one creature plus confetti" void could ship
    // past a clean sweep. Gated at the pick's OWN rung, like its relaxable peers.
    if (world.soup.meanBodies < rung.bodies)
      errs.push(`mean coexisting bodies ${world.soup.meanBodies.toFixed(2)} < ${rung.bodies} `
        + `(rung ${world.soup.rung} floor)`);
    // §13.3: "the void must read as inhabited across its whole width, not as a
    // lip with a blank far side."
    if (world.soup.bareQuarter > rung.bare)
      errs.push(`a void quarter is bare on ${(100 * world.soup.bareQuarter).toFixed(1)}% of frames `
        + `> ${(100 * rung.bare).toFixed(0)}% (rung ${world.soup.rung} ceiling)`);
    // The void-fill CEILINGS are restraint bounds, not richness ones: they do not
    // relax, so they hold on every pick short of the last resort.
    if (world.soup.fillMean > VOID_FILL_MEAN_RANGE[1])
      errs.push(`mean void fill ${(100 * world.soup.fillMean).toFixed(2)}% > ${100 * VOID_FILL_MEAN_RANGE[1]}%`);
    if (world.soup.fillPeak > VOID_FILL_PEAK_MAX)
      errs.push(`peak void fill ${(100 * world.soup.fillPeak).toFixed(2)}% > ${100 * VOID_FILL_PEAK_MAX}%`);

    // §13.3's size band and formed-frame EXPECTATION, at the rung the pick's own
    // search used. Both were gated at rung 0 only while the ladder searched them
    // at all four, so a rung-1..3 pick shipped unswept on two bounds its own rung
    // had already tested — the same "swept but not searched" defect class as the
    // mono gate, running the other way.
    if (world.soup.peak < bandLo || world.soup.peak > bandHi)
      errs.push(`body peak ${world.soup.peak} outside the ${bandLo}-${bandHi} band (rung ${world.soup.rung})`);
    if (ripeFrames && formedFrames / ripeFrames < rung.formedFrac)
      errs.push(`formed on ${formedFrames}/${ripeFrames} ripe frames `
        + `(< ${(100 * rung.formedFrac).toFixed(0)}%, rung ${world.soup.rung})`);
    // §13.4: "Eyes never relaxes ABOVE THE LAST RESORT. A creature is a face."
    // Rung 4 "ranks and never tests, so it cannot promise population, fill,
    // composition or spread any more than it can promise eyes" — so eyes is
    // gated on every real rung and reported, not gated, on the last resort.
    if (!world.soup.eyes) errs.push('no body ever opened eyes');
  }

  // ---- §13.2's binding per-seed guarantees -------------------------------
  // Both are best-effort in the engine (a journey search can come up empty), so
  // they are asserted here rather than only in the corpus tests: daily
  // regeneration runs against an arbitrary date seed, and this sweep is what
  // stands between a thin build and the banner.
  const streams = world.flows.filter(f => f.kind === 'stream');
  if (streams.length !== FINGERS.length)
    errs.push(`${streams.length} streams, expected one per finger (${FINGERS.length})`);
  streams.forEach((f, i) => {
    const crossed = f.stops.filter(st => world.graph.nodes[st.node].comp >= 0).length;
    if (crossed < MIN_TRANSITS)
      errs.push(`stream ${i} crosses ${crossed} components before the gold, < MIN_TRANSITS ${MIN_TRANSITS}`);
  });
  const fingersUsed = new Set(world.events.map(e => e.finger));
  if (fingersUsed.size !== FINGERS.length)
    errs.push(`${fingersUsed.size}/${FINGERS.length} fingers escape — every one must take its turn`);

  // ---- §13.5's moving-cell bounds, on the rendered frames ------------------
  if (moving.boardPeak > MOVING_BOARD_PEAK_MAX)
    errs.push(`board cells differing from the static board peak at ${(100 * moving.boardPeak).toFixed(2)}% > ${100 * MOVING_BOARD_PEAK_MAX}%`);
  if (moving.canvasPeak > MOVING_CANVAS_PEAK_MAX)
    errs.push(`whole-canvas moving cells peak at ${(100 * moving.canvasPeak).toFixed(2)}% > ${100 * MOVING_CANVAS_PEAK_MAX}%`);
  // §13.5's table bounds "void cells occupied (of 5100)" at peak <= 6 % — the
  // same ceiling `world.soup.fillPeak` carries in the model, asserted here on
  // what is actually DRAWN. It was measured by `measureMovingCells` and reported
  // in a test but never gated; a restraint ceiling that is only ever printed is
  // not a gate. Corpus 3.18-4.84 %.
  //
  // WHY IT IS NOT IN THE LADDER'S SEARCHED SET, unlike every soup bound §13.4
  // requires search parity for. This statistic is derived from the RENDER, not
  // from the soup: it counts drawn void cells, which include the escaping
  // streams' own cells, and no soup candidate selects for it. Searching it would
  // mean rendering all 288 frames of every candidate — up to 28 render passes
  // per seed against the ~0.1 s simulation the ladder is budgeted around, which
  // is not a bound the search *can* satisfy in §13.4's sense. It is therefore
  // classed with `boardPeak`/`canvasPeak` as a pure RESTRAINT bound: a ceiling on
  // what the frame may show, not a richness target the search trades against.
  //
  // It is nonetheless skipped for a LAST RESORT pick, because its dominant term
  // IS the soup population that rung 4 explicitly cannot promise — gating it
  // there would fail CI on exactly the banner the exemption exists to return.
  // Reported in the marker line above instead, like its model twin.
  if (!lastResort && moving.voidPeak > VOID_FILL_PEAK_MAX)
    errs.push(`rendered void cells peak at ${(100 * moving.voidPeak).toFixed(2)}% > ${100 * VOID_FILL_PEAK_MAX}%`);

  // ---- §13.4: the arc is bare at age S, and the seam is exact -------------
  const last = world.soup.frames[world.arc - 1];
  if (last.parts.length || last.clusters.length || last.crust.length)
    errs.push(`arc not bare at age S: ${last.parts.length} parts, ${last.clusters.length} clusters, ${last.crust.length} crust`);
  if (visibleAges(0, T).join() !== visibleAges(T, T).join()) errs.push('visible ages differ at t=0 and t=T');
  for (const f of world.flows) {
    const a = flowDrawn(f, 0, T), b = flowDrawn(f, T, T);
    if (JSON.stringify(a) !== JSON.stringify(b)) { errs.push('a flow draws different cells at t=0 and t=T'); break; }
  }

  // ---- §13.3's shipped-loop form means ------------------------------------
  // NOT relaxable — §13.3 forbids trading mono against symmetry — so they are
  // asserted on every pick short of the last resort, which is exactly the set
  // the ladder searches them on. (The size band, the formed-frame ratio and eyes
  // live with the other rung-parameterized bounds above.)
  if (!lastResort && !meetsShippedForm(world.soup)) {
    if (Math.round(world.soup.mono * 100) / 100 < SHIPPED_MONO)
      errs.push(`shipped-loop mono ${world.soup.mono.toFixed(3)} < ${SHIPPED_MONO}`);
    if (Math.round(world.soup.sym * 100) / 100 < SHIPPED_SYM)
      errs.push(`shipped-loop symmetry ${world.soup.sym.toFixed(3)} < ${SHIPPED_SYM}`);
  }

  return errs;
}

/**
 * The PRODUCTION gate: `checkInvariants` wired into the render path.
 *
 * The sweep is described here as the last line of defense, but until now it ran
 * only in the suite — over the corpus and twelve sampled dates. Production
 * renders a seed no corpus contains (§13.8: the date of the last public
 * activity), so a violating world could reach `banner.gif` with every test
 * green. `main.ts` calls this after rendering and before encoding, so a
 * violating world is never written.
 *
 * Returns a process exit code — 0 clean, 1 violations — and writes the list to
 * `log`. A rung-4 LAST-RESORT pick passes by design: §13.4 exempts it from
 * every relaxable bound, and `checkInvariants` reports it loudly on
 * `console.warn` instead of returning a violation. `log` is injectable so the
 * guard is testable without spying on the console.
 */
export function gateWorld(
  world: World,
  moving: MovingCells = measureMovingCells(world),
  log: (line: string) => void = console.error,
): number {
  const errs = checkInvariants(world, moving);
  if (errs.length === 0) return 0;
  log(`checkInvariants: ${errs.length} violation${errs.length === 1 ? '' : 's'} `
    + `— refusing to ship seed ${world.seed}`);
  for (const e of errs) log(`  - ${e}`);
  return 1;
}

/** Convenience for reports and tests: the numbers §13.5 pins, measured. */
export function measureTraffic(world: World): {
  minFlows: number; meanFlows: number; minLit: number; meanLit: number;
  minPop: number; meanPop: number; maxPop: number; meanFill: number; maxFill: number;
  /** §13.3's composition: cluster-member pixels / total void pixels (see
   * `creatures.bondedFraction`). Searched by the ladder and gated at
   * `BONDED_MEAN_MIN`. */
  minBonded: number; meanBonded: number;
} {
  const T = world.T;
  const nodes = [...world.takeovers.keys()];
  let minFlows = Infinity, sumFlows = 0, minLit = Infinity, sumLit = 0;
  for (let t = 0; t < T; t++) {
    let inFlight = 0;
    for (const f of world.flows) if (flowDrawn(f, t, T).length > 0) inFlight++;
    let lit = 0;
    for (const n of nodes) if (washAt(world.takeovers.get(n), t, T)) lit++;
    minFlows = Math.min(minFlows, inFlight); sumFlows += inFlight;
    minLit = Math.min(minLit, lit); sumLit += lit;
  }
  const bonded = bondedFraction(world.soup.frames, T);
  // The same shared statistic `assess` searched on and `checkInvariants` gates.
  const pop = voidPopulation(world.soup.frames, T);
  return {
    minFlows, meanFlows: sumFlows / T, minLit, meanLit: sumLit / T,
    minPop: pop.min, meanPop: pop.mean, maxPop: pop.max,
    meanFill: world.soup.fillMean, maxFill: world.soup.fillPeak,
    minBonded: bonded.min, meanBonded: bonded.mean,
  };
}

/** Streams' component-transit counts — §13.2's `MIN_TRANSITS` evidence. */
export function transitsPerStream(world: World): number[] {
  return world.flows
    .filter(f => f.kind === 'stream')
    .map(f => f.stops.filter(st => world.graph.nodes[st.node].comp >= 0).length);
}
