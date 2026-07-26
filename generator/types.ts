export interface Rect { x: number; y: number; w: number; h: number; }
export interface Cell { x: number; y: number; }

export type PadId = 'rna' | 'neural' | 'synbio' | 'om' | 'ai';

/** The §12.3 component vocabulary. One entry per sprite the renderer knows how
 * to draw; `layout.buildComponents` places them on §12.2's canonical floorplan. */
export type ComponentKind =
  | 'cpuSocket' | 'dimmSlot' | 'pcieSlot' | 'choke' | 'mosfet' | 'capBig' | 'capSmall'
  | 'coinCell' | 'heatsink' | 'fan' | 'qfp' | 'dipIC' | 'crystal' | 'header' | 'smd';

/**
 * One placed piece of populated hardware (spec §12.3).
 *
 * `body` is the sprite's own anchor rect; `rect` is the full footprint the
 * floorplan/gutter rule, the router and the graph are checked against — for
 * `qfp`/`dipIC` that includes the one-cell pin ring outside the body (§12.3),
 * for everything else it equals `body`.
 *
 * §13.2 retires §12.5's cascade and §12.6.1's recycle model: every populated
 * component sits at `LEVEL_LIT` in every frame, so the old `group` / `shared` /
 * `breather` scheduling fields have no referent and are gone. The only thing
 * that ever changes a component's appearance is the takeover wash.
 */
export interface BoardComponent {
  kind: ComponentKind;
  body: Rect;
  rect: Rect;
  accent?: string;
}

/** A 1px `#1a1a1a` silkscreen section outline with an optional 8px label
 * (§12.3, "Silkscreen section labels"). `outline: false` marks a label-only
 * entry (BT1/PCIE1/PCIE2 caption a component that draws its own silhouette),
 * in which case `rect` is only the label's anchor. */
export interface SilkSection { rect: Rect; label?: string; outline?: boolean; }

/** Seeded background board furniture (Revision 2 §11 "Board dressing"). */
export type DressingKind = 'footprint' | 'hatch' | 'fiducial' | 'testpoint';
export interface DressingFeature { kind: DressingKind; rect: Rect; designator?: string; }
export interface Dressing { features: DressingFeature[]; }

/** A connector finger on the board's right edge: 4 wide (layout.FINGER_W) × h tall. */
export interface Finger { x: number; y: number; h: number; band: number; index: number; }

/**
 * One routed net (§12.4's routing discipline, unchanged by §13).
 *
 * `spine` is the 1-cell centre line — the graph's edges are built from it, and
 * it is deliberately 2–3 cells clear of the components at either end. `cells` is
 * what the renderer paints: the spine widened to `weight` and extended by
 * §12.4's 4-cell landing overshoot under the body/gold it lands on.
 */
export interface Net { cells: Cell[]; spine: Cell[]; color: string; weight: number; }

/**
 * §13.1's interconnect graph. A node is a populated component (`comp` indexes
 * `World.components`) or a connector finger (`finger` indexes `layout.FINGERS`);
 * exactly one of the two is >= 0. An edge is a net spine of >= 4 cells attached
 * to the nearest node within 8 cells of each end.
 *
 * The node set is deliberately NOT connected: most of §12.3's parts are
 * furniture with no routed net touching them and stay isolated by design. The
 * requirement is on the routed island only (§13.1).
 */
export interface GraphNode { center: Cell; comp: number; finger: number; }
export interface GraphEdge { a: number; b: number; cells: Cell[]; }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; adj: number[][]; }

export type FlowKind = 'courier' | 'stream' | 'interior';

/** Where a flow's walk crossed a node, as a slot index into `Flow.slots`. */
export interface FlowStop { at: number; node: number; }

/**
 * §13.2's slot-exact flow. `slots` has exactly `T * SLOTS_PER_FRAME` entries —
 * one cell per slot, or null where the flow is not on the board — so a courier's
 * final cell and its stream's first cell can occupy the *same* slot and the
 * handoff is causal by construction.
 *
 * `thread` weaves the feeding courier's colour into the first stretch of the
 * stream's tail, so the merge reads as absorption rather than as two adjacent
 * flows.
 */
export interface Flow {
  kind: FlowKind;
  slots: (Cell | null)[];
  trail: number;
  color: string;
  stops: FlowStop[];
  thread?: { from: number; to: number; color: string };
}

