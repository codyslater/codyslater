import { describe, expect, it } from 'vitest';
import {
  BOARD_RIGHT, CELL, COLORS, FABRIC_COLOR, FINGERS, GOLD, GRID_H, GRID_W, HEIGHT, NAME, NAME_ZONE,
  REV_RIGHT_PX, REV_ZONE, THESIS_ZONE, WIDTH,
} from './layout.js';
import { PALETTE, createRenderer, drawStatic, hot, mixOnBg, trailColorAt } from './render.js';
import { FINGER_FLASH, TRAIL, flowDrawn } from './signals.js';
import { visibleAges } from './creatures.js';
import { buildWorld } from './timeline.js';
import type { World } from './types.js';

const T = 288;
let cachedWorld: World | undefined;
const world = (): World => (cachedWorld ??= buildWorld(20260724, T));
let cachedRender: ((t: number) => ReturnType<typeof drawStatic>) | undefined;
const renderer = (): ((t: number) => ReturnType<typeof drawStatic>) => (cachedRender ??= createRenderer(world()));
let cachedStatic: Uint8ClampedArray | undefined;
const staticData = (): Uint8ClampedArray => (cachedStatic ??= dataOf(drawStatic(world())));

const hexAt = (data: Uint8ClampedArray, x: number, y: number): string => {
  const i = ((y * CELL) * WIDTH + x * CELL) * 4;
  return `#${((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]).toString(16).padStart(6, '0')}`;
};
/** Exact-pixel scan (not cell-corner sampling) — silkscreen text is antialiased. */
const countPixel = (data: Uint8ClampedArray, z: { x: number; y: number; w: number; h: number }, hex: string): number => {
  const want = parseInt(hex.slice(1), 16);
  let n = 0;
  for (let y = z.y * CELL; y < (z.y + z.h) * CELL; y++)
    for (let x = z.x * CELL; x < (z.x + z.w) * CELL; x++) {
      const i = (y * WIDTH + x) * 4;
      if (((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) === want) n++;
    }
  return n;
};
/**
 * Silkscreen INK: an antialiased glyph pixel, at any coverage.
 *
 * The legend is the only neutral gray above `#2a2a2a` that can appear inside a
 * text zone — the zones are binding exclusion masks, so no trace, fabric,
 * component or dressing is there to be confused with it, and the substrate,
 * keepout line and grid dots all sit at `#2a2a2a` or below. Counting exact
 * `#888888` instead misses the 11 px REV line almost entirely: its glyph cores
 * land on `#7c7c7c`/`#797979`/`#7e7e7e`, not on the nominal tone.
 */
const countInk = (data: Uint8ClampedArray, z: { x: number; y: number; w: number; h: number }): number => {
  let n = 0;
  for (let y = z.y * CELL; y < (z.y + z.h) * CELL; y++)
    for (let x = z.x * CELL; x < (z.x + z.w) * CELL; x++) {
      const i = (y * WIDTH + x) * 4;
      if (data[i] === data[i + 1] && data[i + 1] === data[i + 2] && data[i] > 0x30) n++;
    }
  return n;
};
const dataOf = (c: { getContext: (k: '2d') => { getImageData: (a: number, b: number, w: number, h: number) => { data: Uint8ClampedArray } } }): Uint8ClampedArray =>
  c.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;

describe('colour helpers', () => {
  it('mixOnBg blends toward the substrate; hot blends toward white', () => {
    expect(mixOnBg('#ffffff', 1)).toBe('#ffffff');
    expect(mixOnBg('#ffffff', 0)).toBe(COLORS.bg);
    expect(hot('#39ff14', 0)).toBe('#39ff14');
    expect(hot('#39ff14', 1)).toBe('#ffffff');
    expect(hot('#000000', 0.5)).toBe('#808080');
  });

  it('pins §13.2\'s VIVID knobs — §12.1\'s 60 % trace dim is retired', () => {
    expect(PALETTE).toEqual({ trace: 1.0, flowHead: 1.0, flowTail: 0.75, washCeil: 1.0 });
  });
});

describe('§13.2 the flow-trail ramp', () => {
  const steps = (trail: number): (string | null)[] =>
    Array.from({ length: trail }, (_, d) => trailColorAt('#39ff14', d, trail));
  const drawn = (trail: number): string[] =>
    steps(trail).slice(1).filter((c): c is string => c !== null);

  it('is a DISCRETE step function with §13.2\'s fixed step count per flow kind', () => {
    // "stream (trail 24) 19 steps, interior (trail 14) 11 steps, courier
    // (trail 7) 5 steps, plus the shared white head."
    expect(TRAIL.stream).toBe(24);
    expect(TRAIL.interior).toBe(14);
    expect(TRAIL.courier).toBe(7);
    expect(drawn(TRAIL.stream)).toHaveLength(19);
    expect(drawn(TRAIL.interior)).toHaveLength(11);
    expect(drawn(TRAIL.courier)).toHaveLength(5);
    for (const t of [TRAIL.stream, TRAIL.interior, TRAIL.courier])
      expect(trailColorAt('#39ff14', 0, t)).toBe(COLORS.white);
  });

  it('terminates on a hard cell boundary rather than fading to invisibility', () => {
    // "Trail cells whose mix would fall below 0.12 are NOT DRAWN AT ALL, which is
    // what terminates the ramp." So the tail is a prefix of drawn cells followed
    // by nothing — never a drawn cell after an undrawn one.
    for (const trail of [TRAIL.stream, TRAIL.interior, TRAIL.courier]) {
      const s = steps(trail);
      const firstGap = s.findIndex((c, i) => i > 0 && c === null);
      expect(firstGap).toBeGreaterThan(0);
      expect(s.slice(firstGap).every(c => c === null)).toBe(true);
    }
    expect(trailColorAt('#39ff14', TRAIL.stream - 1, TRAIL.stream)).toBeNull();
  });

  it('every step is one flat colour — no sub-cell interpolation anywhere', () => {
    // §13.2's carve-out from §3's no-gradient rule is explicitly "a discrete
    // per-cell step function on the 4 px grid"; each step is a single hex.
    for (const trail of [TRAIL.stream, TRAIL.interior, TRAIL.courier])
      for (const c of drawn(trail)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the static board', () => {
  it('draws traces at the accent\'s FULL value', () => {
    const w = world();
    const data = staticData();
    const compCells = new Set<string>();
    for (const c of w.components)
      for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++)
        for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) compCells.add(`${x},${y}`);
    let checked = 0;
    for (const net of w.nets)
      for (const c of net.cells) {
        if (compCells.has(`${c.x},${c.y}`) || c.x >= FINGERS[0].x) continue;
        if (hexAt(data, c.x, c.y) === net.color) checked++;
      }
    // most trace cells are painted in the pure accent (some are overdrawn by a
    // later net's own clearance-free bundle sibling, which is still an accent)
    expect(checked).toBeGreaterThan(1000);
  });

  it('draws the §13.1 fabric in #444444, under the hardware and never over a live trace', () => {
    const w = world();
    const data = staticData();
    const onNet = new Set(w.nets.flatMap(n => n.cells.map(c => `${c.x},${c.y}`)));
    const compCells = new Set<string>();
    for (const c of w.components)
      for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++)
        for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) compCells.add(`${x},${y}`);
    let bare = 0, overTrace = 0;
    for (const c of w.fabric) {
      const k = `${c.x},${c.y}`;
      if (compCells.has(k) || c.x >= FINGERS[0].x) continue;
      if (onNet.has(k)) {
        if (hexAt(data, c.x, c.y) === FABRIC_COLOR) overTrace++;
      } else {
        expect(hexAt(data, c.x, c.y)).toBe(FABRIC_COLOR);
        bare++;
      }
    }
    expect(bare).toBeGreaterThan(50);
    expect(overTrace).toBe(0);
  });

  it('leaves every populated component LEVEL_LIT and the gold at its base tone', () => {
    const w = world();
    const data = staticData();
    // the lit ladder's bright role appears on real hardware
    const cpu = w.components.find(c => c.kind === 'cpuSocket')!;
    let bright = 0;
    for (let y = cpu.body.y; y < cpu.body.y + cpu.body.h; y++)
      for (let x = cpu.body.x; x < cpu.body.x + cpu.body.w; x++)
        if (hexAt(data, x, y) === COLORS.muted) bright++;
    expect(bright).toBeGreaterThan(0);
    expect(hexAt(data, FINGERS[0].x + 1, FINGERS[0].y + 1)).toBe(GOLD);
  });

  it('prints the name in NAME_ZONE, the REV line in REV_ZONE, and nothing in the retired THESIS_ZONE', () => {
    const data = staticData();
    // antialiased silkscreen: only the glyph cores land on the exact tone, and
    // at the REV line's 11 px almost none of them do — so the name is checked on
    // the exact tone and the REV line on `ink` (see the helper).
    expect(countPixel(data, NAME_ZONE, COLORS.muted)).toBeGreaterThan(20);
    expect(countInk(data, REV_ZONE)).toBeGreaterThan(60);
    expect(countInk(data, THESIS_ZONE)).toBe(0);
    expect(countPixel(data, THESIS_ZONE, COLORS.muted)).toBe(0);
  });

  it('§13.5 amended: the REV line is RIGHT-aligned, on the board, ending 2 cells inside the edge', () => {
    // Cody, 2026-07-25: "can we move rev to right side of board." The failure
    // modes worth gating are (a) it drifts into the void past x = 230 and
    // (b) it silently reverts to left-aligned in the corner.
    const data = staticData();
    const cols: number[] = [];
    for (let x = REV_ZONE.x; x < REV_ZONE.x + REV_ZONE.w; x++)
      if (countInk(data, { x, y: REV_ZONE.y, w: 1, h: REV_ZONE.h }) > 0) cols.push(x);
    expect(cols.length).toBeGreaterThan(0);
    const last = cols[cols.length - 1];
    // right-aligned: the final glyph column lands within one cell of the anchor,
    // and the whole line stays on the board (the void starts beyond BOARD_RIGHT)
    expect(last).toBeLessThanOrEqual(REV_RIGHT_PX / CELL);
    expect(last).toBeGreaterThanOrEqual(REV_RIGHT_PX / CELL - 1);
    expect(last).toBeLessThan(BOARD_RIGHT);
    // and it is genuinely on the RIGHT half of the board, not back in the corner
    expect(cols[0]).toBeGreaterThan(GRID_W / 2);
  });

  it('the two legend lines share one line of the band — not the old stack', () => {
    const data = staticData();
    const rows = (zone: typeof REV_ZONE): number[] => {
      const ys: number[] = [];
      for (let y = zone.y; y < zone.y + zone.h; y++)
        if (countInk(data, { x: zone.x, y, w: zone.w, h: 1 }) > 0) ys.push(y);
      return ys;
    };
    const name = rows(NAME_ZONE), rev = rows(REV_ZONE);
    expect(name.length).toBeGreaterThan(0);
    expect(rev.length).toBeGreaterThan(0);
    // One shared baseline means the two lines OVERLAP vertically. Under the
    // superseded stacked geometry (REV baseline +40 against the name's +22) the
    // REV rows sat entirely below the name's, so this discriminates rather than
    // passing on any layout. Exact bottom rows are NOT compared: `cody_slater`
    // carries a descender and an underscore that `REV 2026.07.24` has not.
    expect(rev[0]).toBeLessThanOrEqual(name[name.length - 1]);
    expect(name[0]).toBeLessThanOrEqual(rev[rev.length - 1]);
  });

  it('§12.7: the legend is board print — no `$`, no cursor, no glow halo', () => {
    // "Removed with the terminal treatment: the `$` prefix, the blinking white
    // block cursor, the `#39ff14` name colour, the bold ~28 px weight, and the
    // 2-step glow halo." §13.5 carries that treatment; only the geometry moved.
    expect(NAME).toBe('cody_slater');
    expect(NAME).not.toContain('$');
    const data = staticData();
    expect(countPixel(data, NAME_ZONE, COLORS.white)).toBe(0);      // no block cursor
    expect(countPixel(data, NAME_ZONE, '#39ff14')).toBe(0);         // no terminal green
    expect(countPixel(data, NAME_ZONE, COLORS.offwhite)).toBe(0);   // no halo step
  });

  it('§12.2: the fiberglass grid is intersection DOTS at 8-cell pitch, not 1 px lines', () => {
    // "a 1 px line at px+0.5 is sub-cell and violates §3's own 'all simulation
    // art on integer cells with hard edges', and the continuous lines cost
    // 2.07 MB of the §6 GIF budget on their own."
    const data = staticData();
    // y = 64 is an intersection row clear of every component row and gutter and
    // above the text band, so grid tone there can only be the grid itself.
    let onRow = 0, atIntersections = 0;
    for (let x = 0; x <= 226; x++)
      if (hexAt(data, x, 64) === COLORS.grid) { onRow++; if (x % 8 === 0) atIntersections++; }
    expect(atIntersections).toBeGreaterThan(4);
    expect(`${onRow} grid cells, ${atIntersections} on an 8-multiple`)
      .toBe(`${onRow} grid cells, ${onRow} on an 8-multiple`);
  });
});

