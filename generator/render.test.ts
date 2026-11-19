import { describe, expect, it } from 'vitest';
import {
  BOARD_RIGHT, CELL, COLORS, FABRIC_COLOR, FINGERS, GOLD, GRID_H, GRID_W, HEIGHT, NAME, NAME_ZONE,
  REV_RIGHT_PX, REV_ZONE, THESIS_ZONE, VOID_BG, WIDTH,
} from './layout.js';
import {
  COPPER_REST, PALETTE, WAKE_LEVELS, createRenderer, drawStatic, hot, mixOnBg, readFrame, trailColorAt,
} from './render.js';
import { ANSWER_FADE, ANSWER_HOLD, answerSpikeAt, wakeCellsAt } from './boardlife.js';
import { TISSUE_COLOURS, tissueCellsAt } from './tissue.js';
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
const dataOf = readFrame;

const compCellSet = (w: World): Set<string> => {
  const out = new Set<string>();
  for (const c of w.components)
    for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++)
      for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) out.add(`${x},${y}`);
  return out;
};
/** Soup cells at t, CONSERVATIVE: a bonded particle may bob one row, so both rows count. */
const soupCells = (w: World, t: number): Set<string> => {
  const out = new Set<string>();
  for (const age of visibleAges(t, T)) {
    const st = w.soup.frames[age];
    for (const p of st.parts) { out.add(`${Math.round(p.x)},${Math.round(p.y)}`); out.add(`${Math.round(p.x)},${Math.round(p.y) + 1}`); }
    for (const c of st.crust) out.add(`${c.x},${c.y}`);
  }
  return out;
};
const flowCells = (w: World, t: number): Set<string> => {
  const out = new Set<string>();
  for (const f of w.flows) for (const c of flowDrawn(f, t, T)) out.add(`${c.x},${c.y}`);
  return out;
};
const spikeCells = (w: World, t: number): Set<string> =>
  new Set(answerSpikeAt(w.answers, t, T).map(c => `${c.x},${c.y}`));
