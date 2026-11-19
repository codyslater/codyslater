import { describe, expect, it } from 'vitest';
import {
  BOARD_RIGHT, CELL, COLORS, FINGERS, FINGER_W, GRID_H, GRID_W, PLATE, NAME_COLOR, NAME_ZONE, TEXT_ZONES, WIDTH,
} from './layout.js';
import {
  HEART_RAMP, IDLE_COLOURS, PLATE_COLOURS, buildIdle, fanStepAt, idleCellsAt, plateCellsAt, plateStaticCells,
  type Idle, type IdleCell,
} from './idle.js';
import { RECORD_FINGER, DENDRITE_COLOUR } from './tissue.js';
import { buildLayout, buildGraph, fabricCells } from './layout.js';
import { buildNets } from './growth.js';
import { mulberry32 } from './rng.js';
import { drawStatic, readFrame } from './render.js';
import { buildWorld } from './timeline.js';
import type { Rect, World } from './types.js';

const T = 288;
const SEEDS = [20260724, 20260101, 20261111];
const worlds = new Map<number, World>();
const worldOf = (seed: number): World => {
  let w = worlds.get(seed);
  if (!w) { w = buildWorld(seed, T); worlds.set(seed, w); }
  return w;
};
const built = new Map<number, Idle>();
const idleOf = (seed: number): Idle => {
  let i = built.get(seed);
  if (!i) { i = buildIdle(worldOf(seed), worldOf(seed).tissue.recordings); built.set(seed, i); }
  return i;
};

const key = (x: number, y: number): string => `${x},${y}`;
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Everything the board paints in ink, re-derived here from world data (not the module's own helper). */
function ink(w: World): Set<string> {
  const s = new Set<string>();
  const addRect = (r: Rect): void => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.add(key(x, y));
  };
  for (const c of w.components) addRect(c.rect);
  for (const n of w.nets) for (const c of n.cells) s.add(key(c.x, c.y));
  for (const c of w.fabric) s.add(key(c.x, c.y));
  for (const f of FINGERS) addRect({ x: f.x, y: f.y, w: FINGER_W, h: f.h });
  for (const z of TEXT_ZONES) addRect(z);
  for (const f of w.dressing.features) {
    addRect({ x: f.rect.x - 1, y: f.rect.y - 1, w: f.rect.w + 2, h: f.rect.h + 2 });
    if (f.designator) addRect({ x: f.rect.x, y: f.rect.y - 3, w: 2 + Math.ceil(f.designator.length * 1.2), h: 3 });
  }
  for (const h of w.mountHoles)
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) s.add(key(h.x + dx, h.y + dy));
  for (const sec of w.sections) {
    if (sec.outline !== false && sec.rect.w > 0 && sec.rect.h > 0) {
      for (let x = sec.rect.x; x < sec.rect.x + sec.rect.w; x++) { s.add(key(x, sec.rect.y)); s.add(key(x, sec.rect.y + sec.rect.h - 1)); }
      for (let y = sec.rect.y; y < sec.rect.y + sec.rect.h; y++) { s.add(key(sec.rect.x, y)); s.add(key(sec.rect.x + sec.rect.w - 1, y)); }
    }
    if (sec.label) addRect({ x: sec.rect.x + 1, y: sec.rect.y - 3, w: 2 + Math.ceil(sec.label.length * 1.2), h: 4 });
  }
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++) if (x <= 4 || x >= 225 || y <= 4 || y >= 75) s.add(key(x, y));
  return s;
}
/** The cell and its 8 neighbours are all free of ink. */
const bareWithClearance = (ink_: Set<string>, x: number, y: number): boolean => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ink_.has(key(x + dx, y + dy))) return false;
  return true;
};

/** Pixel-level, independent of any geometry: the static board WITHOUT the idle layer, all 16 pixels of the
 * cell and of its 8 neighbours are plain substrate (#0a0a0a or the grid dot #111111). */
