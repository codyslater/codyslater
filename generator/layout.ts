import type {
  BoardComponent, Cell, ComponentKind, Dressing, DressingFeature, Finger, Graph, GraphNode, Net,
  PadId, Rect, SilkSection,
} from './types.js';
import { pick, randInt, type Rng } from './rng.js';

export const CELL = 4;
export const GRID_W = 300;
export const GRID_H = 80;
export const WIDTH = GRID_W * CELL;   // 1200
export const HEIGHT = GRID_H * CELL;  // 320

// Board substrate occupies x∈[2,230]; the remaining strip x∈(230,300] is off-board void.
export const BOARD_RIGHT = 230;
export const VOID_BG = '#060606';

// Sanctioned connector-gold palette addition (used nowhere else).
export const GOLD = '#8a7a2f';
export const GOLD_LIT = '#d4b83a';

export const COLORS = {
  bg: '#0a0a0a', grid: '#111111', surface: '#1a1a1a',
  edge: '#222222', dim: '#444444', muted: '#888888',
  offwhite: '#f0f0f0', white: '#ffffff',
} as const;

/** §13.1's gray fabric: the board's ordinary interconnect, dimmer than any
 * active colour and brighter than the `#0e0e0e`–`#222222` dressing. */
export const FABRIC_COLOR = COLORS.dim;

// Board dressing (Revision 2 §11 "Board dressing", binding): a defined board
// outline (2px outer edge + inner silkscreen keepout line) and seeded background
// furniture, drawn beneath the living layer in near-invisible grays.
export const BOARD_EDGE = '#2a2a2a';   // outer 2px board-outline stroke
export const BOARD_KEEPOUT = '#1a1a1a'; // inner silkscreen keepout line
export const DRESSING_COLORS = {
  hatch: '#0e0e0e',
  outline: '#181818',
  pin: '#1c1c1c',
  ring: '#1a1a1a',
  designator: '#1c1c1c',
} as const;

export const ACCENTS: Record<PadId, string> = {
  rna: '#ff2d78', neural: '#39ff14', synbio: '#bf5af2', om: '#00e5ff', ai: '#ff6a00',
};

/** The five accents in declaration order. §12.8's seeded variation is which
 * accent each fixture draws, via `Layout.accents` (a seeded permutation). */
export const ACCENT_LIST: string[] = (Object.keys(ACCENTS) as PadId[]).map(id => ACCENTS[id]);

// §12.7's name treatment, carried by §13.5: board legend, not a shell prompt.
export const NAME = 'cody_slater';
// Retired from the legend by §13.5 (Cody, 2026-07-25: "get rid of tag line and
// details, just put rev on left side of board") and drawn nowhere in production.
// Retained as exports only because the throwaway calibration prototypes
// (`proto-portrait.ts`) still reference them and must keep compiling.
export const THESIS = 'growing technology from biology';
export const THESIS_FONT_PX = 11;
export const CREDENTIALS = 'MD/PhD · engineer · scientist';

export const BOARD = { inset: 2 } as const; // board-edge line, in cells from the frame

// Exclusion zones in cells. §13.5 as amended 2026-07-25: NAME_ZONE carries the
// name and REV_ZONE carries the REV line again (Cody: "can we move rev to right
// side of board"), so REV_ZONE is a LIVE text zone once more. THESIS_ZONE stays
// retired as text and remains — like both its neighbours — a BINDING EXCLUSION
// MASK at its existing geometry, for traces, fabric, dressing and components.
export const NAME_ZONE: Rect = { x: 2, y: 66, w: 78, h: 12 };
export const THESIS_ZONE: Rect = { x: 80, y: 66, w: 54, h: 12 };
export const REV_ZONE: Rect = { x: 134, y: 66, w: 96, h: 12 };
export const TEXT_ZONES: Rect[] = [NAME_ZONE, THESIS_ZONE, REV_ZONE];

