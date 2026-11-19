import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { registerFonts } from './fonts.js';
import {
  ACCENT_LIST, BOARD, BOARD_EDGE, BOARD_KEEPOUT, BOARD_RIGHT, CELL, COLORS, DRESSING_COLORS, FABRIC_COLOR,
  FINGER_W, FINGERS, GOLD, GRID_H, GRID_W, HEIGHT, REV_BASELINE_PX, REV_FONT_PX, REV_RIGHT_PX, REV_ZONE, VOID_BG, WIDTH, cellRect, revFromSeed,
} from './layout.js';
import { drawComponent, LEVEL_LIT } from './sprites.js';
import { SLOTS_PER_FRAME, FINGER_FLASH, contestedRingColor, washAt } from './signals.js';
import { visibleAges } from './creatures.js';
import { answerSpikeAt, answerWashAt, wakeCellsAt } from './boardlife.js';
import { fanStepAt, idleCellsAt, plateCellsAt, plateStaticCells } from './idle.js';
import { tissueCellsAt } from './tissue.js';
import type { BoardComponent, DressingFeature, SoupState, World } from './types.js';

// ---------------------------------------------------------------------------
// render.ts — §13's three additions to the §12 board: the `#444444` fabric layer
// (under the hardware, never over a live trace), the hot flow rendering table of
// §13.2, and the whole-component wash (ladder -> accent ramp at the pinned
// stops). Plus the void: §13.3's soup, drawn at four generation ages at once.
//
// The board's idle life (the fan's blades, status LEDs, the CPU heartbeat, bus bars, sprouts at the
// connector) is built as data in `idle.ts` and painted here: statics in `drawStatic`, the rest per
// frame over the takeover washes and under the signals. The name is a dot-matrix plate, from the same
// module. §13.5's measured budgets cover the flows and the void; the idle layer's own budget
// (at most 90 dynamic cells a frame, fan blades extra) is gated in `idle.test.ts`.
// ---------------------------------------------------------------------------

const px = (c: number): number => c * CELL;