function pixelBare(w: World, idle: Idle, cells: { x: number; y: number }[]): string[] {
  const data = readFrame(drawStatic({ ...w, idle: { ...idle, staticCells: [], repressilator: [] } }));
  const bad: string[] = [];
  for (const c of cells)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (let py = 0; py < CELL; py++)
          for (let px = 0; px < CELL; px++) {
            const i = (((c.y + dy) * CELL + py) * WIDTH + (c.x + dx) * CELL + px) * 4;
            const hex = `#${((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]).toString(16).padStart(6, '0')}`;
            if (hex !== COLORS.bg && hex !== COLORS.grid) bad.push(`(${c.x},${c.y})+(${dx},${dy}) ${hex}`);
          }
  return [...new Set(bad)];
}

const sproutCells = (idle: Idle): { x: number; y: number }[] => idle.sprouts.flatMap(s => s.cells);
const bits4 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map(c => (c >> 4).toString(16)).join('');
};

describe('buildIdle is deterministic and bounded', () => {
  it('builds the same idle layer twice and the same overlay at every sampled frame', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed);
      const a = buildIdle(w, w.tissue.recordings), b = buildIdle(w, w.tissue.recordings);
      expect(b).toEqual(a);
      for (const t of [0, 7, 100, 211, 287]) expect(idleCellsAt(b, t, T)).toEqual(idleCellsAt(a, t, T));
    }
  });

  it('is what buildWorld attaches', () => {
    const w = worldOf(SEEDS[0]);
    expect(w.idle).toEqual(buildIdle(w, w.tissue.recordings));
  });

  it('every colour it can emit is in IDLE_COLOURS: at most 14, mutually distinct at 4 bits, clear of the substrate', () => {
    expect(IDLE_COLOURS.length).toBeLessThanOrEqual(14);
    const reduced = IDLE_COLOURS.map(bits4);
    expect(new Set(reduced).size).toBe(IDLE_COLOURS.length);
    for (const dark of [COLORS.bg, COLORS.grid, COLORS.surface]) expect(reduced).not.toContain(bits4(dark));
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      const seen = new Set(idle.staticCells.map(c => c.color));
      for (let t = 0; t < T; t++) for (const c of idleCellsAt(idle, t, T)) seen.add(c.color);
      for (const c of seen) expect(IDLE_COLOURS).toContain(c);
    }
  });

  it('the overlay is pure in t mod T', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      for (let t = 0; t < T; t += 5) expect(idleCellsAt(idle, t + T, T)).toEqual(idleCellsAt(idle, t, T));
      expect(idleCellsAt(idle, -1, T)).toEqual(idleCellsAt(idle, T - 1, T));
    }
  });

  it('draws at most 90 dynamic cells in any frame, each cell at most once', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      let max = 0;
      for (let t = 0; t < T; t++) {
        const cells = idleCellsAt(idle, t, T);
        max = Math.max(max, cells.length);
        expect(new Set(cells.map(c => key(c.x, c.y))).size).toBe(cells.length);
      }
      console.log(`seed ${seed}: max dynamic idle cells ${max}`);
      expect(max).toBeLessThanOrEqual(90);
    }
  });

  it('every period divides T = 288', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      expect(idle.periods.length).toBeGreaterThan(8);
      for (const p of idle.periods) expect(T % p).toBe(0);
    }
  });
});