// §13.5's legend geometry, AMENDED 2026-07-25 at Cody's gate: "can we move rev
// to right side of board." The legend is no longer a stack in the bottom-left
// corner — it is the two ends of ONE printed line, which is how a real board
// carries its manufacturer mark and its revision.
//
//   * name  `cody_slater` — 15 px, LEFT-aligned at NAME_ZONE.x + 9 cells (36 px
//     inside the zone; the inset clears the (6, 74) mount hole's keepout circle).
//   * REV   `REV <YYYY.MM.DD>` — 11 px, RIGHT-aligned, ending 2 cells (8 px)
//     inside REV_ZONE's right edge, which IS the board edge x = 230.
//
// Both sit on ONE shared baseline 22 px below the band's top edge (the two zones
// share y = 66), restoring §12.7's "same colour, same weight, same baseline,
// with size the only hierarchy" at §13.5's sizes. Both #888888.
export const NAME_X_PX = (NAME_ZONE.x + 9) * CELL;
export const NAME_FONT_PX = 15;
export const NAME_BASELINE_PX = 22;
export const REV_FONT_PX = 11;
export const REV_BASELINE_PX = 22;
/**
 * The REV line's RIGHT edge — 2 cells inside REV_ZONE's right edge, i.e. inside
 * the board, never in the void (which starts beyond x = 230).
 *
 * The bottom-right corner is clear by construction: §12.4's right-hand mount
 * holes sit at (222, 21) and (222, 42), and the connector fingers stop at y = 58
 * — both far above this band at y 66-78. No keepout to dodge.
 */
export const REV_RIGHT_PX = (REV_ZONE.x + REV_ZONE.w - 2) * CELL;

// Connector fingers: fixed width, sit on the board edge x∈[227,230].
export const FINGER_X = 227;
export const FINGER_W = 4;
export const FINGER_H = 3;
const FINGER_GROUP_STARTS = [6, 26, 46]; // one group per band, y-start of finger index 0

export const FINGERS: Finger[] = FINGER_GROUP_STARTS.flatMap((groupStart, band) =>
  [0, 1, 2].map((index): Finger => ({ x: FINGER_X, y: groupStart + index * 5, h: FINGER_H, band, index })),
);

/** The seeded floorplan knobs §12.8 lists — the router needs them verbatim, so
 * they are recorded rather than re-derived by searching the component list. */
export interface Floorplan {
  nChoke: number; chokePitch: number; cpu: Rect;
  dimmX: number; nDimm: number; nDram: number;
  qfpBig: Rect; qfp2: Rect;
}

export interface Layout {
  components: BoardComponent[];
  sections: SilkSection[];
  dressing: Dressing;
  mountHoles: Cell[];
  /** the seed's permutation of the five accents (§12.8) */
  accents: string[];
  floorplan: Floorplan;
}

// ---------------------------------------------------------------------------
// §12.2 canonical floorplan skeleton — fixed across seeds.
// ---------------------------------------------------------------------------
export const ROW_T: [number, number] = [5, 17];
export const GUTTER_1: [number, number] = [18, 22];
export const ROW_M: [number, number] = [23, 45];
export const GUTTER_2: [number, number] = [46, 49];
export const ROW_B: [number, number] = [50, 58];
export const GUTTER_3: [number, number] = [59, 63];
export const GUTTERS: [number, number][] = [GUTTER_1, GUTTER_2, GUTTER_3];
export const FIELD_X: [number, number] = [8, 196];
export const FANOUT_X: [number, number] = [198, 226];

/** §12.4's three hub QFPs, at their fixed coordinates. §13.1 retires the
 * *disjoint tree* they each used to head, but the hubs themselves — and every
 * other piece of §12.4's routing discipline — are carried unchanged. */
export const HUB_RECTS: Rect[] = [
  { x: 184, y: 6, w: 11, h: 11 },
  { x: 178, y: 26, w: 13, h: 13 },
  { x: 185, y: 51, w: 7, h: 7 },
];

/** The fan's own anchor (§12.3): seated inside the chipset heatsink's footprint. */
export const FAN_AT: Cell = { x: 68, y: 8 };

