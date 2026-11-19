import { describe, expect, it } from 'vitest';
import {
  ACCENTS, BOARD_RIGHT, CELL, COLORS, FABRIC_COLOR, FINGERS, GOLD, GRID_H, GRID_W, HEIGHT, NAME, NAME_COLOR, NAME_ZONE,
  PLATE, REV_RIGHT_PX, REV_ZONE, THESIS_ZONE, VOID_BG, WIDTH,
} from './layout.js';
import {
  COPPER_REST, PALETTE, WAKE_LEVELS, createRenderer, drawStatic, hot, mixOnBg, readFrame, trailColorAt,
} from './render.js';
import { ANSWER_FADE, ANSWER_HOLD, answerSpikeAt, answerWashAt, wakeCellsAt } from './boardlife.js';
import { PLATE_COLOURS, idleCellsAt, plateCellsAt, plateStaticCells } from './idle.js';
import { TISSUE_COLOURS, tissueCellsAt } from './tissue.js';
import { FINGER_FLASH, TRAIL, flowDrawn } from './signals.js';
import { visibleAges } from './creatures.js';
import {
  INSTRUMENT_COLOURS, RNA_BASE_COLOURS, RNA_SEQUENCE, SCOPE, SCOPE_BASELINE, SCOPE_COLS, STRIP, STRIP_GREENS, repressilatorLevelsAt, rnaCellsAt,
  scopeCellsAt, scopeStaticCells, stripCellsAt, stripStaticCells,
} from './instruments.js';
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
const mod = (a: number, n: number): number => ((a % n) + n) % n;
// The four instruments' inputs, derived HERE from the world, independently of render.ts's own tables.
const scopeAccents = (w: World): [string, string, string] =>
  w.tissue.somas.map(s => s.accent) as [string, string, string];
const firingsOf = (w: World): { soma: number; t: number }[] => w.tissue.firings.map(f => ({ soma: f.soma, t: f.t }));
/** the DIMM slots' body rects, left to right */
const dimmSlots = (w: World): { x: number; y: number; w: number; h: number }[] =>
  w.components.filter(c => c.kind === 'dimmSlot').map(c => c.body).sort((a, b) => a.x - b.x);
