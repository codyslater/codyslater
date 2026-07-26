import type { SKRSContext2D } from '@napi-rs/canvas';
import { CELL, COLORS } from './layout.js';
import type { BoardComponent, Cell } from './types.js';

// ---------------------------------------------------------------------------
// §12.3 component vocabulary — the pixel-art motherboard sprites, drawn through
// §12.5's three-rung tone ladder.
//
// Every sprite is cell-aligned with hard edges (§3, unchanged). The geometry
// here is the approved portrait's (`docs/superpowers/specs/assets/
// portrait-A-20260724.png`, produced by `generator/proto-portrait.ts`), re-stated
// against the production palette; the prototype is reference material and is
// never imported.
// ---------------------------------------------------------------------------

const px = (c: number): number => c * CELL;

export function cell(ctx: SKRSContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), CELL, CELL);
}
export function box(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), px(w), px(h));
}
/** `t`-cell-thick border drawn as four fills — hard cell edges, never a
 * sub-pixel stroke (§3: "all simulation art on integer cells with hard edges"). */
export function frame(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, color: string, t = 1): void {
  box(ctx, x, y, w, t, color);
  box(ctx, x, y + h - t, w, t, color);
  box(ctx, x, y + t, t, h - 2 * t, color);
  box(ctx, x + w - t, y + t, t, h - 2 * t, color);
}

/**
 * §12.5's connection-lighting ladder. Three rungs one palette step apart —
 * 0 unlit, 1 mid, 2 lit — addressable at half steps: at a half rung the DARK
 * roles (recess, lid, body) have already moved to the rung the transition is
 * heading for, while the BRIGHT roles (metal, bright) and the accent are still
 * on the rung it came from. A 1-rung move therefore occupies 2 frames and a
 * 2-rung move 4, and every value drawn is an existing palette entry. Never a
 * single-frame pop, never a gradient.
 *
 * That reading is DIRECTIONAL, which is why `tonesFor` needs to be told which
 * way the level is moving: on the way down (lit → mid) the destination rung is
 * `floor(level)`, but on the way up — the power-on cascade §12.5 exists for — it
 * is `ceil(level)`, and assigning the roles by floor/ceil alone silently runs
 * the ladder backwards for exactly the half of the transitions the spec is
 * about. At an integer level floor === ceil and the direction is moot.
 */
export interface Tones {
  recess: string; lid: string; body: string; metal: string; bright: string; accent: string | null;
}
export const LEVEL_UNLIT = 0, LEVEL_MID = 1, LEVEL_LIT = 2;
const RUNG: Omit<Tones, 'accent'>[] = [
  { recess: COLORS.bg, lid: COLORS.bg, body: COLORS.grid, metal: COLORS.surface, bright: COLORS.edge },
  { recess: COLORS.grid, lid: COLORS.grid, body: COLORS.surface, metal: COLORS.edge, bright: COLORS.dim },
  { recess: COLORS.grid, lid: COLORS.surface, body: COLORS.edge, metal: COLORS.dim, bright: COLORS.muted },
];

/** Accent at 60 % on the background — §12.1's pinned "ramp middle step, accent
 * detail" value. Duplicated from render.mixOnBg to keep this module free of a
 * circular import; both derive the same five pinned values. */