export function mixOnBg(hex: string, alpha: number, bgHex: string = COLORS.bg): string {
  const n = parseInt(hex.slice(1), 16), b = parseInt(bgHex.slice(1), 16);
  const m = (c: number, d: number): number => Math.round(c * alpha + d * (1 - alpha));
  const r = m(n >> 16, b >> 16), g = m((n >> 8) & 255, (b >> 8) & 255), bl = m(n & 255, b & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/**
 * §13.2: "a flow drawn *in* the accent is invisible on copper already at full
 * value, so a flow is drawn HOTTER than the trace" — the accent blended toward
 * white.
 */
export function hot(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const up = (c: number): number => Math.round(c + (255 - c) * k);
  return `#${((up(n >> 16) << 16) | (up((n >> 8) & 255) << 8) | up(n & 255)).toString(16).padStart(6, '0')}`;
}

/** Blend two arbitrary hexes — used only for the gradual emergence of eyes. */
function mixHexTo(a: string, b: string, k: number): string {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const m = (sa: number, sb: number): number => Math.round(sa + (sb - sa) * k);
  return `#${((m(A >> 16, B >> 16) << 16) | (m((A >> 8) & 255, (B >> 8) & 255) << 8) | m(A & 255, B & 255))
    .toString(16).padStart(6, '0')}`;
}

const hexOf = (r: number, g: number, b: number): string =>
  `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

const cell = (ctx: SKRSContext2D, x: number, y: number, color: string): void => {
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), CELL, CELL);
};
const box = (ctx: SKRSContext2D, x: number, y: number, w: number, h: number, color: string): void => {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(px(x), px(y), px(w), px(h));
};

/**
 * §13.2's VIVID palette knobs: trace 1.0 · flowHead 1.0 · flowTail 0.75 ·
 * washCeil 1.0. §12.1's dim values (trace body 60 %, pulse trail 80 %/35 %,
 * ramp middle 60 %) are superseded — Cody: "the colors seem to have been muted
 * from original ones."
 */
export const PALETTE = { trace: 1.0, flowHead: 1.0, flowTail: 0.75, washCeil: 1.0 } as const;

/**
 * The living board's copper RESTS dim: a net cell is its accent at this share on
 * the substrate, and only a flow, its wake or an answer lights it. `PALETTE.trace`
 * stays "the lit value" (1.0), which is what a flow's own colour is measured from.
 * 5 accents -> 5 resting colours.
 */
export const COPPER_REST = 0.45;

/** A wake cell's level by fade step (`WakeCell.step`), in the FLOW's colour: 4
 * steps x the flow colours (5) = 20 colours. */
export const WAKE_LEVELS = [1.0, 0.8, 0.64, 0.52] as const;

/** §12.5's lit tone ladder, in order — the grays a wash remaps onto an accent
 * ramp — and §13.2's pinned wash stops. */
const LADDER = [COLORS.bg, COLORS.grid, COLORS.surface, COLORS.edge, COLORS.dim, COLORS.muted] as const;
const WASH_STOPS = [0.10, 0.17, 0.27, 0.42, 0.66, 1.0];

const mod = (a: number, n: number): number => ((a % n) + n) % n;

// ---------------------------------------------------------------------------
// The static board — everything that does not move, drawn once
// ---------------------------------------------------------------------------

function drawDressingFeature(ctx: SKRSContext2D, f: DressingFeature): void {
  const [bx, by, bw, bh] = cellRect(f.rect);
  switch (f.kind) {
    case 'footprint': {
      ctx.strokeStyle = DRESSING_COLORS.outline;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = DRESSING_COLORS.pin;
      if (f.rect.w >= f.rect.h) {
        ctx.fillRect(px(f.rect.x - 1), by, CELL, bh);
        ctx.fillRect(px(f.rect.x + f.rect.w), by, CELL, bh);
      } else {
        ctx.fillRect(bx, px(f.rect.y - 1), bw, CELL);
        ctx.fillRect(bx, px(f.rect.y + f.rect.h), bw, CELL);
      }
      if (f.designator) {
        ctx.font = '8px "JetBrains Mono"';
        ctx.fillStyle = DRESSING_COLORS.designator;
        ctx.fillText(f.designator, bx, by - 2);
      }
      break;
    }
    case 'hatch': {
      ctx.save();
      ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      ctx.strokeStyle = DRESSING_COLORS.hatch;
      ctx.lineWidth = 1;
      for (let d = -bh; d < bw; d += 6) {
        ctx.beginPath(); ctx.moveTo(bx + d, by); ctx.lineTo(bx + d + bh, by + bh); ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'fiducial': {
      ctx.strokeStyle = DRESSING_COLORS.ring;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, Math.min(bw, bh) / 2 - 1, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'testpoint': {
      ctx.strokeStyle = DRESSING_COLORS.ring;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, Math.min(bw, bh) / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, 1, 0, Math.PI * 2); ctx.stroke();
      break;
    }
  }
}

/** §12.4's screw mount holes: concentric plated rings, all from sanctioned palette values. */
function drawMountHole(ctx: SKRSContext2D, hole: { x: number; y: number }): void {
  const cx = px(hole.x) + CELL / 2, cy = px(hole.y) + CELL / 2;
  ctx.strokeStyle = BOARD_KEEPOUT; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = BOARD_EDGE;
  ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COLORS.dim;
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = VOID_BG;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
}

/** §13.5's legend as amended 2026-07-25: the REV line, right-aligned at the board's RIGHT edge,
 * `#888888`, baseline 22 px below the band's top edge. The name that used to share its baseline is
 * now the dot-matrix plate (owner, 2026-11-19: "i liked it on a plate too but not as big as the last
 * one you showed"), drawn from `idle.ts`'s cells, so no name text is drawn here. */
function drawTextLayer(ctx: SKRSContext2D, seed: number): void {
  ctx.fillStyle = COLORS.muted;
  // Right-aligned so the line ends on the board edge whatever the date's width.
  // `textAlign` is restored immediately: the static layer is drawn once, but a
  // leaked alignment would silently move every later `fillText` on this context.
  ctx.font = `${REV_FONT_PX}px "JetBrains Mono"`;
  ctx.textAlign = 'right';
  ctx.fillText(`REV ${revFromSeed(seed)}`, REV_RIGHT_PX, px(REV_ZONE.y) + REV_BASELINE_PX);
  ctx.textAlign = 'left';
}

/**
 * The base layer. Draw order is load-bearing:
 *
 *   substrate -> mount holes -> dressing -> silkscreen -> TRACES (resting) -> FABRIC ->
 *   hardware -> connector gold -> tissue arbor (void) -> idle statics (sprouts, LEDs) -> name plate -> REV line
 *
 * The fabric goes down after the traces and is skipped wherever a trace already
 * occupies the cell (§13.1: "beneath the hardware and never over a live trace"),
 * and the hardware goes down after both, so §12.4's landing overshoot disappears
 * under the body it lands on exactly as it does on a real board.
 */
export function drawStatic(world: World): Canvas {
  registerFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, px(BOARD_RIGHT), HEIGHT);
  ctx.fillStyle = VOID_BG;
  ctx.fillRect(px(BOARD_RIGHT), 0, WIDTH - px(BOARD_RIGHT), HEIGHT);

  // §12.2's fiberglass grid as cell-aligned intersection dots.
  ctx.fillStyle = COLORS.grid;
  for (let gy = 0; gy <= GRID_H; gy += 8)
    for (let gx = 0; gx <= BOARD_RIGHT; gx += 8) ctx.fillRect(px(gx), px(gy), CELL, CELL);

  ctx.strokeStyle = BOARD_EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(px(BOARD.inset) + 1, px(BOARD.inset) + 1,
    px(BOARD_RIGHT) - px(BOARD.inset) - 2, HEIGHT - 2 * px(BOARD.inset) - 2);
  ctx.strokeStyle = BOARD_KEEPOUT;
  ctx.lineWidth = 1;
  const ki = BOARD.inset + 2;
  ctx.strokeRect(px(ki) + 0.5, px(ki) + 0.5, px(BOARD_RIGHT - ki) - px(ki) - 1, HEIGHT - 2 * px(ki) - 1);

  for (const h of world.mountHoles) drawMountHole(ctx, h);
  for (const f of world.dressing.features) drawDressingFeature(ctx, f);

  for (const sec of world.sections) {
    if (sec.outline !== false && sec.rect.w > 0 && sec.rect.h > 0) {
      ctx.strokeStyle = COLORS.surface;
      ctx.lineWidth = 1;
      ctx.strokeRect(px(sec.rect.x) + 0.5, px(sec.rect.y) + 0.5, px(sec.rect.w) - 1, px(sec.rect.h) - 1);
    }
    if (sec.label) {
      ctx.font = '8px "JetBrains Mono"';
      ctx.fillStyle = COLORS.edge;
      ctx.fillText(sec.label, px(sec.rect.x + 1), px(sec.rect.y) - 2);
    }
  }

  // The living board's palette: copper rests at COPPER_REST of its accent; the lit
  // value (PALETTE.trace) is what flows, wakes and answers bring.
  const onNet = new Set<string>();
  for (const n of world.nets)
    for (const c of n.cells) {
      onNet.add(`${c.x},${c.y}`);
      cell(ctx, c.x, c.y, mixOnBg(n.color, COPPER_REST));
    }
  // §13.1's neutral interconnect fabric.
  for (const c of world.fabric) if (!onNet.has(`${c.x},${c.y}`)) cell(ctx, c.x, c.y, FABRIC_COLOR);

  // §13.2: every populated component sits at LEVEL_LIT in every frame, drawn
  // once into the static board layer. The takeover wash is the only thing that
  // ever changes a component's appearance.
  for (const comp of world.components) drawComponent(ctx, comp, LEVEL_LIT, false);

  ctx.fillStyle = GOLD;
  for (const f of FINGERS) ctx.fillRect(px(f.x), px(f.y), px(FINGER_W), px(f.h));

  // The tissue's resting arbor lives in the void, which holds no static ink and none
  // of the legend, so it can go down before the text without touching it.
  for (const c of world.tissue.staticCells) cell(ctx, c.x, c.y, c.color);

  // The idle layer's resting cells (sprouts at rest, LEDs off) sit on bare substrate by construction;
  // the name plate is a module of its own, steady state: the whole name lit.
  for (const c of world.idle.staticCells) cell(ctx, c.x, c.y, c.color);
  for (const c of plateStaticCells()) cell(ctx, c.x, c.y, c.color);

  drawTextLayer(ctx, world.seed);
  return canvas;
}

// ---------------------------------------------------------------------------
// §13.2 — the component takeover
// ---------------------------------------------------------------------------

/**
 * Repaint a whole component in an accent: every gray of §12.5's lit ladder is
 * remapped onto the accent's own ramp at the pinned stops, so body, frame, pins
 * and lid all take the colour — the component becomes a coloured *view* of
 * itself rather than a gray box with a coloured dot. Accent pins and non-ladder
 * pixels are left alone.
 */
export function washComponent(
  ctx: SKRSContext2D, base: Uint8ClampedArray, comp: BoardComponent, accent: string, k: number, ceil: number,
): number {
  const map = new Map<string, string>();
  LADDER.forEach((gray, i) => map.set(gray, mixOnBg(accent, Math.min(1, WASH_STOPS[i] * ceil * k))));
  const r = comp.rect;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      const i = ((y * CELL) * WIDTH + x * CELL) * 4;
      const to = map.get(hexOf(base[i], base[i + 1], base[i + 2]));
      if (!to) continue;
      cell(ctx, x, y, to);
      n++;
    }
  return n;
}

/**
 * §13.2's contested rule: when two flows are inside the same component the most
 * recent arrival owns the body wash, and the second colour is drawn as a
 * one-cell border ring around the component's outline at the same ramp stops —
 * so a contested part reads as one colour holding the chip with another pressing
 * at its edge, not as a flicker between two.
 */
function drawContestedRing(
  ctx: SKRSContext2D, base: Uint8ClampedArray, comp: BoardComponent, second: string, ceil: number,
): void {
  const map = new Map<string, string>();
  LADDER.forEach((gray, i) => map.set(gray, mixOnBg(second, Math.min(1, WASH_STOPS[i] * ceil))));
  const r = comp.rect;
  const ring = (x: number, y: number): void => {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const i = ((y * CELL) * WIDTH + x * CELL) * 4;
    const to = map.get(hexOf(base[i], base[i + 1], base[i + 2]));
    if (to) cell(ctx, x, y, to);
  };
  for (let x = r.x; x < r.x + r.w; x++) { ring(x, r.y); ring(x, r.y + r.h - 1); }
  for (let y = r.y; y < r.y + r.h; y++) { ring(r.x, y); ring(r.x + r.w - 1, y); }
}

// ---------------------------------------------------------------------------
// §13.2 — the hot flow rendering table
// ---------------------------------------------------------------------------

/**
 * Rows evaluated top to bottom, first match wins; `d` is the cell's distance
 * behind the head and `u = 1 - d/trail`:
 *
 *   flow head   d = 0                  #ffffff
 *   near trail  d <= 3                 hot(accent, 0.55·u)
 *   mid trail   otherwise, u > 0.45    hot(accent, 0.30·u)
 *   tail        otherwise              mixOnBg(accent, max(flowTail,0.75)·(2u)²),
 *                                      drawn only while >= 0.12
 *
 * The trail is a DISCRETE per-cell step function on the 4 px grid — §3's
 * "discrete halo steps" with more steps, not a gradient (§13.2's explicit
 * carve-out). Cutting below 0.12 is what terminates the ramp on a hard cell
 * boundary rather than letting it fade to invisibility.
 *
 * Couriers draw UNDER streams, so a merge reads as the small flow being
 * absorbed rather than as two adjacent comets.
 */
export function trailColorAt(color: string, d: number, trail: number): string | null {
  if (d === 0) return COLORS.white;
  const u = 1 - d / trail;
  if (d <= 3) return hot(color, 0.55 * u);
  if (u > 0.45) return hot(color, 0.3 * u);
  const a = Math.max(PALETTE.flowTail, 0.75) * (u * 2) ** 2;
  return a >= 0.12 ? mixOnBg(color, Math.min(1, a)) : null;
}

export function drawFlows(ctx: SKRSContext2D, world: World, t: number): void {
  const N = world.T * SLOTS_PER_FRAME;
  for (const kind of ['interior', 'courier', 'stream'] as const)
    for (const f of world.flows) {
      if (f.kind !== kind) continue;
      const head = Math.round(t * SLOTS_PER_FRAME);
      for (let d = f.trail - 1; d >= 0; d--) {
        const idx = mod(head - d, N);
        const p = f.slots[idx];
        if (!p) continue;
        // a courier's colour threaded into the first stretch of the stream it fed
        const woven = f.thread && mod(idx - f.thread.from, N) <= f.thread.to - f.thread.from;
        const col = woven ? f.thread!.color : f.color;
        const step = trailColorAt(col, d, f.trail);
        if (step) cell(ctx, p.x, p.y, step);
      }
    }
}

// ---------------------------------------------------------------------------
// §13.3 — the void
// ---------------------------------------------------------------------------

/**
 * Every particle draws the same way whether it is drifting or belonging — the
 * only difference an observer can see is that bonded ones have settled into a
 * lattice. Eyes are just particles whose colour has eased toward off-white.
 * Breath and blink are draw-time only, never sim mutations; a blinking socket
 * shows the DOMINANT BODY COLOUR, which is what makes it read as a lid.
 */
export function drawSoup(ctx: SKRSContext2D, st: SoupState, colors: readonly string[]): void {
  for (const c of st.crust) cell(ctx, c.x, c.y, mixOnBg(colors[c.c], 0.85));
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
        : mixHexTo(base, COLORS.offwhite, Math.min(1, p.eye));
    } else col = p.streak > 0 ? hot(base, 0.45) : base;
    const dy = p.cluster >= 0 ? (bob.get(p.cluster) ?? 0) : 0;
    cell(ctx, Math.round(p.x), Math.round(p.y) + dy, col);
  }
}