const SPREAD = [0, 20, 41, 97, 150, 203, 250, 275];

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
  it('draws traces at the RESTING copper level — the lit value is held for flows and wakes', () => {
    // Was "draws traces at the accent's FULL value" (PALETTE.trace = 1.0). The
    // living board rests dim: copper is COPPER_REST of the accent on the substrate,
    // and a flow, its wake or an answer is what lights it. PALETTE.trace still means
    // "the lit value" (1.0) and is pinned above.
    const w = world();
    const data = staticData();
    const comps = compCellSet(w);
    const owner = new Map<string, string>();       // the last net to paint a cell wins
    for (const net of w.nets) for (const c of net.cells) owner.set(`${c.x},${c.y}`, net.color);
    let checked = 0;
    for (const [k, color] of owner) {
      const [x, y] = k.split(',').map(Number);
      if (comps.has(k) || x >= FINGERS[0].x || x < 0 || y < 0 || y >= GRID_H) continue;
      expect(`${k} ${hexAt(data, x, y)}`).toBe(`${k} ${mixOnBg(color, COPPER_REST)}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(COPPER_REST).toBe(0.45);
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
      cells.push(...wakeCellsAt(w.wake, t), ...tissueCellsAt(w.tissue, t), ...w.tissue.staticCells);
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

describe('the living board', () => {
  it('lights the wake: every uncovered wake cell is the flow\'s colour at its stepped level', () => {
    const w = world();
    const render = renderer();
    expect(WAKE_LEVELS).toEqual([1.0, 0.8, 0.64, 0.52]);
    const comps = compCellSet(w);
    let checked = 0;
    const steps = new Set<number>();
    for (const t of SPREAD) {
      const d = dataOf(render(t));
      const covered = [flowCells(w, t), spikeCells(w, t), soupCells(w, t)];
      for (const c of wakeCellsAt(w.wake, t)) {
        const k = `${c.x},${c.y}`;
        if (comps.has(k) || covered.some(s => s.has(k))) continue;
        expect(`t${t} ${k} ${hexAt(d, c.x, c.y)}`).toBe(`t${t} ${k} ${mixOnBg(c.color, WAKE_LEVELS[c.step])}`);
        steps.add(c.step);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(steps.size).toBe(4);                  // every fade step is actually exercised
  });

  it('rests dim: copper no flow, wake or answer touches shows COPPER_REST in the frame', () => {
    const w = world();
    const render = renderer();
    const comps = compCellSet(w);
    const owner = new Map<string, string>();
    for (const net of w.nets) for (const c of net.cells) owner.set(`${c.x},${c.y}`, net.color);
    let checked = 0;
    for (const t of [0, 97, 200]) {
      const d = dataOf(render(t));
      const touched = [flowCells(w, t), spikeCells(w, t), new Set(wakeCellsAt(w.wake, t).map(c => `${c.x},${c.y}`))];
      for (const [k, color] of owner) {
        const [x, y] = k.split(',').map(Number);
        if (comps.has(k) || x >= FINGERS[0].x || x < 0 || y < 0 || y >= GRID_H || touched.some(s => s.has(k))) continue;
        expect(`t${t} ${k} ${hexAt(d, x, y)}`).toBe(`t${t} ${k} ${mixOnBg(color, COPPER_REST)}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('paints the resting arbor into the static layer, in the void', () => {
    const w = world();
    const data = staticData();
    expect(w.tissue.staticCells.length).toBeGreaterThan(100);
    for (const c of w.tissue.staticCells)
      expect(`${c.x},${c.y} ${hexAt(data, c.x, c.y)}`).toBe(`${c.x},${c.y} ${c.color}`);
  });

  it('paints the tissue\'s dynamic overlay unless a soup particle or a flow is on the cell', () => {
    const w = world();
    const render = renderer();
    let checked = 0;
    for (const t of SPREAD) {
      const d = dataOf(render(t));
      const covered = [flowCells(w, t), soupCells(w, t)];
      const last = new Map<string, string>();      // a later cell of one frame repaints an earlier one
      for (const c of tissueCellsAt(w.tissue, t)) last.set(`${c.x},${c.y}`, c.color);
      for (const [k, color] of last) {
        if (covered.some(s => s.has(k))) continue;
        const [x, y] = k.split(',').map(Number);
        expect(`t${t} ${k} ${hexAt(d, x, y)}`).toBe(`t${t} ${k} ${color}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('washes the answering chip on arrival and releases it after hold + fade', () => {
    const w = world();
    const render = renderer();
    const base = staticData();
    const a = w.answers[0];
    expect(a).toBeDefined();
    const r = w.components[a.component].rect;
    const diff = (p: Uint8ClampedArray, q: Uint8ClampedArray): number => {
      let n = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (hexAt(p, x, y) !== hexAt(q, x, y)) n++;
      return n;
    };
    const at = (k: number): number => ((a.arriveFrame + k) % T + T) % T;
    const on = dataOf(render(at(1)));
    expect(diff(on, base)).toBeGreaterThan(4);
    expect(diff(on, dataOf(render(at(-1))))).toBeGreaterThan(4);
    // The same frame from a world without THIS answer: other answers (same chip) stay, so a
    // later answer's own wash cannot pass for this one's residue.
    const without = createRenderer({ ...w, answers: w.answers.filter(x => x !== a) });
    expect(diff(on, dataOf(without(at(1))))).toBeGreaterThan(4);                // it IS the answer wash
    const late = ANSWER_HOLD + ANSWER_FADE + 2;
    expect(diff(dataOf(render(at(late))), dataOf(without(at(late))))).toBe(0);  // and it is gone
  });

  it('runs the answer spike: a white head on its path, painted over the flows', () => {
    const w = world();
    const render = renderer();
    const a = w.answers[0];
    const L = a.path.length;
    let checked = 0;
    for (const frac of [0.3, 0.5, 0.7]) {
      const target = Math.floor(L * frac);
      // the first age whose head cell is on the path at `target` or later, and paintable
      let age = Math.floor(target / 2.5);
      while (age < Math.ceil(L / 2.5) - 1 && a.hidden?.[Math.floor(age * 2.5)]) age++;
      const i = Math.floor(age * 2.5);
      if (a.hidden?.[i]) continue;
      const t = (a.recording.frame + age) % T;
      const others = w.answers.filter(x => x !== a).flatMap(x => answerSpikeAt([x], t, T));
      const p = a.path[i];
      if (others.some(c => c.x === p.x && c.y === p.y)) continue;
      expect(`t${t} ${p.x},${p.y} ${hexAt(dataOf(render(t)), p.x, p.y)}`).toBe(`t${t} ${p.x},${p.y} #ffffff`);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every colour the void shows is soup, a flow, VOID_BG or one of TISSUE_COLOURS', () => {
    const w = world();
    const render = renderer();
    const allowed = new Set<string>([VOID_BG, ...TISSUE_COLOURS]);
    const stray = new Map<string, number>();
    let tissueSeen = 0;
    for (let t = 0; t < T; t += 24) {
      const d = dataOf(render(t));
      const covered = [flowCells(w, t), soupCells(w, t)];
      for (let y = 0; y < GRID_H; y++)
        for (let x = BOARD_RIGHT + 1; x < GRID_W; x++) {
          if (covered.some(s => s.has(`${x},${y}`))) continue;
          const c = hexAt(d, x, y);
          if (allowed.has(c)) { if (c !== VOID_BG) tissueSeen++; } else stray.set(c, (stray.get(c) ?? 0) + 1);
        }
    }
    expect(JSON.stringify([...stray])).toBe('[]');
    expect(tissueSeen).toBeGreaterThan(1000);
  });
});

describe('reading frames without leaking native memory', () => {
  // `ctx.getImageData` in @napi-rs/canvas 1.0.2 leaves about 1.5 MB of native
  // memory behind per call that V8 never sees, and a fresh canvas per frame
  // left more: measured 1.37 GB per 288-frame pass, 28 GB over the suite.
  it('readFrame returns exactly the bytes getImageData does', () => {
    const canvas = renderer()(97);
    const viaContext = canvas.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT).data;
    const viaRead = readFrame(canvas);
    expect(viaRead).toBeInstanceOf(Uint8ClampedArray);
    expect(Buffer.compare(Buffer.from(viaRead), Buffer.from(viaContext))).toBe(0);
  });

  it('readFrame returns a copy, so a later render cannot change a frame already read', () => {
    const render = renderer();
    const first = readFrame(render(40));
    const snapshot = Buffer.from(first);
    render(41);
    expect(Buffer.compare(Buffer.from(first), snapshot)).toBe(0);
  });

  it('one canvas serves every frame', () => {
    const render = renderer();
    expect(render(1)).toBe(render(2));
  });

  it('a full pass of rendered and read frames does not grow resident memory', () => {
    const render = renderer();
    for (let t = 0; t < 40; t++) readFrame(render(t));      // warm up allocators
    const before = process.memoryUsage().rss;
    for (let t = 0; t < T; t++) readFrame(render(t));
    const grownMb = (process.memoryUsage().rss - before) / 1048576;
    console.log(`resident growth over one ${T}-frame pass: ${grownMb.toFixed(0)} MB`);
    expect(grownMb).toBeLessThan(300);                      // the leak measured ~1370 MB
  });
});