function mix60(hex: string): string {
  const n = parseInt(hex.slice(1), 16), b = parseInt(COLORS.bg.slice(1), 16);
  const m = (c: number, d: number): number => Math.round(c * 0.6 + d * 0.4);
  const r = m(n >> 16, b >> 16), g = m((n >> 8) & 255, (b >> 8) & 255), bl = m(n & 255, b & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

export function tonesFor(level: number, accent: string | null = null, rising = false): Tones {
  const v = Math.max(0, Math.min(LEVEL_LIT, level));
  const lo = RUNG[Math.floor(v)], hi = RUNG[Math.ceil(v)];
  // The rung the move is heading for (darks lead) and the one it came from
  // (brights and the accent lag).
  const dark = rising ? hi : lo;
  const bright = rising ? lo : hi;
  const brightRung = rising ? Math.floor(v) : Math.ceil(v);
  return {
    recess: dark.recess, lid: dark.lid, body: dark.body,
    metal: bright.metal, bright: bright.bright,
    accent: brightRung >= LEVEL_LIT ? accent : brightRung === LEVEL_MID && accent ? mix60(accent) : null,
  };
}

/** Accent-carrying detail with no gray fallback (DIMM latches, PCIe end latch,
 * spreader ring, pin-1 markers) renders in the level's `metal` tone when there
 * is no accent (§12.5). */
const acc = (T: Tones): string => T.accent ?? T.metal;

type Sprite = (ctx: SKRSContext2D, b: { x: number; y: number; w: number; h: number }, T: Tones) => void;

const SPRITES: Record<BoardComponent['kind'], Sprite> = {
  /** CPU socket: plastic frame + exposed pin-grid border + accent heat spreader. */
  cpuSocket: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 2, y + 2, w - 4, h - 4, T.recess);
    for (let iy = y + 3; iy < y + h - 3; iy += 2)
      for (let ix = x + 3; ix < x + w - 3; ix += 2) cell(ctx, ix, iy, T.metal);
    const m = 5, hx = x + m, hy = y + m, hw = w - 2 * m, hh = h - 2 * m;
    box(ctx, hx, hy, hw, hh, T.metal);
    frame(ctx, hx, hy, hw, hh, acc(T), 1);
    frame(ctx, hx + 2, hy + 2, hw - 4, hh - 4, T.bright, 1);
    box(ctx, hx + 3, hy + 3, hw - 6, hh - 6, T.body);
    box(ctx, x + 1, y + 1, 2, 2, acc(T)); // pin-1 marker
  },
  /** Vertical DIMM slot: dark body, contact column, accent latches, keying notch. */
  dimmSlot: (ctx, { x, y, h }, T) => {
    box(ctx, x, y, 3, h, T.body);
    box(ctx, x + 1, y + 1, 1, h - 2, T.metal);
    for (let iy = y + 2; iy < y + h - 2; iy += 3) cell(ctx, x + 1, iy, T.bright);
    box(ctx, x, y, 3, 1, acc(T));
    box(ctx, x, y + h - 1, 3, 1, acc(T));
    cell(ctx, x + 1, y + Math.floor(h * 0.38), COLORS.bg); // substrate key notch, both states
  },
  /** Horizontal expansion (PCIe) slot: shroud, contact rows, accent end latch. */
  pcieSlot: (ctx, { x, y, w }, T) => {
    box(ctx, x, y, w, 4, T.body);
    box(ctx, x + 1, y + 1, w - 2, 2, T.recess);
    for (let ix = x + 2; ix < x + w - 2; ix += 2) { cell(ctx, ix, y + 1, T.metal); cell(ctx, ix, y + 2, T.metal); }
    box(ctx, x + w - 2, y, 2, 4, acc(T));
    box(ctx, x, y, 1, 4, T.metal);
  },
  /** VRM inductor: chunky metal cube with a visible coil core. */
  choke: (ctx, { x, y }, T) => {
    box(ctx, x, y, 4, 4, T.metal);
    box(ctx, x + 1, y + 1, 2, 2, T.bright);
  },
  /** MOSFET / DPAK: body plus a row of bright pins. */
  mosfet: (ctx, { x, y }, T) => {
    box(ctx, x, y, 3, 2, T.body);
    box(ctx, x, y, 3, 1, T.metal);
    for (let i = 0; i < 3; i++) cell(ctx, x + i, y + 2, T.bright);
  },
  /** Small electrolytic cap: round silhouette with a crossed (scored) top. */
  capSmall: (ctx, { x, y }, T) => {
    box(ctx, x, y, 3, 3, T.body);
    cell(ctx, x + 1, y, T.bright); cell(ctx, x, y + 1, T.bright);
    cell(ctx, x + 2, y + 1, T.bright); cell(ctx, x + 1, y + 2, T.bright);
    cell(ctx, x + 1, y + 1, T.metal);
  },
  /** Big electrolytic can: bright rim, dark scored top, rounded corners. */
  capBig: (ctx, { x, y }, T) => {
    box(ctx, x, y, 4, 4, T.bright);
    box(ctx, x + 1, y + 1, 2, 2, T.metal);
    cell(ctx, x, y, T.body); cell(ctx, x + 3, y, T.body);
    cell(ctx, x, y + 3, T.body); cell(ctx, x + 3, y + 3, T.body);
    cell(ctx, x + 1, y + 1, T.bright); cell(ctx, x + 2, y + 2, T.bright);
  },
  /** Coin cell in its holder: bright disc with retaining clips. */
  coinCell: (ctx, { x, y }, T) => {
    const rows: [number, number][] = [[2, 3], [1, 4], [0, 5], [0, 5], [1, 4], [2, 3]];
    rows.forEach(([a, b], r) => box(ctx, x + a, y + r, b - a + 1, 1, T.bright));
    box(ctx, x + 2, y + 2, 2, 2, T.metal);
    cell(ctx, x + 2, y + 2, T.bright);
    box(ctx, x, y + 2, 1, 2, T.body);
    box(ctx, x + 5, y + 2, 1, 2, T.body);
  },
  /** Chipset heatsink: finned block. */
  heatsink: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.bright, 1);
    for (let iy = y + 2; iy < y + h - 1; iy += 2) box(ctx, x + 2, iy, w - 4, 1, T.metal);
    box(ctx, x + 1, y + 1, 2, 1, acc(T));
  },
  /** Quad-flat-pack IC: body, bright pin rows on all four sides, accent pin-1 dot. */
  qfp: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 2, y + 2, w - 4, h - 4, T.lid);
    for (let iy = y + 1; iy < y + h - 1; iy += 2) { cell(ctx, x - 1, iy, T.bright); cell(ctx, x + w, iy, T.bright); }
    for (let ix = x + 1; ix < x + w - 1; ix += 2) { cell(ctx, ix, y - 1, T.bright); cell(ctx, ix, y + h, T.bright); }
    cell(ctx, x + 1, y + 1, acc(T));
  },
  /** Dual-inline IC (DRAM / flash): body with pins on the two long sides. */
  dipIC: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    box(ctx, x + 1, y + 1, w - 2, h - 2, T.lid);
    for (let iy = y + 1; iy < y + h - 1; iy += 2) { cell(ctx, x - 1, iy, T.bright); cell(ctx, x + w, iy, T.bright); }
    cell(ctx, x + 1, y + 1, acc(T));
  },
  /** Crystal oscillator: small shiny can. */
  crystal: (ctx, { x, y }, T) => {
    box(ctx, x, y, 4, 2, T.bright);
    box(ctx, x + 1, y, 2, 1, T.metal);
    cell(ctx, x, y, T.body); cell(ctx, x + 3, y, T.body);
  },
  /** Pin header (SATA / power): shroud with a bright pin grid. */
  header: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    frame(ctx, x, y, w, h, T.metal, 1);
    for (let iy = y + 1; iy < y + h - 1; iy += 2)
      for (let ix = x + 1; ix < x + w - 1; ix += 2) cell(ctx, ix, iy, T.bright);
  },
  /** 2-pin chip resistor / small SMD passive. */
  smd: (ctx, { x, y, w, h }, T) => {
    box(ctx, x, y, w, h, T.body);
    if (w >= h) { box(ctx, x, y, 1, h, T.bright); box(ctx, x + w - 1, y, 1, h, T.bright); }
    else { box(ctx, x, y, w, 1, T.bright); box(ctx, x, y + h - 1, w, 1, T.bright); }
  },
  /** The fan draws through `drawFan` so the alive state can re-draw it rotating
   * (§12.6.2); the static entry is blade step 0. */
  fan: (ctx, b, T) => { drawFanBlades(ctx, { x: b.x, y: b.y }, 0, T); },
};