// ---------------------------------------------------------------------------
// The fan: four bright blades on a dark disc (the sketch's final version, which the owner liked)
// ---------------------------------------------------------------------------

const FAN_SHROUD = '#5a5a5a', FAN_CORNER = '#2a2a2a', FAN_DISC = '#0c0c0c', FAN_BLADE = '#d8d8d8';

/**
 * Redraws the whole 8x8 fan footprint at blade phase `step` (0..3, 22.5 degrees each): the shroud, the
 * dark disc with its corners, a hub in the fan's accent, and four bright blades. It repaints every cell
 * of the footprint, so it does not matter what a heatsink wash did to them. Called AFTER the washes.
 */
function drawFan(ctx: SKRSContext2D, fan: BoardComponent, step: number): void {
  const ax = fan.body.x, ay = fan.body.y;
  box(ctx, ax - 1, ay - 1, 8, 1, FAN_SHROUD); box(ctx, ax - 1, ay + 6, 8, 1, FAN_SHROUD);
  box(ctx, ax - 1, ay, 1, 6, FAN_SHROUD); box(ctx, ax + 6, ay, 1, 6, FAN_SHROUD);
  const hub = hot(fan.accent ?? ACCENT_LIST[2], 0.35);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++) {
      const dx = x - 2.5, dy = y - 2.5, r = Math.hypot(dx, dy);
      if (r > 3.3) { cell(ctx, ax + x, ay + y, FAN_CORNER); continue; }
      cell(ctx, ax + x, ay + y, FAN_DISC);
      if (r < 0.9) { cell(ctx, ax + x, ay + y, hub); continue; }
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 360 + step * 22.5;
      if (deg % 90 < 40) cell(ctx, ax + x, ay + y, FAN_BLADE);
    }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * `createRenderer(world)(t)` evaluates any frame as a pure function of
 * `t mod T`: no STATE is carried between frames, so `render(T)` is bit-identical
 * to `render(0)` by construction.
 *
 * One canvas is reused for every frame, and each call repaints all of it from
 * the opaque static layer. The returned canvas is therefore valid only until
 * the next call: read it (`readFrame` / drawImage) before rendering again.
 * A fresh canvas per frame costs about 4.7 MB of native memory that V8 cannot
 * see and so never collects in time — measured 1.37 GB per 288-frame pass,
 * which is what took the full suite past 28 GB.
 */
