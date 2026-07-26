import type { Cell, World } from './types.js';
import { BOARD_RIGHT } from './layout.js';
import { SLOTS_PER_FRAME, flowDrawn, washAt } from './signals.js';
import { copperCells } from './timeline.js';

// ---------------------------------------------------------------------------
// continuity.ts — §13.6's five continuity checks, as production code rather than
// as a prototype diagnostic.
//
// Cody: "can you check all the colored lines though and make sure no
// discontinuities". Eyeballing a 288-frame loop cannot prove that, so this is a
// checker. All five must report ZERO defects across the seed corpus.
//
//   A  every static copper run is one 8-connected set of cells end to end
//   B  every flow's slot array steps by at most one cell — a flow can never
//      teleport, at a chamfer, a junction, a component, or across the wrap
//   C  every flow's DRAWN cells in a given frame form one 8-connected run, so no
//      head or trail fragment is ever orphaned from its own comet
//   D  no flow-in-component event passes through a DARK part
//   E  every flow cell on the board is on drawn copper
//
// B is the strong invariant: if consecutive slots are always adjacent then C
// follows for any trail length, at any frame, including the wrap. C is still
// checked directly because it is what a viewer actually sees.
// ---------------------------------------------------------------------------

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const cheb = (a: Cell, b: Cell): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Number of 8-connected components in a cell set. */
export function islandsOf(cells: readonly Cell[]): number {
  const pool = new Set(cells.map(p => `${p.x},${p.y}`));
  let n = 0;
  while (pool.size) {
    const start = pool.values().next().value as string;
    pool.delete(start);
    const ci = start.indexOf(',');
    const q: Cell[] = [{ x: Number(start.slice(0, ci)), y: Number(start.slice(ci + 1)) }];
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

export interface ContinuityReport {
  /** A — nets whose drawn cells are not one 8-connected set. */
  brokenNets: number;
  /** B — consecutive slot pairs more than one cell apart. */
  slotJumps: number;
  worstJump: number;
  /** C — (flow, frame) pairs whose drawn cells fragment. */
  fragmentedFrames: number;
  worstFragments: number;
  /** D — flow-in-component events, and how many crossed a dark part. */
  transitEvents: number;
  darkTransits: number;
  /** D — lit in another flow's colour: contested, allowed and expected. */
  contestedTransits: number;
  /** E — distinct on-board flow cells, and how many sat off copper. */
  onCopper: number;
  offCopper: number;
  /** The gated total: A + B + C + D(dark) + E(off). */
  defects: number;
}

/** Runs all five checks over a whole loop. */
export function checkContinuity(world: World): ContinuityReport {
  const T = world.T, N = T * SLOTS_PER_FRAME;

  // --- A: static copper ----------------------------------------------------
  let brokenNets = 0;
  for (const net of world.nets) if (islandsOf(net.cells) !== 1) brokenNets++;

  // --- B: flow slot adjacency ---------------------------------------------
  let slotJumps = 0, worstJump = 0;
  for (const f of world.flows) {
    let prev: Cell | null = null;
    for (let k = 0; k <= N; k++) {
      const p = f.slots[k % N];
      if (!p) { prev = null; continue; }
      if (prev) {
        const d = cheb(prev, p);
        if (d > 1) { slotJumps++; worstJump = Math.max(worstJump, d); }
      }
      prev = p;
    }
  }

  // --- C: per-frame drawn contiguity --------------------------------------
  let fragmentedFrames = 0, worstFragments = 0;
  for (let t = 0; t < T; t++)
    for (const f of world.flows) {
      const cells = flowDrawn(f, t, T);
      if (cells.length < 2) continue;
      const k = islandsOf(cells);
      if (k > 1) { fragmentedFrames++; worstFragments = Math.max(worstFragments, k); }
    }

  // --- D: transit lighting -------------------------------------------------
  // The perceptual check a cell checker usually cannot do: whenever a flow's
  // cells are inside a component's footprint, that component must be lit. A
  // signal sliding through a dark chip is exactly the "jumping a component it
  // should pass through" failure, and it is measurable.
  // Cell -> the node indices whose footprint covers it. Footprints overlap (a fan
  // seated on a heatsink, a QFP's pin ring reaching under its neighbour), so a
  // cell can belong to more than one — taking only the first match would leave
  // the other part apparently dark.
  const nodesAtCell = new Map<string, number[]>();
  world.graph.nodes.forEach((n, i) => {
    if (n.comp < 0) return;
    const r = world.components[n.comp].rect;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const k = `${x},${y}`;
        nodesAtCell.set(k, [...(nodesAtCell.get(k) ?? []), i]);
      }
  });
  let transitEvents = 0, darkTransits = 0, contestedTransits = 0;
  for (let t = 0; t < T; t++)
    for (const f of world.flows) {
      const cells = flowDrawn(f, t, T);
      const touched = new Set<number>();
      for (const p of cells) for (const i of nodesAtCell.get(`${p.x},${p.y}`) ?? []) touched.add(i);
      for (const i of touched) {
        transitEvents++;
        const w = washAt(world.takeovers.get(i), t, T);
        if (!w) darkTransits++;
        else if (w.color !== f.color) contestedTransits++;
      }
    }

  // --- E: everything travels on drawn copper ------------------------------
  const copper = copperCells(world);
  let onCopper = 0, offCopper = 0;
  for (const f of world.flows) {
    const seen = new Set<string>();
    for (const p of f.slots) {
      if (!p || p.x > BOARD_RIGHT) continue;
      const k = `${p.x},${p.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (copper.has(k)) onCopper++; else offCopper++;
    }
  }

  return {
    brokenNets, slotJumps, worstJump, fragmentedFrames, worstFragments,
    transitEvents, darkTransits, contestedTransits, onCopper, offCopper,
    defects: brokenNets + slotJumps + fragmentedFrames + darkTransits + offCopper,
  };
}

/** One-line summary for reports. */
export const formatContinuity = (r: ContinuityReport): string =>
  `A ${r.brokenNets} broken nets | B ${r.slotJumps} slot jumps | C ${r.fragmentedFrames} fragmented flow-frames | `
  + `D ${r.transitEvents} transit events, ${r.darkTransits} dark (${r.contestedTransits} contested) | `
  + `E ${r.onCopper + r.offCopper} on-board cells, ${r.offCopper} off copper => ${r.defects} defects`;