/**
 * §12.6.2's rotating fan: a 4-blade pinwheel on a 6×6 footprint inside an 8×8
 * shroud. `step` 0..3 advances it 22.5°, so four steps complete the blades' 90°
 * rotational symmetry — one 20-frame rotation at 5 frames per step. The 2×2 hub
 * is the fan's accent pop: a small deliberate spot of colour at the centre of
 * the rotation rather than accent on the blades, which would smear into noise as
 * they turn. Returns the number of cells it painted (§12.6.4's measured
 * quantity).
 */
export function drawFanBlades(ctx: SKRSContext2D, at: Cell, step: number, T: Tones): number {
  let drawn = 0;
  const cx = at.x + 2.5, cy = at.y + 2.5;
  frame(ctx, at.x - 1, at.y - 1, 8, 8, T.body, 1); // shroud
  for (let y = at.y; y < at.y + 6; y++)
    for (let x = at.x; x < at.x + 6; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r < 0.9) { cell(ctx, x, y, acc(T)); drawn++; continue; }
      if (r > 3.2) continue;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 360 + step * 22.5;
      if (deg % 90 < 45) { cell(ctx, x, y, T.metal); drawn++; }
    }
  return drawn;
}

/** Draws one placed component at `level` on §12.5's ladder (0 unlit .. 2 lit,
 * half steps legal). `rising` is the direction the level is moving in, which the
 * half-step role assignment depends on — see `tonesFor`. */
export function drawComponent(ctx: SKRSContext2D, comp: BoardComponent, level: number, rising: boolean): void {
  SPRITES[comp.kind](ctx, comp.body, tonesFor(level, comp.accent ?? null, rising));
}