describe('sprouts: calm tissue creeping onto the board at the connector', () => {
  it('place 4..12 sprouts (at least 8 for the corpus seed), 3..8 static cells each, in the tissue\'s own dendrite colour', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      console.log(`seed ${seed}: ${idle.sprouts.length} sprouts, ${idle.leds.length} LEDs`);
      expect(idle.sprouts.length).toBeGreaterThanOrEqual(4);
      expect(idle.sprouts.length).toBeLessThanOrEqual(12);
      for (const s of idle.sprouts) {
        expect(s.base).toBeGreaterThanOrEqual(3);
        expect(s.base).toBeLessThanOrEqual(8);
        for (const c of s.cells.slice(0, s.base))
          expect(idle.staticCells).toContainEqual({ x: c.x, y: c.y, color: DENDRITE_COLOUR });
      }
    }
    expect(idleOf(20260724).sprouts.length).toBeGreaterThanOrEqual(8);
  });

  it('are calm: a thin growth, not a thicket', () => {
    for (const seed of SEEDS) expect(idleOf(seed).sprouts.reduce((n, s) => n + s.base, 0)).toBeLessThanOrEqual(96);
  });

  it('sit on bare substrate with a 1-cell clearance — geometry, and the rendered pixels agree', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed), blocked = ink(w);
      const all = sproutCells(idle);
      expect(all.length).toBeGreaterThan(20);
      const bad = all.filter(c => !bareWithClearance(blocked, c.x, c.y)).map(c => key(c.x, c.y));
      expect(bad).toEqual([]);
      expect(pixelBare(w, idle, all)).toEqual([]);
    }
  });

  it('are 8-connected, stay in x 204..226, and never touch one another', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      const owner = new Map<string, number>();
      idle.sprouts.forEach((s, i) => {
        for (let k = 0; k < s.cells.length; k++) {
          const c = s.cells[k];
          expect(c.x).toBeGreaterThanOrEqual(204);
          expect(c.x).toBeLessThanOrEqual(226);
          if (k > 0) expect(cheb(c, s.cells[k - 1])).toBe(1);
          expect(owner.has(key(c.x, c.y))).toBe(false);
          owner.set(key(c.x, c.y), i);
        }
      });
      for (const [k, i] of owner) {
        const [x, y] = k.split(',').map(Number);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const o = owner.get(key(x + dx, y + dy));
          if (o !== undefined) expect(o).toBe(i);
        }
      }
    }
  });

  it('are rooted next to a finger or the board rim', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      for (const s of idle.sprouts) {
        const nearFinger = FINGERS.some(f => cheb(s.root, { x: Math.min(Math.max(s.root.x, f.x), f.x + FINGER_W - 1), y: Math.min(Math.max(s.root.y, f.y), f.y + f.h - 1) }) <= 8);
        expect(nearFinger || s.root.x >= 218 || s.root.y <= 9 || s.root.y >= 70).toBe(true);
      }
    }
  });

  it('exactly three have a tip that extends and retracts 2-3 cells, on periods 72, 96, 144', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      const tipped = idle.sprouts.filter(s => s.period > 0);
      expect(tipped.map(s => s.period).sort((a, b) => a - b)).toEqual([72, 96, 144]);
      for (const s of tipped) {
        const ext = s.cells.length - s.base;
        expect(ext).toBeGreaterThanOrEqual(2);
        expect(ext).toBeLessThanOrEqual(3);
        const shown = new Set<number>();
        for (let t = 0; t < T; t++) {
          const cells = idleCellsAt(idle, t, T);
          shown.add(s.cells.slice(s.base).filter(c => cells.some(d => d.x === c.x && d.y === c.y)).length);
        }
        expect(Math.min(...shown)).toBe(0);
        expect(Math.max(...shown)).toBe(ext);
      }
    }
  });

  it('a recording lifts the sprouts rooted within 10 cells of its finger one step, for exactly 6 frames', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle0 = idleOf(seed);
      // the finger with the most sprouts near it, so the window is not vacuous
      const near = (fi: number): number => idle0.sprouts.filter(s => {
        const f = FINGERS[fi];
        const dx = Math.max(f.x - s.root.x, 0, s.root.x - (f.x + FINGER_W - 1)), dy = Math.max(f.y - s.root.y, 0, s.root.y - (f.y + f.h - 1));
        return Math.max(dx, dy) <= 10;
      }).length;
      const finger = FINGERS.map((_, i) => i).sort((a, b) => near(b) - near(a))[0];
      expect(near(finger)).toBeGreaterThan(0);
      const frame = 100;
      const idle = buildIdle(w, [{ frame, finger, accent: '#ff2d78' }]);
      const f = FINGERS[finger];
      const lifted = (t: number): number => {
        const cells = idleCellsAt(idle, t, T);
        const bright = new Set(cells.filter(c => c.color !== DENDRITE_COLOUR && IDLE_COLOURS.includes(c.color) && !HEART_RAMP.includes(c.color)
          && !idle.leds.some(l => l.x === c.x && l.y === c.y)).map(c => key(c.x, c.y)));
        return idle.sprouts.filter(s => {
          const dx = Math.max(f.x - s.root.x, 0, s.root.x - (f.x + FINGER_W - 1)), dy = Math.max(f.y - s.root.y, 0, s.root.y - (f.y + f.h - 1));
          return Math.max(dx, dy) <= 10 && s.cells.slice(0, s.base).every(c => bright.has(key(c.x, c.y)));
        }).length;
      };
      const want = near(finger);
      expect(lifted(frame - 1)).toBe(0);
      for (let k = 0; k < 6; k++) expect(`k=${k} ${lifted(frame + k)}`).toBe(`k=${k} ${want}`);
      expect(lifted(frame + 6)).toBe(0);
    }
  });
});