/**
 * Screw mount holes (§12.4): four fixed positions, no seeding. The right-hand
 * pair sits on the board's right edge *between* finger groups — a hole at the
 * board's top-right corner would sit squarely in finger group 0's only approach
 * lane and structurally seal it.
 */
export const MOUNT_HOLES: Cell[] = [
  { x: 6, y: 6 }, { x: 6, y: 74 }, { x: 222, y: 21 }, { x: 222, y: 42 },
];

const shuffleInPlace = <T>(rng: Rng, arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/** `qfp` and `dipIC` carry a one-cell pin ring outside the body; the footprint
 * the gutter rule, the router and the graph see includes it (§12.3). */
const footprintOf = (kind: ComponentKind, body: Rect): Rect =>
  kind === 'qfp' ? { x: body.x - 1, y: body.y - 1, w: body.w + 2, h: body.h + 2 }
    : kind === 'dipIC' ? { x: body.x - 1, y: body.y, w: body.w + 2, h: body.h }
      : kind === 'fan' ? { x: body.x - 1, y: body.y - 1, w: body.w + 2, h: body.h + 2 }
        : body;

/**
 * Places §12.3's component vocabulary on §12.2's canonical floorplan. Every
 * coordinate below is the spec's own; only the seeded counts vary (§12.8: VRM
 * chokes 5-6 with matching MOSFETs, DIMM slots 3-4, DRAM ICs 3-4, CPU socket y
 * = 24 + j for j ∈ {-1,0}), plus the accent permutation.
 */
export function buildComponents(rng: Rng, accents: string[]): {
  components: BoardComponent[]; sections: SilkSection[]; floorplan: Floorplan;
} {
  const components: BoardComponent[] = [];
  const sections: SilkSection[] = [];
  const put = (kind: ComponentKind, body: Rect, accent?: string): void => {
    components.push({ kind, body, rect: footprintOf(kind, body), accent });
  };

  // ---- row T: VRM, bulk caps, chipset + fan, flash, crystal, DRAM, logic ----
  const nChoke = randInt(rng, 5, 6);
  const chokePitch = nChoke === 6 ? 5 : 6;
  for (let i = 0; i < nChoke; i++) {
    put('choke', { x: 10 + i * chokePitch, y: 6, w: 4, h: 4 });
    put('mosfet', { x: 10 + i * chokePitch, y: 11, w: 3, h: 3 });
  }
  sections.push({ rect: { x: 8, y: 5, w: nChoke * chokePitch + 3, h: 12 }, label: 'VRM' });
  for (let i = 0; i < 3; i++) put('capBig', { x: 45 + i * 5, y: 6, w: 4, h: 4 });
  for (let i = 0; i < 3; i++) put('capSmall', { x: 45 + i * 5, y: 12, w: 3, h: 3 });

  put('heatsink', { x: 64, y: 5, w: 14, h: 12 }, accents[2]);
  sections.push({ rect: { x: 63, y: 4, w: 16, h: 14 }, label: 'U1' });
  put('dipIC', { x: 83, y: 6, w: 6, h: 11 }, accents[3]);
  put('dipIC', { x: 93, y: 6, w: 6, h: 11 }, accents[3]);
  put('crystal', { x: 103, y: 6, w: 4, h: 2 });
  for (let i = 0; i < 3; i++) put('capSmall', { x: 103 + i * 4, y: 10, w: 3, h: 3 });
  put('smd', { x: 103, y: 15, w: 4, h: 2 });
  put('smd', { x: 109, y: 15, w: 4, h: 2 });

  const nDram = randInt(rng, 3, 4);
  for (let i = 0; i < nDram; i++) put('dipIC', { x: 120 + i * 10, y: 6, w: 7, h: 11 }, accents[1]);
  sections.push({ rect: { x: 118, y: 5, w: nDram * 10 + 1, h: 13 } });
  put('dipIC', { x: 163, y: 6, w: 6, h: 11 }, accents[2]);
  put('dipIC', { x: 172, y: 6, w: 6, h: 11 }, accents[4]);
  put('qfp', HUB_RECTS[0], accents[0]);

  // ---- row M: CPU socket, DIMM bank, coin cell, bridges, headers -----------
  const cpu: Rect = { x: 10, y: 24 + randInt(rng, -1, 0), w: 26, h: 21 };
  put('cpuSocket', cpu, accents[0]);
  sections.push({ rect: { x: cpu.x - 1, y: cpu.y - 1, w: cpu.w + 2, h: cpu.h + 2 }, label: 'CPU1' });

  const nDimm = randInt(rng, 3, 4);
  const dimmX = 46;
  for (let i = 0; i < nDimm; i++) put('dimmSlot', { x: dimmX + i * 6, y: 24, w: 3, h: 21 }, accents[1]);
  sections.push({ rect: { x: dimmX - 1, y: 23, w: nDimm * 6, h: 23 }, label: 'DIMM' });

  put('coinCell', { x: 72, y: 26, w: 6, h: 6 });
  sections.push({ rect: { x: 72, y: 26, w: 0, h: 0 }, label: 'BT1', outline: false });
  for (let i = 0; i < 4; i++) put('capSmall', { x: 72 + (i % 2) * 4, y: 34 + Math.floor(i / 2) * 4, w: 3, h: 3 });

  const qfpBig: Rect = { x: 85, y: 26, w: 16, h: 16 };
  put('qfp', qfpBig, accents[4]);
  put('header', { x: 105, y: 26, w: 13, h: 6 });
  for (let i = 0; i < 6; i++) put('capSmall', { x: 105 + (i % 3) * 4, y: 34 + Math.floor(i / 3) * 4, w: 3, h: 3 });

  const qfp2: Rect = { x: 125, y: 27, w: 12, h: 12 };
  put('qfp', qfp2, accents[3]);
  for (let i = 0; i < 4; i++) put('smd', { x: 141 + (i % 2) * 6, y: 27 + Math.floor(i / 2) * 3, w: 5, h: 2 });
  put('crystal', { x: 141, y: 34, w: 4, h: 2 });
  put('dipIC', { x: 156, y: 26, w: 6, h: 11 }, accents[1]);
  put('dipIC', { x: 165, y: 26, w: 6, h: 11 }, accents[1]);
  put('qfp', HUB_RECTS[1], accents[2]);

  // ---- row B: passive field, expansion slots, headers, I/O logic -----------
  for (let i = 0; i < 9; i++) put('capSmall', { x: 10 + i * 4, y: 50, w: 3, h: 3 });
  for (let i = 0; i < 4; i++) {
    put('smd', { x: 48 + i * 9, y: 50, w: 5, h: 2 });
    put('capSmall', { x: 54 + i * 9, y: 50, w: 3, h: 3 });
  }
  put('pcieSlot', { x: 10, y: 55, w: 72, h: 4 }, accents[3]);
  sections.push({ rect: { x: 10, y: 55, w: 0, h: 0 }, label: 'PCIE1', outline: false });
  put('pcieSlot', { x: 88, y: 55, w: 56, h: 4 }, accents[3]);
  sections.push({ rect: { x: 88, y: 55, w: 0, h: 0 }, label: 'PCIE2', outline: false });
  put('header', { x: 88, y: 50, w: 14, h: 4 });
  put('header', { x: 105, y: 50, w: 14, h: 4 });
  put('header', { x: 150, y: 53, w: 16, h: 6 });
  for (let i = 0; i < 4; i++) put('smd', { x: 150 + (i % 2) * 6, y: 50 + Math.floor(i / 2) * 3, w: 5, h: 2 });
  put('dipIC', { x: 172, y: 50, w: 6, h: 9 }, accents[4]);
  put('qfp', HUB_RECTS[2], accents[3]);

  // ---- fanout-zone furniture: only the dead lanes between finger groups ----
  for (let i = 0; i < 3; i++) {
    put('smd', { x: 200 + i * 6, y: 21, w: 4, h: 2 });
    put('smd', { x: 200 + i * 6, y: 43, w: 4, h: 2 });
  }

  // The fan is seated inside the chipset heatsink's already-placed footprint —
  // zero floorplan cost (§12.3) — and pushed last so it draws over it.
  put('fan', { x: FAN_AT.x, y: FAN_AT.y, w: 6, h: 6 }, accents[2]);

  return { components, sections, floorplan: { nChoke, chokePitch, cpu, dimmX, nDimm, nDram, qfpBig, qfp2 } };
}

export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const inRect = (x: number, y: number, r: Rect): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export const cellRect = (z: Rect): [number, number, number, number] =>
  [z.x * CELL, z.y * CELL, z.w * CELL, z.h * CELL];

export function revFromSeed(seed: number): string {
  const s = String(seed);
  if (!/^\d{8}$/.test(s)) throw new Error(`seed must be YYYYMMDD, got ${seed}`);
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    throw new Error(`seed is not a valid date: ${seed}`);
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// Board dressing
// ---------------------------------------------------------------------------
const DRESSING_X_MIN = 4, DRESSING_X_MAX = 226;
const DRESSING_Y_MIN = 4, DRESSING_Y_MAX = 64;

interface FootprintPreset { w: number; h: number; prefix: string; }
const FOOTPRINT_PRESETS: FootprintPreset[] = [
  { w: 3, h: 5, prefix: 'U' },
  { w: 4, h: 1, prefix: 'R' },
  { w: 2, h: 2, prefix: 'C' },
];

const distToRectXY = (x: number, y: number, r: Rect): number =>
  Math.max(Math.max(r.x - x, 0, x - (r.x + r.w - 1)), Math.max(r.y - y, 0, y - (r.y + r.h - 1)));

function clearOfHardware(rect: Rect, components: BoardComponent[], margin: number): boolean {
  const padded: Rect = { x: rect.x - margin, y: rect.y - margin, w: rect.w + 2 * margin, h: rect.h + 2 * margin };
  if (components.some(c => overlaps(padded, c.rect))) return false;
  if (TEXT_ZONES.some(z => overlaps(rect, z))) return false;
  if (MOUNT_HOLES.some(h => distToRectXY(h.x, h.y, rect) < 4)) return false;
  return true;
}

function placeFeature(
  rng: Rng, w: number, h: number, components: BoardComponent[], placed: Rect[], attempts: number,
): Rect | null {
  for (let a = 0; a < attempts; a++) {
    const x = randInt(rng, DRESSING_X_MIN, DRESSING_X_MAX - w);
    const y = randInt(rng, DRESSING_Y_MIN, DRESSING_Y_MAX - h);
    const rect: Rect = { x, y, w, h };
    if (!clearOfHardware(rect, components, 1)) continue;
    if (placed.some(r => overlaps(rect, r))) continue;
    return rect;
  }
  return null;
}

function buildDressing(rng: Rng, components: BoardComponent[]): Dressing {
  const features: DressingFeature[] = [];
  const placedSmall: Rect[] = [];

  for (let i = 0; i < randInt(rng, 2, 3); i++) {
    const w = randInt(rng, 10, 20), h = randInt(rng, 4, 8);
    const rect = placeFeature(rng, w, h, components, [], 60);
    if (rect) features.push({ kind: 'hatch', rect });
  }
  for (let i = 0; i < randInt(rng, 6, 10); i++) {
    const preset = pick(rng, FOOTPRINT_PRESETS);
    const rect = placeFeature(rng, preset.w, preset.h, components, placedSmall, 80);
    if (!rect) continue;
    placedSmall.push(rect);
    features.push({ kind: 'footprint', rect, designator: `${preset.prefix}${randInt(rng, 1, 99)}` });
  }
  for (let i = 0; i < randInt(rng, 3, 5); i++) {
    const rect = placeFeature(rng, 3, 3, components, placedSmall, 80);
    if (!rect) continue;
    placedSmall.push(rect);
    features.push({ kind: 'fiducial', rect });
  }
  for (let i = 0; i < randInt(rng, 4, 6); i++) {
    const rect = placeFeature(rng, 3, 3, components, placedSmall, 80);
    if (!rect) continue;
    placedSmall.push(rect);
    features.push({ kind: 'testpoint', rect });
  }
  return { features };
}

/**
 * The whole static board, from one continuous rng stream: the accent
 * permutation (§12.8), then §12.2/§12.3's canonical floorplan, then background
 * dressing. Mount holes are fixed (§12.4) and draw nothing from the stream.
 * Routing is a pure function of this layout (see `growth.buildNets`).
 */
export function buildLayout(rng: Rng): Layout {
  const accents = shuffleInPlace(rng, [...ACCENT_LIST]);
  const { components, sections, floorplan } = buildComponents(rng, accents);
  const dressing = buildDressing(rng, components);
  return { components, sections, dressing, mountHoles: MOUNT_HOLES, accents, floorplan };
}

// ---------------------------------------------------------------------------
// §13.1 — canonical walk geometry, shared by the fabric and by every flow.
//
// "Because the *same function* decides where a walk steps and where the fabric
// is drawn, [the on-copper invariant] holds by construction rather than by
// patching." Everything in this section is that same function.
// ---------------------------------------------------------------------------

/** Rectilinear cells from `from` (exclusive) to `to` (inclusive). */
export function segment(from: Cell, to: Cell, xFirst: boolean): Cell[] {
  const out: Cell[] = [];
  let { x, y } = from;
  const stepX = (): void => { while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, y }); } };
  const stepY = (): void => { while (y !== to.y) { y += Math.sign(to.y - y); out.push({ x, y }); } };
  if (xFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  return out;
}