describe('the frame', () => {
  it('is seam-exact: frame T is bit-identical to frame 0', () => {
    const render = renderer();
    expect(Buffer.compare(Buffer.from(dataOf(render(T))), Buffer.from(dataOf(render(0))))).toBe(0);
    expect(Buffer.compare(Buffer.from(dataOf(render(-1))), Buffer.from(dataOf(render(T - 1))))).toBe(0);
  });

  it('is a pure function of t: the same frame twice gives the same pixels', () => {
    const render = renderer();
    expect(Buffer.compare(Buffer.from(dataOf(render(97))), Buffer.from(dataOf(render(97))))).toBe(0);
  });

  it('paints a white head for every flow in flight, on the cell the schedule says', () => {
    const w = world();
    const render = renderer();
    const t = 97;
    const data = dataOf(render(t));
    let heads = 0;
    for (const f of w.flows) {
      const head = f.slots[Math.round(t * 3) % (w.T * 3)];
      if (!head) continue;
      // a later flow may draw over an earlier one's head; count the ones that survive
      if (hexAt(data, head.x, head.y) === COLORS.white) heads++;
    }
    expect(heads).toBeGreaterThanOrEqual(4);
  });

  it('changes the board every frame — flows travel and components take colour', () => {
    const render = renderer();
    const a = dataOf(render(40)), b = dataOf(render(41));
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
    expect(diff).toBeGreaterThan(200);
  });

  it('§3: simulation art lands on integer cells with HARD EDGES', () => {
    // "All simulation art (traces, pixels, creatures) is drawn on integer cells
    // with hard edges; only silkscreen text is antialiased." Every flow cell and
    // every soup particle in a frame must therefore paint its whole 4x4 block one
    // colour — a stroked or half-cell primitive would leave a ragged block.
    const w = world();
    const render = renderer();
    let checked = 0, ragged = 0;
    for (const t of [0, 97, 200]) {
      const d = dataOf(render(t));
      const cells: { x: number; y: number }[] = [];
      for (const f of w.flows) cells.push(...flowDrawn(f, t, T));
      for (const age of visibleAges(t, T))
        for (const p of w.soup.frames[age].parts) cells.push({ x: Math.round(p.x), y: Math.round(p.y) });
      for (const c of cells) {
        if (c.x < 0 || c.x >= GRID_W || c.y < 0 || c.y >= GRID_H) continue;
        const i0 = ((c.y * CELL) * WIDTH + c.x * CELL) * 4;
        let uniform = true;
        for (let dy = 0; dy < CELL && uniform; dy++)
          for (let dx = 0; dx < CELL; dx++) {
            const i = ((c.y * CELL + dy) * WIDTH + c.x * CELL + dx) * 4;
            if (d[i] !== d[i0] || d[i + 1] !== d[i0 + 1] || d[i + 2] !== d[i0 + 2]) { uniform = false; break; }
          }
        checked++;
        if (!uniform) ragged++;
      }
    }
    expect(checked).toBeGreaterThan(500);   // not vacuous
    expect(`${ragged} ragged of ${checked}`).toBe(`0 ragged of ${checked}`);
  });

  it('§13.2: the arrival flash is the only finger lighting, and it lasts FINGER_FLASH frames', () => {
    // "Finger arrival flashes its stream's colour for 10 frames, at most 9 times
    // per loop... This is the ONLY finger lighting in §13" — §12.6.3's
    // per-emission gold lift is superseded and must not have come back.
    expect(FINGER_FLASH).toBe(10);
    const w = world();
    const render = renderer();
    expect(w.events).toHaveLength(9);
    const e = w.events[0];
    const f = FINGERS[e.finger];
    // The finger's outer column on its top row: `exitCells` runs the escaping
    // comet along y = f.y + 1, so this cell carries the flash and not the trail.
    const lit = (k: number): string => hexAt(dataOf(render(((e.frame + k) % T + T) % T)), f.x + 3, f.y);
    expect(lit(-1)).toBe(GOLD);                            // base gold before arrival
    for (let k = 0; k <= FINGER_FLASH; k++)
      expect(`k=${k} ${lit(k)}`).not.toBe(`k=${k} ${GOLD}`);
    expect(lit(FINGER_FLASH + 1)).toBe(GOLD);              // released, no residue
    expect(lit(0)).toBe(e.color);                          // full strength on arrival
    // The decay runs over FINGER_FLASH frames down to §13.2's 0.35 floor; the
    // endpoint frame is drawn AT that floor, so 11 frames carry colour for a
    // 10-frame decay. Pinned here so the shape is deliberate rather than assumed.
    expect(lit(FINGER_FLASH)).toBe(mixOnBg(e.color, 0.35));
  });

  it('washes a component onto its accent ramp while a flow is inside it', () => {
    const w = world();
    const render = renderer();
    const base = staticData();
    // find a (node, frame) where a takeover is at full strength
    const [node, hits] = [...w.takeovers.entries()].find(([, h]) => h.length > 0)!;
    const comp = w.components[w.graph.nodes[node].comp];
    const t = hits[0].frame + 2;
    const data = dataOf(render(t));
    let changed = 0;
    for (let y = comp.rect.y; y < comp.rect.y + comp.rect.h; y++)
      for (let x = comp.rect.x; x < comp.rect.x + comp.rect.w; x++)
        if (hexAt(data, x, y) !== hexAt(base, x, y)) changed++;
    expect(changed).toBeGreaterThan(4);
  });
});