export function createRenderer(world: World): (t: number) => Canvas {
  registerFonts();
  const staticLayer = drawStatic(world);
  const baseData = readFrame(staticLayer);
  const nodes = [...world.takeovers.keys()];
  const fan = world.components.find(c => c.kind === 'fan');
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  return (tRaw: number): Canvas => {
    const t = mod(tRaw, world.T);
    ctx.drawImage(staticLayer, 0, 0);

    // component conversions — "the whole component becomes a coloured view of itself"
    for (const node of nodes) {
      const w = washAt(world.takeovers.get(node), t, world.T);
      const ci = world.graph.nodes[node].comp;
      if (!w || ci < 0) continue;
      washComponent(ctx, baseData, world.components[ci], w.color, w.k, PALETTE.washCeil);
    }
    for (const node of nodes) {
      const ci = world.graph.nodes[node].comp;
      if (ci < 0) continue;
      // The ring is always a colour the owner is NOT wearing (§13.2), so the
      // part reads as contested rather than as a slightly thicker wash.
      const ring = contestedRingColor(world.takeovers.get(node), t, world.T);
      if (!ring) continue;
      drawContestedRing(ctx, baseData, world.components[ci], ring, PALETTE.washCeil);
    }

    // §13.2's only finger lighting: the arrival flash, 10 frames, at most 9 per
    // loop, staggered ~T/9 apart by construction.
    for (const e of world.events) {
      const age = mod(t - e.frame, world.T);
      if (age > FINGER_FLASH) continue;
      const f = FINGERS[e.finger];
      box(ctx, f.x, f.y, FINGER_W, f.h, mixOnBg(e.color, Math.max(0.35, 1 - age / FINGER_FLASH)));
    }

    // The board's idle life (sprouts, LEDs, the heartbeat, bus bars, the plate's retyping) goes over the
    // takeover washes, under the wake and everything after it, so a signal or an answer always wins; the
    // answer's chip wash, painted later, covers the heartbeat on the CPU. The fan comes after the washes
    // so a heatsink wash cannot erase its blades.
    for (const c of idleCellsAt(world.idle, t, world.T)) cell(ctx, c.x, c.y, c.color);
    for (const c of plateCellsAt(t, world.T)) cell(ctx, c.x, c.y, c.color);
    if (fan) drawFan(ctx, fan, fanStepAt(t));

    // The wake: copper a flow has just left, in that flow's colour, stepping down.
    for (const c of wakeCellsAt(world.wake, t)) cell(ctx, c.x, c.y, mixOnBg(c.color, WAKE_LEVELS[c.step]));

    // The tissue's moving cells, over its static arbor, under the flows (an escaping
    // comet crosses the tissue's finger contacts) and under the soup.
    for (const c of tissueCellsAt(world.tissue, t)) cell(ctx, c.x, c.y, c.color);

    // The board answers a recording: the chip washes in the neuron's accent, over any
    // takeover wash it is wearing (the answer wins that chip).
    for (const a of answerWashAt(world.answers, t, world.T))
      washComponent(ctx, baseData, world.components[a.component], a.accent, a.k, PALETTE.washCeil);

    drawFlows(ctx, world, t);

    // The answer's spike runs over everything on the copper, head last-painted so a
    // path that crosses itself keeps its head on top. Head 4 cells white; behind it the
    // accent steps down through trailColorAt(accent, d - 3, 7) (the sketch's own ramp:
    // d = 4 is the ramp's first step, and the last trail cell falls below the 0.12 cut
    // and is simply not drawn).
    const spike = answerSpikeAt(world.answers, t, world.T);
    for (let i = spike.length - 1; i >= 0; i--) {
      const c = spike[i];
      const col = c.d < 4 ? COLORS.white : trailColorAt(c.accent, c.d - 3, 7);
      if (col) cell(ctx, c.x, c.y, col);
    }

    // The wrap: the four generation ages share the void, so the outgoing
    // generation and the incoming one are on screen together.
    for (const age of visibleAges(t, world.T)) drawSoup(ctx, world.soup.frames[age], ACCENT_LIST);
    return canvas;
  };
}

/**
 * A frame's pixels as RGBA bytes, copied out of the canvas.
 *
 * This is the ONE way the generator reads a rendered frame. `ctx.getImageData`
 * in @napi-rs/canvas 1.0.2 leaves about 1.5 MB of native memory behind on every
 * call, which V8 cannot see and so does not collect: 288 frames per pass, about
 * thirty passes in the suite, 28 GB. `canvas.data()` returns the same bytes for
 * an opaque canvas (asserted in render.test.ts) and leaves nothing behind. The
 * copy matters: the renderer reuses its canvas, so a view into it would change
 * under the caller on the next render.
 */
export function readFrame(canvas: Canvas): Uint8ClampedArray {
  return new Uint8ClampedArray(canvas.data());
}