describe('status LEDs', () => {
  it('place exactly 5 (the repressilator took three of the old eight), on bare substrate with clearance, beside real components, off the right edge band', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed), blocked = ink(w);
      expect(idle.leds.length).toBe(5);
      for (const l of idle.leds) {
        expect(l.x).toBeLessThan(204);
        expect(bareWithClearance(blocked, l.x, l.y)).toBe(true);
        const d = Math.min(...w.components.map(c => {
          const dx = Math.max(c.rect.x - l.x, 0, l.x - (c.rect.x + c.rect.w - 1));
          const dy = Math.max(c.rect.y - l.y, 0, l.y - (c.rect.y + c.rect.h - 1));
          return Math.max(dx, dy);
        }));
        expect(d).toBeLessThanOrEqual(6);
        expect(w.accents).toContain(l.color);
      }
      expect(pixelBare(w, idle, idle.leds)).toEqual([]);
    }
  });

  it('rest at about 25 % of the accent and light to the full accent about half the time', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      for (const l of idle.leds) {
        const off = idle.staticCells.find(c => c.x === l.x && c.y === l.y)!;
        expect(off).toBeDefined();
        expect(off.color).not.toBe(l.color);
        let on = 0;
        for (let t = 0; t < T; t++)
          if (idleCellsAt(idle, t, T).some(c => c.x === l.x && c.y === l.y && c.color === l.color)) on++;
        expect(on / T).toBeGreaterThan(0.4);
        expect(on / T).toBeLessThan(0.6);
      }
      expect(new Set(idle.leds.map(l => l.period)).size).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('the CPU heartbeat', () => {
  it('beats twice per 24 frames in three discrete steps, inside the socket\'s centre block', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed);
      const cpu = w.components.find(c => c.kind === 'cpuSocket')!;
      const h = idle.heart;
      expect(h.w * h.h).toBeGreaterThanOrEqual(25);
      expect(h.w * h.h).toBeLessThanOrEqual(35);
      expect(h.x).toBeGreaterThanOrEqual(cpu.body.x + 3);
      expect(h.x + h.w).toBeLessThanOrEqual(cpu.body.x + cpu.body.w - 3);
      expect(h.y).toBeGreaterThanOrEqual(cpu.body.y + 3);
      expect(h.y + h.h).toBeLessThanOrEqual(cpu.body.y + cpu.body.h - 3);
      const level = (t: number): number => {
        let lv = 0;
        for (const c of idleCellsAt(idle, t, T)) {
          if (c.x < h.x || c.x >= h.x + h.w || c.y < h.y || c.y >= h.y + h.h) continue;
          const r = HEART_RAMP.indexOf(c.color);
          expect(r).toBeGreaterThanOrEqual(0);
          lv = Math.max(lv, r + 1);
        }
        return lv;
      };
      expect(HEART_RAMP).toHaveLength(3);
      const lv = Array.from({ length: 24 }, (_, t) => level(t));
      expect(new Set(lv)).toEqual(new Set([0, 1, 2, 3]));
      let peaks = 0;
      for (let t = 0; t < 24; t++) if (lv[t] === 3 && lv[(t + 23) % 24] !== 3) peaks++;
      expect(peaks).toBe(2);
      for (let t = 0; t < T; t++) expect(level(t)).toBe(lv[t % 24]);
    }
  });
});