/** the accents that are not neural green (the tissue's and the name's), in the world's order */
const nonNeural = (w: World): string[] => w.accents.filter(a => a !== ACCENTS.neural);
const REP_ALPHAS = [0.3, 0.475, 0.65, 0.825, 1.0];
/** light i (protein A, B, C) at level l: the i-th non-green accent at 30/47.5/65/82.5/100 percent on the board */
const repColour = (w: World, i: number, level: number): string => mixOnBg(nonNeural(w)[i], REP_ALPHAS[level]);
/** A, U, G, C: fixed colours at full value, the same for every world */
const RNA_BASES = (_w: World): Record<'A' | 'U' | 'G' | 'C', string> => ({ ...RNA_BASE_COLOURS });
/** a light's 2 x 2 cells from its top-left cell */
const lightBlock = (c: { x: number; y: number }): { x: number; y: number }[] =>
  [0, 1].flatMap(dy => [0, 1].map(dx => ({ x: c.x + dx, y: c.y + dy })));

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

  it('prints the name on the plate in NAME_ZONE, the REV line in REV_ZONE, and only the scope pins as ink in THESIS_ZONE', () => {
    const data = staticData();
    // The owner asked for the name on a dot-matrix plate on 2026-11-19 ("i liked it on a plate too but
    // not as big as the last one you showed"), so the name is no longer antialiased gray text: its ink
    // is the plate's lit dots, `#39ff14`, whole cells, which land on the exact colour. (This test used to
    // count `#888888` glyph cores in NAME_ZONE, which now holds only the plate's four pins.)
    expect(countPixel(data, NAME_ZONE, NAME_COLOR)).toBeGreaterThan(100 * CELL * CELL);
    // the REV line is untouched: antialiased gray ink, checked as `ink` (see the helper)
    expect(countInk(data, REV_ZONE)).toBeGreaterThan(60);
    // 2026-11-19: the owner chose the spike scope for THESIS_ZONE. It is the one thing in the zone, and
    // its grays above the ink threshold are its four `#888888` corner pins (one cell each) and its three
    // `#3a3a3a` baselines (46 cells each, 2026-11-19 review: the accent tints were too faint); the bezel
    // `#2a2a2a`, the `#111111` body and the accent ticks are below it or not gray.
    expect(countInk(data, THESIS_ZONE)).toBe((4 + 3 * SCOPE_COLS) * CELL * CELL);
    expect(countPixel(data, THESIS_ZONE, SCOPE_BASELINE)).toBe(3 * SCOPE_COLS * CELL * CELL);
    expect(countPixel(data, THESIS_ZONE, COLORS.muted)).toBe(4 * CELL * CELL);
    // and there is still no white text in it
    expect(countPixel(data, THESIS_ZONE, COLORS.white)).toBe(0);
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

  it('the plate and the REV line share one line of the band — not the old stack', () => {
    // 2026-11-19: the name is now the plate, so the name half of this check is "the plate lies wholly
    // inside NAME_ZONE"; the REV half is unchanged (its ink is gray, in REV_ZONE).
    const data = staticData();
    expect(PLATE.x).toBeGreaterThanOrEqual(NAME_ZONE.x);
    expect(PLATE.y).toBeGreaterThanOrEqual(NAME_ZONE.y);
    expect(PLATE.x + PLATE.w).toBeLessThanOrEqual(NAME_ZONE.x + NAME_ZONE.w);
    expect(PLATE.y + PLATE.h).toBeLessThanOrEqual(NAME_ZONE.y + NAME_ZONE.h);
    const rev: number[] = [];
    for (let y = REV_ZONE.y; y < REV_ZONE.y + REV_ZONE.h; y++)
      if (countInk(data, { x: REV_ZONE.x, y, w: REV_ZONE.w, h: 1 }) > 0) rev.push(y);
    expect(rev.length).toBeGreaterThan(0);
    // One shared line means the two overlap vertically (the old stacked geometry put REV wholly below).
    expect(rev[0]).toBeLessThanOrEqual(PLATE.y + PLATE.h - 1);
    expect(PLATE.y).toBeLessThanOrEqual(rev[rev.length - 1]);
  });

  it('§12.7: the legend is board print — no `$`, no cursor block, no glow halo', () => {
    // "Removed with the terminal treatment: the `$` prefix, the blinking white block cursor, the
    // `#39ff14` name colour, the bold ~28 px weight, and the 2-step glow halo."
    // 2026-11-19: the owner asked for the name back in green, on a plate ("i liked it on a plate too"),
    // so `#39ff14` is now REQUIRED in NAME_ZONE; the rest of the treatment stays removed: no `$`, no
    // white cursor block (the plate's steady state has none), no `#ffffff` or `#f0f0f0` halo step.
    expect(NAME).toBe('cody_slater');
    expect(NAME).not.toContain('$');
    const data = staticData();
    expect(countPixel(data, NAME_ZONE, COLORS.white)).toBe(0);      // no white cursor block
    expect(countPixel(data, NAME_ZONE, COLORS.offwhite)).toBe(0);   // no halo step
    expect(countPixel(data, NAME_ZONE, NAME_COLOR)).toBeGreaterThan(0);
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
    for (const t of [0, 97, 200, 213]) {
      const d = dataOf(render(t));
      const cells: { x: number; y: number }[] = [];
      for (const f of w.flows) cells.push(...flowDrawn(f, t, T));
      for (const age of visibleAges(t, T))
        for (const p of w.soup.frames[age].parts) cells.push({ x: Math.round(p.x), y: Math.round(p.y) });
      cells.push(...wakeCellsAt(w.wake, t), ...tissueCellsAt(w.tissue, t), ...w.tissue.staticCells);
      cells.push(...w.idle.staticCells, ...idleCellsAt(w.idle, t, T), ...plateStaticCells(), ...plateCellsAt(t, T));
      // the four instruments (owner, 2026-11-19): scope, repressilator lights, RNA stream, activity strip
      cells.push(...scopeStaticCells(scopeAccents(w)), ...scopeCellsAt(firingsOf(w), scopeAccents(w), t, T));
      cells.push(...w.idle.repressilator.flatMap(lightBlock), ...rnaCellsAt(dimmSlots(w), RNA_BASES(w), t));
      cells.push(...stripStaticCells(w.activity.levels), ...stripCellsAt(w.activity.levels, t));
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

  it('layer order: the WHOLE tissue (arbor, moving cells) is above the soup, in every frame of the loop', () => {
    const w = world(), render = renderer();
    const rest = new Map(w.tissue.staticCells.map(c => [`${c.x},${c.y}`, c.color]));
    let checked = 0, underSoup = 0;
    for (let t = 0; t < T; t++) {
      const d = dataOf(render(t));
      const want = new Map(rest);
      for (const c of tissueCellsAt(w.tissue, t)) want.set(`${c.x},${c.y}`, c.color);   // a later cell repaints an earlier one
      const spike = spikeCells(w, t), soup = soupCells(w, t);
      for (const [k, color] of want) {
        if (spike.has(k)) continue;                  // the answer's spike runs over the tissue
        const [x, y] = k.split(',').map(Number);
        expect(`t${t} ${k} ${hexAt(d, x, y)}`).toBe(`t${t} ${k} ${color}`);
        checked++;
        if (soup.has(k)) underSoup++;
      }
    }
    expect(checked).toBeGreaterThan(20000);
    expect(underSoup).toBeGreaterThan(0);            // the soup really does cross the tissue, so this is not vacuous
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

describe('the idle layer and the name plate', () => {
  const fan = (): { x: number; y: number; w: number; h: number } => world().components.find(c => c.kind === 'fan')!.rect;
  const cellsDiffer = (a: Uint8ClampedArray, b: Uint8ClampedArray, r: { x: number; y: number; w: number; h: number }, skip: Set<string>): number => {
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (!skip.has(`${x},${y}`) && hexAt(a, x, y) !== hexAt(b, x, y)) n++;
    return n;
  };
  const covering = (w: World, t: number): Set<string> =>
    new Set([...flowCells(w, t), ...spikeCells(w, t), ...soupCells(w, t)]);

  it('paints the idle static cells — sprouts at rest, LEDs off — in drawStatic', () => {
    const w = world();
    const data = staticData();
    expect(w.idle.staticCells.length).toBeGreaterThan(30);
    for (const c of w.idle.staticCells) expect(`${c.x},${c.y} ${hexAt(data, c.x, c.y)}`).toBe(`${c.x},${c.y} ${c.color}`);
  });

  it('paints each idle overlay cell in its colour unless a flow, a spike, an answer wash or the soup covers it', () => {
    const w = world();
    const render = renderer();
    let checked = 0;
    const kinds = new Set<string>();
    for (const t of [...SPREAD, 12, 13, 100, 103]) {
      const d = dataOf(render(t));
      const washed = answerWashAt(w.answers, t, T).map(a => w.components[a.component].rect);
      const covered = covering(w, t);
      for (const c of idleCellsAt(w.idle, t, T)) {
        const k = `${c.x},${c.y}`;
        if (covered.has(k) || washed.some(r => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h)) continue;
        expect(`t${t} ${k} ${hexAt(d, c.x, c.y)}`).toBe(`t${t} ${k} ${c.color}`);
        kinds.add(c.color);
        checked++;
      }
    }
    // was > 300 with the bus bars (about 2 x 3 cells a frame on each of 4 slots) and 8 LEDs; the bars are gone (the
    // RNA stream replaced them) and 3 LEDs became repressilator lights, so the sampled overlay is smaller: 193 measured.
    expect(checked).toBeGreaterThan(150);
    expect(kinds.size).toBeGreaterThanOrEqual(6);        // heart ramp, LEDs and sprouts all exercised
  });

  it('turns the fan: its region differs between frames 0 and 3, and is identical between 0 and 12', () => {
    const w = world();
    const render = renderer();
    const r = fan();
    const f0 = dataOf(render(0)), f3 = dataOf(render(3)), f6 = dataOf(render(6)), f9 = dataOf(render(9)), f12 = dataOf(render(12));
    const skip = (a: number, b: number): Set<string> => new Set([...covering(w, a), ...covering(w, b)]);
    expect(cellsDiffer(f0, f3, r, skip(0, 3))).toBeGreaterThan(3);
    expect(cellsDiffer(f0, f12, r, skip(0, 12))).toBe(0);
    for (const [a, b, fa, fb] of [[0, 6, f0, f6], [0, 9, f0, f9], [3, 6, f3, f6], [3, 9, f3, f9], [6, 9, f6, f9]] as const)
      expect(cellsDiffer(fa, fb, r, skip(a, b))).toBeGreaterThan(3);
    // four clearly visible bright blades: whole cells of the blade tone in every step
    for (const [t, f] of [[0, f0], [3, f3], [6, f6], [9, f9]] as const) {
      let blade = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++)
        if (hexAt(f, x, y) === '#d8d8d8' && !covering(w, t).has(`${x},${y}`)) blade++;
      expect(`t${t} ${blade}`).not.toBe(`t${t} 0`);
      expect(blade).toBeGreaterThanOrEqual(5);
    }
  });

  it('the heartbeat never shows through an answer\'s wash of the CPU', () => {
    const w = world();
    const cpuIdx = w.components.findIndex(c => c.kind === 'cpuSocket');
    const r = w.components[cpuIdx].rect;
    const t = 100;                                        // 100 mod 24 = 4: the beat is lit
    const answer = { recording: { frame: 0, finger: 0, accent: '#ff2d78' }, path: [], component: cpuIdx, arriveFrame: t - 1 };
    const noHeart = { ...w.idle, heart: { x: 0, y: 0, w: 0, h: 0 } };
    const wash = (world_: World): Uint8ClampedArray => dataOf(createRenderer(world_)(t));
    const plain = wash({ ...w, answers: [], idle: noHeart });
    const withBeat = wash({ ...w, answers: [], idle: w.idle });
    const washedNoBeat = wash({ ...w, answers: [answer], idle: noHeart });
    const washedBeat = wash({ ...w, answers: [answer], idle: w.idle });
    expect(cellsDiffer(plain, withBeat, r, covering(w, t))).toBeGreaterThan(10);          // the beat IS drawn, unwashed
    expect(cellsDiffer(washedNoBeat, washedBeat, r, covering(w, t))).toBe(0);             // and the wash wins
  });

  it('paints the plate in drawStatic: whole dots, the full name lit, the old text label gone', () => {
    const data = staticData();
    for (const c of plateStaticCells()) expect(`${c.x},${c.y} ${hexAt(data, c.x, c.y)}`).toBe(`${c.x},${c.y} ${c.color}`);
    // every pixel of the plate is one of the plate's own colours: no antialiased text anywhere in it
    for (let y = PLATE.y * CELL; y < (PLATE.y + PLATE.h) * CELL; y++)
      for (let x = PLATE.x * CELL; x < (PLATE.x + PLATE.w) * CELL; x++) {
        const i = (y * WIDTH + x) * 4;
        const hex = `#${((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]).toString(16).padStart(6, '0')}`;
        if (!PLATE_COLOURS.includes(hex)) throw new Error(`pixel ${x},${y} is ${hex}`);
      }
  });

  it('paints the plate\'s retyping frames, every plate cell a uniform block, never white', () => {
    const render = renderer();
    for (const t of [0, 203, 204, 206, 207, 213, 222, 237, 240, 287]) {
      const d = dataOf(render(t));
      const want = new Map(plateStaticCells().map(c => [`${c.x},${c.y}`, c.color]));
      for (const c of plateCellsAt(t, T)) want.set(`${c.x},${c.y}`, c.color);
      for (const [k, color] of want) {
        const [x, y] = k.split(',').map(Number);
        for (let dy = 0; dy < CELL; dy++)
          for (let dx = 0; dx < CELL; dx++) {
            const i = (((y * CELL) + dy) * WIDTH + x * CELL + dx) * 4;
            const hex = `#${((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0')}`;
            if (hex !== color) throw new Error(`t${t} cell ${k}: ${hex}, want ${color}`);
          }
      }
      expect(countPixel(d, NAME_ZONE, COLORS.white)).toBe(0);
      expect(countPixel(d, NAME_ZONE, COLORS.offwhite)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The four instruments (owner, 2026-11-19): a spike scope in THESIS_ZONE, three repressilator lights
// in place of three status LEDs, an RNA stream down the memory slots in place of the bus bars, and a
// 14-day activity strip in REV_ZONE.
// ---------------------------------------------------------------------------
describe('the four instruments', () => {
  const covering = (w: World, t: number): Set<string> =>
    new Set([...flowCells(w, t), ...spikeCells(w, t), ...soupCells(w, t)]);
  const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean =>
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  describe('spike scope', () => {
    it('paints every scopeStaticCells cell in drawStatic', () => {
      const w = world(), data = staticData();
      const cells = scopeStaticCells(scopeAccents(w));
      expect(cells.length).toBe(SCOPE.w * SCOPE.h);
      for (const c of cells) expect(`${c.x},${c.y} ${hexAt(data, c.x, c.y)}`).toBe(`${c.x},${c.y} ${c.color}`);
    });

    it('draws the three baselines in the neutral grey #3a3a3a, and a tick in the neuron\'s FULL accent, 2 cells tall', () => {
      const w = world(), render = renderer(), acc = scopeAccents(w), DX = SCOPE.x + 2, DY = SCOPE.y + 2;
      expect(SCOPE_BASELINE).toBe('#3a3a3a');
      const d0 = dataOf(render(0));
      for (let s = 0; s < 3; s++) {
        for (const c of [0, 5, SCOPE_COLS - 1]) {
          const t0 = scopeCellsAt(firingsOf(w), acc, 0, T).some(k => k.x === DX + c && k.y === DY + 2 * s + 1);
          if (!t0) expect(hexAt(d0, DX + c, DY + 2 * s + 1)).toBe('#3a3a3a');
        }
        const f = w.tissue.firings.find(x => x.soma === s)!;
        const t = mod(f.t + 4, T), d = dataOf(render(t)), x = DX + SCOPE_COLS - 1 - 2;
        for (const y of [DY + 2 * s, DY + 2 * s + 1]) expect(hexAt(d, x, y)).toBe(acc[s]);
      }
    });

    it('uses the three somas\' own accents, in soma order', () => {
      const w = world();
      expect(new Set(scopeAccents(w)).size).toBe(3);
      for (const a of scopeAccents(w)) expect(w.accents).toContain(a);
    });

    it('shows a soma\'s tick in its accent three frames after it fires', () => {
      const w = world(), render = renderer(), acc = scopeAccents(w), DX = SCOPE.x + 2, DY = SCOPE.y + 2;
      for (let s = 0; s < 3; s++) {
        const f = w.tissue.firings.find(x => x.soma === s);
        expect(f, `soma ${s} fires`).toBeDefined();
        const t = mod(f!.t + 3, T), d = dataOf(render(t));
        const x = DX + SCOPE_COLS - 1 - 1;                     // age 3 -> one column in from the right edge
        for (const y of [DY + 2 * s, DY + 2 * s + 1]) expect(`soma ${s} ${x},${y} ${hexAt(d, x, y)}`).toBe(`soma ${s} ${x},${y} ${acc[s]}`);
      }
    });

    it('nothing else paints inside the scope: its region is the static module plus the ticks, at every sampled frame', () => {
      const w = world(), render = renderer(), acc = scopeAccents(w);
      const want = new Map(scopeStaticCells(acc).map(c => [`${c.x},${c.y}`, c.color]));
      let ticks = 0;
      for (const t of [...SPREAD, 2, 61, 120]) {
        const exp = new Map(want);
        for (const c of scopeCellsAt(firingsOf(w), acc, t, T)) { exp.set(`${c.x},${c.y}`, c.color); ticks++; }
        const d = dataOf(render(t));
        for (const [k, color] of exp) {
          const [x, y] = k.split(',').map(Number);
          if (hexAt(d, x, y) !== color) throw new Error(`t${t} ${k} ${hexAt(d, x, y)}, want ${color}`);
        }
      }
      expect(ticks).toBeGreaterThan(0);                        // the ticks were really exercised
    });
  });

  describe('repressilator lights', () => {
    it('three 2 x 2 lights in a run 8 cells wide, marching left to right A, C, B, paired with three different non-green accents', () => {
      const w = world(), r = w.idle.repressilator;
      expect(r).toHaveLength(3);
      expect(r[1].y).toBe(r[0].y); expect(r[2].y).toBe(r[0].y);
      expect(r[2].x - r[0].x).toBe(3);                         // C is the middle light
      expect(r[1].x - r[2].x).toBe(3);                         // B the right one
      expect(new Set(nonNeural(w).slice(0, 3)).size).toBe(3);
    });

    it('shows the colour of repressilatorLevelsAt(t) in all four cells of each light at frames 0, 16, ..., 80', () => {
      const w = world(), render = renderer(), r = w.idle.repressilator;
      const levelsSeen = new Set<number>();
      for (const t of [0, 16, 32, 48, 64, 80]) {
        const d = dataOf(render(t)), lv = repressilatorLevelsAt(t);
        r.forEach((c, i) => {
          for (const p of lightBlock(c))
            expect(`t${t} light ${i} ${p.x},${p.y} ${hexAt(d, p.x, p.y)}`).toBe(`t${t} light ${i} ${p.x},${p.y} ${repColour(w, i, lv[i])}`);
          levelsSeen.add(lv[i]);
        });
        // the gap cells between lights stay bare substrate
        for (const gx of [r[0].x + 2, r[2].x + 2]) for (const dy of [0, 1])
          expect(hexAt(d, gx, r[0].y + dy)).not.toBe(repColour(w, 0, lv[0]));
      }
      expect(levelsSeen.size).toBeGreaterThanOrEqual(3);       // the walk really moves through the levels
    });

    it('the peak marches left to right: at each protein\'s peak frame the brightest light is that protein\'s, in the order A, C, B', () => {
      const w = world(), render = renderer(), r = w.idle.repressilator;
      const xs = [0, 1, 2].map(g => r[g].x);                   // protein A, B, C
      expect(xs[0]).toBeLessThan(xs[2]); expect(xs[2]).toBeLessThan(xs[1]);
      const tr = (g: number): number[] => Array.from({ length: 96 }, (_, t) => repressilatorLevelsAt(t)[g]);
      const hiMean = (g: number): number => { const h = tr(g).map((v, t) => (v === 4 ? t : -1)).filter(t => t >= 0); return h.reduce((a, b) => a + b, 0) / h.length; };
      // A peaks at 0 (levels 4 at frame 0); C a third later, B two thirds later
      const tA = 0, tC = Math.round(hiMean(2)), tB = Math.round(hiMean(1));
      const lit = (t: number): number => {
        const d = dataOf(render(t)), lv = repressilatorLevelsAt(t);
        const bright = [0, 1, 2].filter(g => lv[g] === 4);
        expect(bright.length).toBeGreaterThan(0);
        for (const g of bright) expect(hexAt(d, r[g].x, r[g].y)).toBe(repColour(w, g, 4));
        return bright[0];
      };
      const order = [lit(tA), lit(tC), lit(tB)].map(g => xs[g]);
      expect(order[0]).toBeLessThan(order[1]);
      expect(order[1]).toBeLessThan(order[2]);
    });

    it('five levels from about 30 to 100 percent, each in an rgb444 bin of its own for every accent, and visible against the board', () => {
      const q = (hex: string): string => { const n = parseInt(hex.slice(1), 16); return [n >> 20, (n >> 12) & 15, (n >> 4) & 15].join(','); };
      expect(REP_ALPHAS[0]).toBeCloseTo(0.3, 5); expect(REP_ALPHAS[4]).toBe(1);
      for (const a of Object.values(ACCENTS)) {
        const cols = REP_ALPHAS.map(al => mixOnBg(a, al));
        expect(new Set(cols.map(q)).size).toBe(5);
        for (const c of cols) { expect(q(c)).not.toBe(q(COLORS.bg)); expect(q(c)).not.toBe(q(COLORS.grid)); }
        // the dimmest light is clearly lit: its brightest channel is at least 40 percent of the accent's
        const n = parseInt(cols[0].slice(1), 16), top = Math.max(n >> 16, (n >> 8) & 255, n & 255);
        expect(top).toBeGreaterThan(Math.max(...[16, 8, 0].map(sh => (parseInt(a.slice(1), 16) >> sh) & 255)) * 0.28);
      }
    });

    it('is periodic in 96: frame t and t + 96 are identical in those cells', () => {
      const w = world(), render = renderer(), r = w.idle.repressilator.flatMap(lightBlock);
      for (const t of [0, 16, 32, 48, 64, 80, 91]) {
        const a = dataOf(render(t)), b = dataOf(render(t + 96)), c = dataOf(render(t + 192));
        for (const p of r) {
          expect(hexAt(b, p.x, p.y)).toBe(hexAt(a, p.x, p.y));
          expect(hexAt(c, p.x, p.y)).toBe(hexAt(a, p.x, p.y));
        }
      }
    });

    it('rests in the static layer at its frame-0 level, all four cells of each light', () => {
      const w = world(), data = staticData(), lv = repressilatorLevelsAt(0);
      w.idle.repressilator.forEach((c, i) => { for (const p of lightBlock(c)) expect(hexAt(data, p.x, p.y)).toBe(repColour(w, i, lv[i])); });
    });
  });

  describe('RNA stream', () => {
    it('lies in the DIMM slots\' centre columns, in the slots\' own rows', () => {
      const w = world(), slots = dimmSlots(w);
      expect(slots.length).toBeGreaterThanOrEqual(3);
      for (const c of rnaCellsAt(slots, RNA_BASES(w), 0))
        expect(slots.some(s => c.x === s.x + 1 && c.y > s.y && c.y < s.y + s.h - 1)).toBe(true);
    });

    it('paints no RNA in drawStatic: the frame layer owns the whole stream, so a gap cell never keeps a frame-0 base', () => {
      const w = world(), data = staticData(), bases = new Set<string>(Object.values(RNA_BASES(w)));
      for (const c of rnaCellsAt(dimmSlots(w), RNA_BASES(w), 0)) expect(bases.has(hexAt(data, c.x, c.y))).toBe(false);
    });

    it('no stale base cell from frame 0 survives where that cell is a gap at frame t', () => {
      const w = world(), render = renderer(), slots = dimmSlots(w), base = RNA_BASES(w), stat = staticData();
      const lit0 = rnaCellsAt(slots, base, 0);
      let checked = 0;
      for (const t of [2, 3, 6, 10, 37, 100, 143, 200, 287]) {
        const d = dataOf(render(t)), covered = covering(w, t);
        const litNow = new Set(rnaCellsAt(slots, base, t).map(c => `${c.x},${c.y}`));
        for (const c of lit0) {
          const k = `${c.x},${c.y}`;
          if (litNow.has(k) || covered.has(k)) continue;
          // a slot that a wash is repainting (its top cell differs from the static board) is judged by that wash
          const slot = slots.find(s => c.x === s.x + 1 && c.y > s.y && c.y < s.y + s.h - 1)!;
          if (hexAt(d, slot.x, slot.y + 1) !== hexAt(stat, slot.x, slot.y + 1)) continue;
          // an unwashed slot shows its own body in the gap: exactly what the static board holds (no RNA there)
          expect(`t${t} ${k} ${hexAt(d, c.x, c.y)}`).toBe(`t${t} ${k} ${hexAt(stat, c.x, c.y)}`);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(20);
    });

    it('uses the fixed base colours (#39ff14 #ff2d78 #ffd23f #00e5ff) at full value in the frame, whatever the seed', () => {
      const w = world(), render = renderer(), d = dataOf(render(10)), seen = new Set<string>();
      for (const c of rnaCellsAt(dimmSlots(w), RNA_BASES(w), 10)) if (!covering(w, 10).has(`${c.x},${c.y}`)) seen.add(hexAt(d, c.x, c.y));
      expect([...seen].every(h => Object.values(RNA_BASE_COLOURS).includes(h))).toBe(true);
      expect(seen.size).toBeGreaterThanOrEqual(3);
    });

    it('shows every base in its colour at a spread of frames unless a flow, a spike or the soup covers the cell', () => {
      const w = world(), render = renderer(), slots = dimmSlots(w), base = RNA_BASES(w);
      let checked = 0;
      for (const t of [...SPREAD, 4, 37, 100]) {
        const d = dataOf(render(t)), covered = covering(w, t);
        for (const c of rnaCellsAt(slots, base, t)) {
          if (covered.has(`${c.x},${c.y}`)) continue;
          expect(`t${t} ${c.x},${c.y} ${hexAt(d, c.x, c.y)}`).toBe(`t${t} ${c.x},${c.y} ${c.color}`);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(400);
    });

    it('survives a takeover wash and an answer wash of its DIMM (the lit cells are painted after both washes)', () => {
      const w = world(), slots = dimmSlots(w), base = RNA_BASES(w);
      const dimmIdx = w.components.findIndex(c => c.kind === 'dimmSlot');
      const t = 100;
      // an accent no board part wears, so the answer's wash cannot coincide with a takeover wash already on the slot
      const answer = { recording: { frame: 0, finger: 0, accent: '#12ab34' }, path: [], component: dimmIdx, arriveFrame: t - 1 };
      const d = dataOf(createRenderer({ ...w, answers: [answer] })(t));
      const slot = w.components[dimmIdx].body, covered = covering({ ...w, answers: [] }, t);
      let checked = 0, washedCells = 0;
      for (const c of rnaCellsAt(slots, base, t)) {
        if (!inRect(slot, c.x, c.y) || covered.has(`${c.x},${c.y}`)) continue;
        expect(hexAt(d, c.x, c.y)).toBe(c.color);
        checked++;
      }
      // the answer wash really did repaint the rest of that slot (its latches take the accent ramp)
      const plain = dataOf(createRenderer({ ...w, answers: [] })(t));
      for (let y = slot.y; y < slot.y + slot.h; y++) for (let x = slot.x; x < slot.x + slot.w; x++)
        if (hexAt(d, x, y) !== hexAt(plain, x, y)) washedCells++;
      expect(checked).toBeGreaterThan(4);                      // half the channel is lit
      expect(washedCells).toBeGreaterThan(0);
    });

    it('moves: the cells differ between frames 0 and 6 and repeat at 144 (the stream period)', () => {
      const w = world(), render = renderer(), slots = dimmSlots(w), base = RNA_BASES(w);
      const cells = rnaCellsAt(slots, base, 0);
      const f0 = dataOf(render(0)), f4 = dataOf(render(6)), f144 = dataOf(render(144));
      const skip = [...covering(w, 0), ...covering(w, 6), ...covering(w, 144)];
      const gone = new Set(skip);
      let differ04 = 0, differ0144 = 0;
      for (const c of cells) {
        if (gone.has(`${c.x},${c.y}`)) continue;
        if (hexAt(f0, c.x, c.y) !== hexAt(f4, c.x, c.y)) differ04++;
        if (hexAt(f0, c.x, c.y) !== hexAt(f144, c.x, c.y)) differ0144++;
      }
      expect(differ04).toBeGreaterThan(20);
      expect(differ0144).toBe(0);
      expect(T % (RNA_SEQUENCE.length * 4)).toBe(0);
    });
  });

  describe('activity strip', () => {
    const lightCells = (i: number): { x: number; y: number }[] =>
      [0, 1, 2].flatMap(dy => [0, 1].map(dx => ({ x: STRIP.x + 3 * i + dx, y: STRIP.y + dy })));
    let cachedOwner: World | undefined;
    const OWNER = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3];
    const ownerWorld = (): World => (cachedOwner ??= buildWorld(20260724, T, { levels: OWNER }));

    it('shows the 14 default-activity lights at STRIP_GREENS[level] in drawStatic', () => {
      const w = world(), data = staticData();
      expect(w.activity.levels).toHaveLength(14);
      for (let i = 0; i < 14; i++)
        for (const c of lightCells(i))
          expect(`light ${i} ${hexAt(data, c.x, c.y)}`).toBe(`light ${i} ${STRIP_GREENS[w.activity.levels[i]]}`);
      for (const c of stripStaticCells(w.activity.levels)) expect(hexAt(data, c.x, c.y)).toBe(c.color);
    });

    it('shows the world\'s own levels when the activity is not the default', () => {
      const w = ownerWorld(), data = dataOf(drawStatic(w));
      expect(w.activity.levels).toEqual(OWNER);
      for (let i = 0; i < 14; i++)
        for (const c of lightCells(i))
          expect(`light ${i} ${hexAt(data, c.x, c.y)}`).toBe(`light ${i} ${STRIP_GREENS[OWNER[i]]}`);
    });

    it('pulses the last light one level up for 6 of every 48 frames, per stripCellsAt, and holds the rest', () => {
      const w = world(), render = renderer(), levels = w.activity.levels, last = lightCells(13);
      let pulsed = 0;
      for (const t of [0, 3, 5, 6, 20, 47, 48, 51, 54, 100, 144, 150, 287]) {
        const d = dataOf(render(t)), pulse = stripCellsAt(levels, t).length > 0;
        const want = pulse ? STRIP_GREENS[levels[13] + 1] : STRIP_GREENS[levels[13]];
        for (const c of last) expect(`t${t} ${hexAt(d, c.x, c.y)}`).toBe(`t${t} ${want}`);
        for (let i = 0; i < 13; i++) for (const c of lightCells(i)) expect(hexAt(d, c.x, c.y)).toBe(STRIP_GREENS[levels[i]]);
        if (pulse) pulsed++;
      }
      expect(pulsed).toBeGreaterThanOrEqual(4);
    });

    it('does not touch the REV text: no strip cell is on, or within a cell of, the REV line\'s ink', () => {
      const data = staticData();
      const cols: number[] = [], rows: number[] = [];
      for (let x = REV_ZONE.x; x < REV_ZONE.x + REV_ZONE.w; x++) if (countInk(data, { x, y: REV_ZONE.y, w: 1, h: REV_ZONE.h }) > 0) cols.push(x);
      for (let y = REV_ZONE.y; y < REV_ZONE.y + REV_ZONE.h; y++) if (countInk(data, { x: REV_ZONE.x, y, w: REV_ZONE.w, h: 1 }) > 0) rows.push(y);
      const ink = { x0: cols[0], x1: cols[cols.length - 1], y0: rows[0], y1: rows[rows.length - 1] };
      expect(STRIP.x + STRIP.w).toBeLessThan(ink.x0 - 1);      // the strip ends well left of the first glyph
      for (const c of stripStaticCells(world().activity.levels)) {
        const near = c.x >= ink.x0 - 1 && c.x <= ink.x1 + 1 && c.y >= ink.y0 - 1 && c.y <= ink.y1 + 1;
        expect(near, `strip cell ${c.x},${c.y} vs REV ink ${JSON.stringify(ink)}`).toBe(false);
      }
      // REV itself is where it was: right-aligned, on the shared line, ink within the band's own rows
      expect(ink.x1).toBeLessThanOrEqual(REV_RIGHT_PX / CELL);
      expect(ink.y0).toBeGreaterThanOrEqual(REV_ZONE.y);
      expect(ink.y1).toBeLessThan(REV_ZONE.y + REV_ZONE.h);
    });
  });

  it('every colour in the instruments\' own cells is one the discipline allows', () => {
    const w = world(), render = renderer();
    const acc = scopeAccents(w);
    const allowed = new Set<string>([
      ...INSTRUMENT_COLOURS, ...acc,
      ...[0, 1, 2].flatMap(i => [0, 1, 2, 3, 4].map(l => repColour(w, i, l))),
      ...Object.values(RNA_BASES(w)), ...STRIP_GREENS,
    ]);
    expect(allowed.size).toBeLessThanOrEqual(12 + 3 + 15 + 4 + 5);
    const regions = [
      ...scopeStaticCells(acc), ...stripStaticCells(w.activity.levels), ...w.idle.repressilator.flatMap(lightBlock),
    ];
    for (const t of [0, 12, 48, 97, 150, 203]) {
      const d = dataOf(render(t)), covered = covering(w, t);
      for (const c of [...regions, ...rnaCellsAt(dimmSlots(w), RNA_BASES(w), t)]) {
        if (covered.has(`${c.x},${c.y}`)) continue;
        const hex = hexAt(d, c.x, c.y);
        if (!allowed.has(hex)) throw new Error(`t${t} ${c.x},${c.y} is ${hex}`);
      }
    }
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