/** The canonical stub: cells from an edge's spine endpoint into its node's
 * centre. CANONICAL matters — the same function decides where a flow walks and
 * where the gray fabric is drawn, so a transit can never step off drawn copper. */
export const stubPath = (p: Cell, c: Cell): Cell[] =>
  segment(p, c, Math.abs(c.x - p.x) >= Math.abs(c.y - p.y));

/** spine-end → component centre → next spine-start, as contiguous cells: §13.1's
 * through-path, so a walk entering a component leaves by a different pin. */
export function transit(from: Cell, via: Cell, to: Cell): Cell[] {
  const inLeg = stubPath(from, via);
  const outLeg = [...stubPath(to, via)].reverse().slice(1);
  return [...inLeg, ...outLeg, { ...to }];
}

const distToRect = (p: Cell, r: Rect): number =>
  Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));

/** §13.1: attach a spine end to the nearest node within 8 cells. */
const ATTACH_RADIUS = 8;
/** §13.1: a net spine shorter than this is dressing, not an edge. */
const MIN_EDGE_SPINE = 4;

/**
 * §13.1's interconnect graph. Nodes: every populated component (its rect) plus
 * each of the nine connector fingers. Edges: every routed net spine of >= 4
 * cells, attached to the nearest node within 8 cells of each end.
 *
 * Not every node is wired, and that is the design — most of §12.3's parts are
 * furniture and stay isolated. The requirement (checked by
 * `timeline.checkInvariants`) is on the routed island only.
 */