describe('the memory bus bars are gone (the RNA stream replaced them, owner 2026-11-19)', () => {
  it('there is no `dimms` list, and no idle cell is ever inside a DIMM slot', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed);
      expect('dimms' in idle).toBe(false);
      const slots = w.components.filter(c => c.kind === 'dimmSlot');
      expect(slots.length).toBeGreaterThanOrEqual(3);
      const inSlot = (c: { x: number; y: number }): boolean =>
        slots.some(s => c.x >= s.rect.x && c.x < s.rect.x + s.rect.w && c.y >= s.rect.y && c.y < s.rect.y + s.rect.h);
      expect(idle.staticCells.filter(inSlot)).toEqual([]);
      for (let t = 0; t < T; t++) expect(idleCellsAt(idle, t, T).filter(inSlot)).toEqual([]);
    }
  });
});

describe('the repressilator lights (three of the old eight LEDs, owner 2026-11-19)', () => {
  /** a light run is valid under `w`'s ink: every cell clear with its 8 neighbours, and x < 204 */
  const check = (w: World, idle: Idle): void => {
    const blocked = ink(w), r = idle.repressilator;
    expect(r).toHaveLength(3);
    expect(r[1].y).toBe(r[0].y); expect(r[2].y).toBe(r[0].y);
    expect(r[1].x - r[0].x).toBe(2); expect(r[2].x - r[1].x).toBe(2);        // single empty cell between them
    for (const c of r) {
      expect(c.x).toBeLessThan(204);                                          // never the right edge band
      expect(bareWithClearance(blocked, c.x, c.y)).toBe(true);                // bare substrate, same rule as the LEDs
      expect(TEXT_ZONES.some(z => c.x >= z.x && c.x < z.x + z.w && c.y >= z.y && c.y < z.y + z.h)).toBe(false);
      for (const l of idle.leds) expect(cheb(c, l)).toBeGreaterThanOrEqual(2);  // clear of every LED
    }
    expect(blocked.has(key(r[0].x + 1, r[0].y))).toBe(false);                 // the gaps are bare too
    expect(blocked.has(key(r[1].x + 1, r[1].y))).toBe(false);
  };

  it('are three cells in a row with single gaps, on bare substrate, off the right edge band, for the corpus seeds', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed);
      check(w, idle);
      expect(pixelBare(w, idle, idle.repressilator)).toEqual([]);
      console.log(`seed ${seed}: repressilator at ${idle.repressilator.map(c => `(${c.x},${c.y})`).join(' ')}`);
    }
  });

  it('sit near the largest QFP (or the chipset heatsink)', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed);
      const qfps = w.components.filter(c => c.kind === 'qfp').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
      const anchor = (qfps[0] ?? w.components.find(c => c.kind === 'heatsink')!).rect;
      const mid = idle.repressilator[1];
      const d = Math.max(anchor.x - mid.x, 0, mid.x - (anchor.x + anchor.w - 1), anchor.y - mid.y, 0, mid.y - (anchor.y + anchor.h - 1));
      expect(d).toBeLessThanOrEqual(12);
    }
  });

  it('are deterministic, and not in the idle cell lists (the renderer paints them from the palette)', () => {
    for (const seed of SEEDS) {
      const w = worldOf(seed), idle = idleOf(seed), again = buildIdle(w, w.tissue.recordings);
      expect(again.repressilator).toEqual(idle.repressilator);
      const lights = new Set(idle.repressilator.map(c => key(c.x, c.y)));
      expect(idle.staticCells.some(c => lights.has(key(c.x, c.y)))).toBe(false);
      for (let t = 0; t < T; t += 7) expect(idleCellsAt(idle, t, T).some(c => lights.has(key(c.x, c.y)))).toBe(false);
    }
  });

  it('place validly on 24 other layouts (a lightweight world: layout, copper and fabric only)', () => {
    for (let seed = 1000; seed < 1024; seed++) {
      const layout = buildLayout(mulberry32(seed));
      const nets = buildNets(layout), graph = buildGraph(layout.components, nets);
      const w = {
        seed, T, accents: layout.accents, components: layout.components, sections: layout.sections,
        dressing: layout.dressing, mountHoles: layout.mountHoles, nets, graph, fabric: fabricCells(graph),
      } as unknown as World;
      check(w, buildIdle(w, []));
    }
  });
});