/** A stream reaching its gold finger: the finger flashes for 10 frames, and the
 * void's release schedule (§13.3) hangs off these. */
export interface EscapeEvent { frame: number; finger: number; color: string; }

/**
 * §13.2's component takeover, derived from drawn geometry: the run of slots
 * where a flow's own cells lie inside a component's rect, extended by the trail
 * so the part stays lit until the last trail cell has left.
 */
export interface Takeover { frame: number; hold: number; color: string; }

// ---------------------------------------------------------------------------
// §13.3 — the zero-g soup
// ---------------------------------------------------------------------------

/**
 * ONE particle type, one integrator (§13.3). A particle that has bonded simply
 * carries a cluster id, a lattice slot and a bond strength easing 0 → 1; the
 * only difference in its physics is an added spring toward its slot and
 * proportionally damped jitter. Being part of a body is a matter of degree.
 */
export interface Particle {
  x: number; y: number; vx: number; vy: number;
  /** colour index into the accent list */
  c: number;
  /** emission trail, in seconds */
  streak: number;
  /** -1 while unattached */
  cluster: number;
  /** lattice slot, in cluster-local cells */
  sx: number; sy: number;
  /** 0..1, eases in — spring stiffness and jitter damping scale with it */
  bond: number;
  /** 0..1 eyeness, eases in late; a blink eases it back down at draw time */
  eye: number;
}

export interface Cluster {
  id: number; x: number; y: number; vx: number; vy: number;
  /** slow zero-g tumble */
  theta: number; omega: number;
  n: number; maturity: number;
  /** 0..1, how strongly the 12-row anatomy is shaping growth */
  form: number;
  /** the body's own anatomical frame, fixed the moment form engages */
  originSy: number; half: number; anchored: boolean;
  blink: number;
  dominant: number;
  /** mirror axis, doubled so it can fall between slot columns */
  axis2: number;
  mono: number; sym: number; formed: boolean;
}

/** A pixel stuck to the board's own interface, with a dwell so the crust is an
 * equilibrium rather than an accumulator (§13.3). */
export interface Crust { x: number; y: number; c: number; born: number; dwell: number; }

export interface SoupState { parts: Particle[]; clusters: Cluster[]; crust: Crust[]; }

/** One assessed generation arc. */
export interface SoupRun {
  frames: SoupState[];
  peak: number; peakAt: number;
  /** per-loop-frame totals over the visible ages; the ladder searches on
   * `minPop`/`maxPop`, which is the statistic §13.5's sweep gates. */
  meanPop: number; minPop: number; maxPop: number; meanBodies: number;
  eyes: boolean; empty: boolean; tailEmptyFrom: number;
  formedFrames: number; mono: number; sym: number;
  /** frames whose biggest body is >= `FORMED_MIN` — the denominator of §13.3's
   * formed-frame expectation, which the ladder searches on. */
  ripeFrames: number;
  /** §13.3's composition: cluster-member pixels / total void pixels, over the
   * loop's visible ages. The ladder searches on `bondedMean`. */
  bondedMean: number; bondedMin: number;
  /** §13.5's void fill: distinct occupied void cells / `VOID_CELLS`, over the
   * loop's visible ages. The ladder searches on both. */
  fillMean: number; fillPeak: number;
  /** §13.3's whole-width read: the worst void quarter's share of loop frames in
   * which it holds fewer than `BARE_QUARTER_CELLS` distinct occupied cells. */
  bareQuarter: number;
}

/** The arc the relaxation ladder (§13.4) settled on. */
export interface SoupPick extends SoupRun {
  candidate: number; subSeed: number; qualified: boolean; rung: number; sims: number;
}

export interface World {
  seed: number; T: number;
  /** the seed's permutation of the five accents (§12.8) */
  accents: string[];
  components: BoardComponent[]; sections: SilkSection[]; dressing: Dressing; mountHoles: Cell[];
  nets: Net[]; graph: Graph;
  /** §13.1's neutral `#444444` interconnect, one canonical stub per node/edge incidence */
  fabric: Cell[];
  flows: Flow[]; events: EscapeEvent[];
  /** node index -> the takeovers that node undergoes over one loop */
  takeovers: Map<number, Takeover[]>;
  soup: SoupPick;
  /** arc length in frames: `SOUP.COPIES * T` */
  arc: number;
}