export function buildGraph(components: BoardComponent[], nets: Net[]): Graph {
  const nodes: GraphNode[] = components.map((c, i) => ({
    center: { x: c.rect.x + (c.rect.w >> 1), y: c.rect.y + (c.rect.h >> 1) }, comp: i, finger: -1,
  }));
  FINGERS.forEach((f, i) => nodes.push({ center: { x: f.x + 1, y: f.y + 1 }, comp: -1, finger: i }));

  const nearest = (p: Cell): number => {
    let best = -1, bestD = ATTACH_RADIUS;
    nodes.forEach((n, i) => {
      const d = n.comp >= 0
        ? distToRect(p, components[n.comp].rect)
        : Math.max(Math.abs(p.x - n.center.x), Math.abs(p.y - n.center.y));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  const edges: Graph['edges'] = [];
  for (const net of nets) {
    if (net.spine.length < MIN_EDGE_SPINE) continue;
    const a = nearest(net.spine[0]), b = nearest(net.spine[net.spine.length - 1]);
    if (a < 0 || b < 0 || a === b) continue;
    edges.push({ a, b, cells: net.spine });
  }
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  return { nodes, edges, adj };
}

// ---------------------------------------------------------------------------
// §13.1's routed island — ONE definition, used by the frame sweep and by
// growth.test.ts, so "the routed island" means the same thing in both.
// ---------------------------------------------------------------------------

/** §13.1's binding island bounds: "one connected island containing all nine
 * connector fingers and >= 20 component nodes, whose simple cycle rank is >= 3",
 * with "every one of them reachable from >= 20 component nodes". Measured on the
 * corpus and a decade of sampled dates: 26-27 component nodes, cycle rank 3. */
export const ISLAND_MIN_COMPONENTS = 20;
export const ISLAND_MIN_CYCLE_RANK = 3;

/** The connected components of the node graph, and which one each node is in. */
export function graphIslands(g: Graph): { of: number[]; count: number } {
  const of = g.nodes.map(() => -1);
  let count = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    if (of[i] >= 0) continue;
    const q = [i];
    of[i] = count;
    for (let h = 0; h < q.length; h++)
      for (const ei of g.adj[q[h]]) {
        const o = g.edges[ei].a === q[h] ? g.edges[ei].b : g.edges[ei].a;
        if (of[o] < 0) { of[o] = count; q.push(o); }
      }
    count++;
  }
  return { of, count };
}

/**
 * §13.1's island shape, measured. `cycleRank` is counted on the SIMPLE graph —
 * "a bundle's parallel wires are one lane, and counting them separately would
 * fake alternative routes" — hence the dedup of `{min,max}` node pairs.
 */
export function islandShape(g: Graph): {
  fingers: number; fingerIslands: number; compNodes: number; cycleRank: number; minFingerReach: number;
} {
  const { of } = graphIslands(g);
  const fingers = g.nodes.map((n, i) => ({ i, f: n.finger })).filter(x => x.f >= 0);
  if (!fingers.length) return { fingers: 0, fingerIslands: 0, compNodes: 0, cycleRank: -1, minFingerReach: 0 };
  const island = of[fingers[0].i];
  const V = g.nodes.filter((_, i) => of[i] === island).length;
  const E = new Set(g.edges.filter(e => of[e.a] === island)
    .map(e => `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`)).size;
  let minFingerReach = Infinity;
  for (const { i } of fingers) {
    const seen = g.nodes.map(() => false);
    seen[i] = true;
    const q = [i];
    for (let h = 0; h < q.length; h++)
      for (const ei of g.adj[q[h]]) {
        const o = g.edges[ei].a === q[h] ? g.edges[ei].b : g.edges[ei].a;
        if (!seen[o]) { seen[o] = true; q.push(o); }
      }
    minFingerReach = Math.min(minFingerReach, g.nodes.filter((n, j) => n.comp >= 0 && seen[j]).length);
  }
  return {
    fingers: fingers.length,
    fingerIslands: new Set(fingers.map(x => of[x.i])).size,
    compNodes: g.nodes.filter((n, i) => n.comp >= 0 && of[i] === island).length,
    cycleRank: E - V + 1,
    minFingerReach,
  };
}

/** Cells of edge `ei` oriented so they start at node `from`. */
export const orientEdge = (g: Graph, ei: number, from: number): Cell[] =>
  g.edges[ei].a === from ? g.edges[ei].cells : [...g.edges[ei].cells].reverse();

/**
 * §13.1's gray fabric: for EVERY node/edge incidence, the same canonical stub
 * `stubPath(endpoint, node centre)` that `transit()` and `pushInto()` use. Drawn
 * in `#444444`, beneath the hardware and never over a live trace.
 */
export function fabricCells(g: Graph): Cell[] {
  const out: Cell[] = [];
  for (const e of g.edges) {
    if (!e.cells.length) continue;
    const ends: [number, Cell][] = [[e.a, e.cells[0]], [e.b, e.cells[e.cells.length - 1]]];
    for (const [node, endpoint] of ends)
      out.push({ ...endpoint }, ...stubPath(endpoint, g.nodes[node].center));
  }
  return out;
}