describe('the fan\'s blade phase', () => {
  it('cycles 0,1,2,3 with 3 frames each (period 12)', () => {
    const steps = Array.from({ length: 12 }, (_, t) => fanStepAt(t));
    expect(steps).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    for (let t = 0; t < T; t++) expect(fanStepAt(t)).toBe(fanStepAt(t % 12));
  });
});

describe('nothing idle lands where it must not', () => {
  it('no idle cell, static or dynamic, is in a text zone, on a finger or past x = 230', () => {
    for (const seed of SEEDS) {
      const idle = idleOf(seed);
      const all: IdleCell[] = [...idle.staticCells];
      for (let t = 0; t < T; t++) all.push(...idleCellsAt(idle, t, T));
      for (const c of all) {
        expect(c.x).toBeLessThanOrEqual(BOARD_RIGHT);
        expect(TEXT_ZONES.some(z => c.x >= z.x && c.x < z.x + z.w && c.y >= z.y && c.y < z.y + z.h)).toBe(false);
        expect(FINGERS.some(f => c.x >= f.x && c.x < f.x + FINGER_W && c.y >= f.y && c.y < f.y + f.h)).toBe(false);
      }
      for (const c of idle.repressilator) {
        expect(c.x).toBeLessThan(204);
        expect(TEXT_ZONES.some(z => c.x >= z.x && c.x < z.x + z.w && c.y >= z.y && c.y < z.y + z.h)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The name plate. The owner asked for it on 2026-11-19 ("i liked it on a plate too but not as big as
// the last one you showed"): a small dot-matrix module in place of the old text label.
// ---------------------------------------------------------------------------

/** `cody_slater` in a standard 5x7 dot font (the classic GLCD table), spelled out by hand here. */
const GLYPH_ROWS: Record<string, string[]> = {
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  y: ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  s: ['.....', '.....', '.####', '#....', '.###.', '....#', '####.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  t: ['.#...', '.#...', '###..', '.#...', '.#...', '.#..#', '..##.'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
};
const NAME = 'cody_slater';
const DOT_X = PLATE.x + 2, DOT_Y = PLATE.y + 2, DOT_W = 66, DOT_H = 7;
const lit = (n: number): Set<string> => {
  const s = new Set<string>();
  for (let i = 0; i < n; i++)
    GLYPH_ROWS[NAME[i]].forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') s.add(key(DOT_X + 6 * i + c, DOT_Y + r)); }));
  return s;
};
const cursorAt = (i: number): Set<string> => {
  const s = new Set<string>();
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) s.add(key(DOT_X + 6 * i + c, DOT_Y + r));
  return s;
};
/** The plate's dot-area colours at frame t, from the static cells overlaid by the frame's cells. */
function plateAt(t: number): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of plateStaticCells()) m.set(key(c.x, c.y), c.color);
  for (const c of plateCellsAt(t, T)) m.set(key(c.x, c.y), c.color);
  return m;
}
const litDots = (m: Map<string, string>): Set<string> => {
  const s = new Set<string>();
  for (let y = DOT_Y; y < DOT_Y + DOT_H; y++)
    for (let x = DOT_X; x < DOT_X + DOT_W; x++) if (m.get(key(x, y)) === NAME_COLOR) s.add(key(x, y));
  return s;
};

describe('the name plate', () => {
  it('is a 70 x 11 module inside NAME_ZONE, clear of every component, net, fabric cell, mount hole and dressing', () => {
    expect(PLATE).toEqual({ x: 10, y: 66, w: 70, h: 11 });
    expect(PLATE.x).toBeGreaterThanOrEqual(NAME_ZONE.x);
    expect(PLATE.y).toBeGreaterThanOrEqual(NAME_ZONE.y);
    expect(PLATE.x + PLATE.w).toBeLessThanOrEqual(NAME_ZONE.x + NAME_ZONE.w);
    expect(PLATE.y + PLATE.h).toBeLessThanOrEqual(NAME_ZONE.y + NAME_ZONE.h);
    const cells = plateStaticCells();
    expect(new Set(cells.map(c => key(c.x, c.y))).size).toBe(PLATE.w * PLATE.h);
    for (const seed of SEEDS) {
      const w = worldOf(seed);
      const taken = new Set<string>();
      for (const c of w.components) for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++) for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) taken.add(key(x, y));
      for (const n of w.nets) for (const c of n.cells) taken.add(key(c.x, c.y));
      for (const c of w.fabric) taken.add(key(c.x, c.y));
      for (const f of w.dressing.features)
        for (let y = f.rect.y - 1; y <= f.rect.y + f.rect.h; y++) for (let x = f.rect.x - 1; x <= f.rect.x + f.rect.w; x++) taken.add(key(x, y));
      for (const c of cells) expect(taken.has(key(c.x, c.y))).toBe(false);
      // the mount hole's keepout ring is a circle of radius 10 px around its cell centre
      for (const h of w.mountHoles)
        for (const c of cells) expect(Math.hypot((c.x - h.x) * CELL, (c.y - h.y) * CELL)).toBeGreaterThan(10 + CELL);
    }
  });

  it('is body, a 1-cell bezel with four corner pins, 1 cell of padding, then a 66 x 7 dot area', () => {
    const m = new Map(plateStaticCells().map(c => [key(c.x, c.y), c.color]));
    const at = (x: number, y: number): string | undefined => m.get(key(PLATE.x + x, PLATE.y + y));
    for (let x = 1; x < PLATE.w - 1; x++) for (const y of [0, PLATE.h - 1]) expect(at(x, y)).toBe('#2a2a2a');
    for (let y = 1; y < PLATE.h - 1; y++) for (const x of [0, PLATE.w - 1]) expect(at(x, y)).toBe('#2a2a2a');
    for (const [x, y] of [[0, 0], [PLATE.w - 1, 0], [0, PLATE.h - 1], [PLATE.w - 1, PLATE.h - 1]]) expect(at(x, y)).toBe('#888888');
    for (let x = 1; x < PLATE.w - 1; x++) for (const y of [1, PLATE.h - 2]) expect(at(x, y)).toBe('#111111');
    for (let y = 1; y < PLATE.h - 1; y++) for (const x of [1, PLATE.w - 2]) expect(at(x, y)).toBe('#111111');
    expect(NAME_COLOR).toBe('#39ff14');
  });

  it('at frame 0 the lit dots are exactly the 5x7 bitmap of cody_slater, every other dot is unlit', () => {
    const m = plateAt(0);
    expect([...litDots(m)].sort()).toEqual([...lit(11)].sort());
    for (let y = DOT_Y; y < DOT_Y + DOT_H; y++)
      for (let x = DOT_X; x < DOT_X + DOT_W; x++)
        if (!lit(11).has(key(x, y))) expect(m.get(key(x, y))).toBe('#0e1a0e');
    expect(lit(11).size).toBeGreaterThan(100);
  });

  it('is lit through frame 203, clears at 204 and shows no lit dot through 206', () => {
    for (const t of [0, 1, 100, 203]) expect(plateCellsAt(t, T)).toEqual([]);
    for (const t of [204, 205, 206]) {
      expect(litDots(plateAt(t)).size).toBe(0);
      expect(plateCellsAt(t, T).length).toBeGreaterThan(100);
    }
  });

  it('retypes one character every 3 frames from 207 with a block cursor at the next position', () => {
    for (let i = 0; i < 11; i++) {
      const want = new Set([...lit(i + 1), ...(i < 10 ? cursorAt(i + 1) : [])]);
      for (const t of [207 + 3 * i, 207 + 3 * i + 2]) expect([...litDots(plateAt(t))].sort()).toEqual([...want].sort());
    }
    // the cursor is the whole 5x7 block, and there is none once the 11th character is in
    expect(cursorAt(1).size).toBe(35);
    expect(litDots(plateAt(237)).size).toBe(lit(11).size);
  });

  it('is steady again from 240, and differs from steady only in 204..239', () => {
    for (let t = 240; t < T; t++) expect(plateCellsAt(t, T)).toEqual([]);
    for (let t = 0; t < 204; t++) expect(plateCellsAt(t, T)).toEqual([]);
    for (let t = 238; t < 240; t++) expect(litDots(plateAt(t))).toEqual(lit(11));
    for (let t = 0; t < T; t++) expect(plateCellsAt(t + T, T)).toEqual(plateCellsAt(t, T));
  });

  it('PLATE_COLOURS are mutually distinct, and distinct from the substrate, at 4 bits per channel', () => {
    const reduced = PLATE_COLOURS.map(bits4);
    expect(new Set(reduced).size).toBe(PLATE_COLOURS.length);
    expect(reduced).not.toContain(bits4(COLORS.bg));
    expect(PLATE_COLOURS).toEqual(expect.arrayContaining(['#39ff14', '#0e1a0e', '#111111', '#2a2a2a', '#888888']));
    const emitted = new Set([...plateStaticCells().map(c => c.color)]);
    for (let t = 0; t < T; t++) for (const c of plateCellsAt(t, T)) emitted.add(c.color);
    for (const c of emitted) expect(PLATE_COLOURS).toContain(c);
  });
});

describe('the heartbeat period (calm 36, steady 24, busy 18)', () => {
  const w = (): World => worldOf(SEEDS[0]);
  /** the heart block's brightest step at each of frames 0..n-1 */
  const heartLevels = (idle: Idle, n: number): number[] => {
    const h = idle.heart;
    return Array.from({ length: n }, (_, t) => {
      let lv = 0;
      for (const c of idleCellsAt(idle, t, T)) {
        if (c.x < h.x || c.x >= h.x + h.w || c.y < h.y || c.y >= h.y + h.h) continue;
        lv = Math.max(lv, HEART_RAMP.indexOf(c.color) + 1);
      }
      return lv;
    });
  };

  it.each([36, 24, 18])('period %i: exactly two peaks per period, all three steps, repeating', period => {
    const world = w();
    const idle = buildIdle(world, world.tissue.recordings, period);
    expect(idle.beatPeriod).toBe(period);
    expect(idle.periods[0]).toBe(period);
    for (const p of idle.periods) expect(T % p).toBe(0);
    const all = heartLevels(idle, T), lv = all.slice(0, period);
    expect(new Set(lv)).toEqual(new Set([0, 1, 2, 3]));
    let peaks = 0;
    for (let t = 0; t < period; t++) if (lv[t] === 3 && lv[(t + period - 1) % period] !== 3) peaks++;
    expect(peaks).toBe(2);
    for (let t = 0; t < T; t++) expect(all[t]).toBe(lv[t % period]);
  });

  it.each([36, 24, 18])('period %i: idleCellsAt stays T-periodic', period => {
    const world = w();
    const idle = buildIdle(world, world.tissue.recordings, period);
    for (let t = 0; t < T; t += 3) expect(idleCellsAt(idle, t + T, T)).toEqual(idleCellsAt(idle, t, T));
    expect(idleCellsAt(idle, -1, T)).toEqual(idleCellsAt(idle, T - 1, T));
  });

  it('only the heartbeat depends on the period: sprouts, LEDs, bus and static cells are unchanged', () => {
    const world = w();
    const a = buildIdle(world, world.tissue.recordings, 24), b = buildIdle(world, world.tissue.recordings, 36);
    expect({ ...b, beatPeriod: 24, periods: [] }).toEqual({ ...a, periods: [] });
    expect(b.periods.slice(1)).toEqual(a.periods.slice(1));
  });

  it('the default period equals an explicit 24', () => {
    const world = w();
    expect(buildIdle(world, world.tissue.recordings)).toEqual(buildIdle(world, world.tissue.recordings, 24));
    expect(idleOf(SEEDS[0]).beatPeriod).toBe(24);
  });
});
