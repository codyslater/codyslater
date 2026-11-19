import { describe, expect, it } from 'vitest';
import { REV_ZONE, THESIS_ZONE } from './layout.js';
import { mixOnBg } from './render.js';
import type { Rect } from './types.js';
import {
  INSTRUMENT_COLOURS, REPRESSILATOR_LEVELS, REPRESSILATOR_PERIOD, RNA_FRAMES_PER_BASE, RNA_SEQUENCE,
  SCOPE, SCOPE_COLS, SCOPE_FRAMES_PER_COL, STRIP, STRIP_GREENS,
  repressilatorLevelsAt, rnaCellsAt, scopeCellsAt, scopeStaticCells, stripCellsAt, stripStaticCells,
  type InstrumentCell,
} from './instruments.js';

const T = 288;
const ACC: readonly [string, string, string] = ['#ff2d78', '#00e5ff', '#bf5af2'];
const key = (c: { x: number; y: number }): string => `${c.x},${c.y}`;
const q4 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 20, (n >> 12) & 15, (n >> 4) & 15].join(',');
};
const inside = (r: Rect, outer: Rect): boolean =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
const sortCells = (cs: InstrumentCell[]): InstrumentCell[] =>
  [...cs].sort((a, b) => a.y - b.y || a.x - b.x || a.color.localeCompare(b.color));

describe('colours', () => {
  it('is at most 18 entries, mutually distinct at 4 bits per channel, and holds every fixed colour', () => {
    expect(INSTRUMENT_COLOURS.length).toBeLessThanOrEqual(18);
    expect(new Set(INSTRUMENT_COLOURS.map(q4)).size).toBe(INSTRUMENT_COLOURS.length);
    for (const c of ['#111111', '#2a2a2a', '#888888', ...STRIP_GREENS]) expect(INSTRUMENT_COLOURS).toContain(c);
  });
  it('every fixed colour the cells emit is in the list (accent-derived ones aside)', () => {
    const accentish = new Set<string>([...ACC, ...ACC.map(a => mixOnBg(a, 0.22, '#111111'))]);
    const cells = [
      ...scopeStaticCells(ACC), ...stripStaticCells(Array(14).fill(1)),
      ...stripCellsAt([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1], 0),
    ];
    for (const c of cells) if (!accentish.has(c.color)) expect(INSTRUMENT_COLOURS).toContain(c.color);
  });
});

describe('spike scope', () => {
  const statics = scopeStaticCells(ACC);
  const DX = SCOPE.x + 2, DY = SCOPE.y + 2;

  it('is 50 x 11 and lies inside THESIS_ZONE', () => {
    expect(SCOPE).toEqual({ x: 82, y: 66, w: 50, h: 11 });
    expect(inside(SCOPE, THESIS_ZONE)).toBe(true);
    expect(SCOPE_COLS).toBe(46);
    expect(SCOPE_FRAMES_PER_COL).toBe(2);
  });
  it('static cells exactly fill the module with no duplicates', () => {
    expect(statics.length).toBe(550);
    expect(new Set(statics.map(key)).size).toBe(550);
    for (const c of statics) {
      expect(c.x).toBeGreaterThanOrEqual(SCOPE.x); expect(c.x).toBeLessThan(SCOPE.x + SCOPE.w);
      expect(c.y).toBeGreaterThanOrEqual(SCOPE.y); expect(c.y).toBeLessThan(SCOPE.y + SCOPE.h);
    }
  });
  it('has bezel, corner pins, body padding, and tinted baselines', () => {
    const at = (x: number, y: number): string => statics.find(c => c.x === x && c.y === y)!.color;
    const x1 = SCOPE.x + SCOPE.w - 1, y1 = SCOPE.y + SCOPE.h - 1;
    for (const [x, y] of [[SCOPE.x, SCOPE.y], [x1, SCOPE.y], [SCOPE.x, y1], [x1, y1]]) expect(at(x, y)).toBe('#888888');
    expect(at(SCOPE.x + 10, SCOPE.y)).toBe('#2a2a2a');
    expect(at(SCOPE.x, SCOPE.y + 5)).toBe('#2a2a2a');
    expect(at(SCOPE.x + 1, SCOPE.y + 5)).toBe('#111111');           // padding
    expect(at(SCOPE.x + 10, SCOPE.y + 1)).toBe('#111111');
    for (let s = 0; s < 3; s++) {
      const dim = mixOnBg(ACC[s], 0.22, '#111111');
      for (let c = 0; c < SCOPE_COLS; c++) expect(at(DX + c, DY + 2 * s + 1)).toBe(dim);
      expect(at(DX + 7, DY + 2 * s)).toBe('#111111');               // the space above a baseline
    }
    for (let c = 0; c < SCOPE_COLS; c++) expect(at(DX + c, DY + 6)).toBe('#111111'); // row 6 empty
  });

  const fire = [{ soma: 1, t: 10 }];
  const tickAt = (t: number): InstrumentCell[] => scopeCellsAt(fire, ACC, t, T);
  const expectTick = (t: number, col: number): void => {
    expect(sortCells(tickAt(t))).toEqual(sortCells([
      { x: DX + col, y: DY + 2, color: ACC[1] },
      { x: DX + col, y: DY + 3, color: ACC[1] },
    ]));
  };
  it('a tick enters at the right edge on its frame and crawls left one column per 2 frames', () => {
    expectTick(10, SCOPE_COLS - 1);
    expectTick(11, SCOPE_COLS - 1);
    expectTick(12, SCOPE_COLS - 2);
    expectTick(10 + 91, 0);
  });
  it('is gone after 92 frames, and absent before the firing', () => {
    expect(tickAt(10 + 92)).toEqual([]);
    expect(tickAt(9)).toEqual([]);
    expect(tickAt(200)).toEqual([]);
  });
  it('wraps around the loop', () => {
    const f = [{ soma: 0, t: 280 }];
    const c = scopeCellsAt(f, ACC, 5, T);       // age 13 -> column 45 - 6 = 39
    expect(sortCells(c)).toEqual(sortCells([
      { x: DX + 39, y: DY, color: ACC[0] }, { x: DX + 39, y: DY + 1, color: ACC[0] },
    ]));
  });
  it('ticks stay in the dot area and sit on cells the static layer owns; duplicates merge', () => {
    const f = [{ soma: 0, t: 3 }, { soma: 0, t: 3 }, { soma: 1, t: 5 }, { soma: 2, t: 7 }, { soma: 1, t: 40 }];
    const stat = new Set(statics.map(key));
    for (let t = 0; t < T; t++) {
      const cs = scopeCellsAt(f, ACC, t, T);
      expect(new Set(cs.map(key)).size).toBe(cs.length);
      for (const c of cs) {
        expect(c.x).toBeGreaterThanOrEqual(DX); expect(c.x).toBeLessThan(DX + SCOPE_COLS);
        expect(c.y).toBeGreaterThanOrEqual(DY); expect(c.y).toBeLessThan(DY + 6);
        expect(stat.has(key(c))).toBe(true);
      }
    }
  });
  it('is periodic in T', () => {
    const f = [{ soma: 0, t: 3 }, { soma: 1, t: 150 }, { soma: 2, t: 280 }];
    for (let t = 0; t < T; t += 7) expect(scopeCellsAt(f, ACC, t + T, T)).toEqual(scopeCellsAt(f, ACC, t, T));
  });
});

describe('repressilator', () => {
  const lv = (t: number): [number, number, number] => repressilatorLevelsAt(t);
  const P = REPRESSILATOR_PERIOD;
  const trace = (g: number): number[] => Array.from({ length: P }, (_, t) => lv(t)[g]);
  const argmax = (a: number[]): number => a.indexOf(Math.max(...a));

  it('has 5 levels and period 96', () => {
    expect(P).toBe(96);
    expect(REPRESSILATOR_LEVELS).toBe(5);
    for (let t = 0; t < 2 * P; t++) {
      const l = lv(t);
      for (const v of l) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(4); }
      if (t < P) expect(lv(t + P)).toEqual(l);
    }
    expect(lv(-1)).toEqual(lv(P - 1));
  });
  it('every protein reaches level 4 and level 0 each period', () => {
    for (let g = 0; g < 3; g++) { expect(Math.max(...trace(g))).toBe(4); expect(Math.min(...trace(g))).toBe(0); }
  });
  it('A peaks at frame 0', () => {
    expect(lv(0)[0]).toBe(4);
    expect(argmax(trace(0))).toBe(0);
  });
  it('peaks in the order A, C, B (A represses B, B represses C, C represses A)', () => {
    // A high holds B low; with B low, C is released and rises; C high then represses A, and the dip in A
    // releases B. So after A, the next peak is C, then B: C trails A by a third of a period, B by two thirds.
    // Peak position = circular mean of the level-4 frames, measured from A's peak at frame 0.
    const peakAt = (g: number): number => {
      const tr = trace(g);
      const sh = Array.from({ length: P }, (_, i) => tr[(i - 16 + P) % P]);   // rotate so frame 0 sits mid-window
      const hi = sh.map((v, t) => (v === 4 ? t : -1)).filter(t => t >= 0);
      return (((hi.reduce((a, b) => a + b, 0) / hi.length - 16) % P) + P) % P;
    };
    const a = peakAt(0), b = peakAt(1), c = peakAt(2);
    expect(Math.min(a, P - a)).toBeLessThan(2);
    expect(c).toBeGreaterThan(28); expect(c).toBeLessThan(36);
    expect(b).toBeGreaterThan(60); expect(b).toBeLessThan(68);
    const order = [['A', Math.min(a, P - a) < 2 ? 0 : a], ['B', b], ['C', c]] as const;
    expect([...order].sort((x, y) => x[1] - y[1]).map(o => o[0]).join('')).toBe('ACB');
  });
  it('a protein at level 4 holds the protein it represses at level 0 or 1', () => {
    const REPRESSES = [1, 2, 0];                      // A -| B, B -| C, C -| A
    for (let t = 0; t < P; t++) {
      const l = lv(t);
      for (let g = 0; g < 3; g++) if (l[g] === 4) expect(l[REPRESSES[g]]).toBeLessThanOrEqual(1);
    }
  });
  it('the three traces are one waveform shifted by a third of a period (within one level)', () => {
    for (let t = 0; t < P; t++) {
      const a = lv(t)[0];
      expect(Math.abs(lv(t + 32)[2] - a)).toBeLessThanOrEqual(1);     // C is A delayed by 32
      expect(Math.abs(lv(t + 64)[1] - a)).toBeLessThanOrEqual(1);     // B is A delayed by 64
    }
  });
});

describe('RNA stream', () => {
  const CODON: Record<string, string> = {
    AUG: 'M', UGC: 'C', UAG: 'O', GAC: 'D', UAC: 'Y', UCU: 'S', CUG: 'L', GCU: 'A', ACC: 'T', GAG: 'E', CGU: 'R',
    UAA: '*', UGA: '*',
  };
  const colours = { A: '#a1', U: '#b2', G: '#c3', C: '#d4' };
  const slots: Rect[] = [{ x: 10, y: 20, w: 3, h: 21 }, { x: 30, y: 20, w: 3, h: 21 }, { x: 50, y: 21, w: 3, h: 21 }];

  it('is the owner name in codons: start, MCODYSLATER, stop', () => {
    expect(RNA_SEQUENCE.length).toBe(36);
    expect(RNA_SEQUENCE).toMatch(/^[AUGC]+$/);
    const prot = RNA_SEQUENCE.match(/.{3}/g)!.map(c => CODON[c]).join('');
    expect(prot).toBe('MCODYSLATER*');
    expect(RNA_SEQUENCE.slice(33)).toBe('UAA');
    expect(RNA_FRAMES_PER_BASE).toBe(4);
    expect(T % (RNA_SEQUENCE.length * RNA_FRAMES_PER_BASE)).toBe(0);
  });
  it('draws h-2 cells per slot in the centre column', () => {
    const cs = rnaCellsAt(slots, colours, 0);
    expect(cs.length).toBe(slots.reduce((n, s) => n + s.h - 2, 0));
    expect(new Set(cs.map(key)).size).toBe(cs.length);
    slots.forEach(s => {
      const mine = cs.filter(c => c.x === s.x + 1 && c.y >= s.y && c.y < s.y + s.h);
      expect(mine.length).toBe(s.h - 2);
      expect(Math.min(...mine.map(c => c.y))).toBe(s.y + 1);
      expect(Math.max(...mine.map(c => c.y))).toBe(s.y + s.h - 2);
    });
  });
  it('row r of slot k shows the stated base, and the pattern moves down one row per 4 frames', () => {
    const mod = (a: number, n: number): number => ((a % n) + n) % n;
    for (const t of [0, 1, 3, 4, 17, 100, 143, 200, 287]) {
      const cs = rnaCellsAt(slots, colours, t);
      slots.forEach((s, k) => {
        for (let r = 1; r <= s.h - 2; r++) {
          const cell = cs.find(c => c.x === s.x + 1 && c.y === s.y + r)!;
          const base = RNA_SEQUENCE[mod(k * 9 + r - Math.floor(t / 4), 36)] as 'A' | 'U' | 'G' | 'C';
          expect(cell.color).toBe(colours[base]);
        }
      });
    }
    const a = rnaCellsAt(slots, colours, 8), b = rnaCellsAt(slots, colours, 12);
    const s = slots[0];
    const col = (cs: InstrumentCell[]): string[] => cs.filter(c => c.x === s.x + 1 && c.y < s.y + s.h).sort((p, q) => p.y - q.y).map(c => c.color);
    expect(col(b).slice(1)).toEqual(col(a).slice(0, -1));
    expect(rnaCellsAt(slots, colours, 8)).toEqual(rnaCellsAt(slots, colours, 11));
  });
  it('is periodic in 144 frames', () => {
    for (let t = 0; t < 144; t += 5) expect(rnaCellsAt(slots, colours, t + 144)).toEqual(rnaCellsAt(slots, colours, t));
  });
});

describe('activity strip', () => {
  const levels = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 1, 2, 3, 2];
  const ST = stripStaticCells(levels);

  it('is 14 lights of 2x2 cells with 1-cell gaps, inside STRIP and REV_ZONE', () => {
    expect(STRIP).toEqual({ x: 137, y: 70, w: 41, h: 2 });
    expect(inside(STRIP, REV_ZONE)).toBe(true);
    expect(ST.length).toBe(56);
    expect(new Set(ST.map(key)).size).toBe(56);
    for (const c of ST) {
      expect(c.x).toBeGreaterThanOrEqual(STRIP.x); expect(c.x).toBeLessThan(STRIP.x + STRIP.w);
      expect(c.y).toBeGreaterThanOrEqual(STRIP.y); expect(c.y).toBeLessThan(STRIP.y + STRIP.h);
    }
    for (let i = 0; i < 14; i++) {
      const mine = ST.filter(c => c.x >= STRIP.x + 3 * i && c.x < STRIP.x + 3 * i + 2);
      expect(mine.length).toBe(4);
      expect(new Set(mine.map(c => c.color)).size).toBe(1);
      expect(mine[0].color).toBe(STRIP_GREENS[levels[i]]);
    }
    for (let i = 0; i < 13; i++) expect(ST.some(c => c.x === STRIP.x + 3 * i + 2)).toBe(false);   // the gaps are bare
  });
  it('throws on a wrong length or an out-of-range level', () => {
    expect(() => stripStaticCells(levels.slice(1))).toThrow();
    expect(() => stripStaticCells([...levels, 0])).toThrow();
    expect(() => stripStaticCells([...levels.slice(0, 13), 5])).toThrow();
    expect(() => stripStaticCells([...levels.slice(0, 13), -1])).toThrow();
    expect(() => stripStaticCells([...levels.slice(0, 13), 1.5])).toThrow();
    expect(() => stripCellsAt(levels.slice(1), 0)).toThrow();
  });
  it('pulses only the last light, 6 of every 48 frames, one level up', () => {
    const lastX = STRIP.x + 3 * 13;
    const lit = (t: number): InstrumentCell[] => stripCellsAt(levels, t);
    let on = 0;
    for (let t = 0; t < T; t++) {
      const cs = lit(t);
      if (cs.length) {
        on++;
        expect(cs.length).toBe(4);
        for (const c of cs) { expect(c.x).toBeGreaterThanOrEqual(lastX); expect(c.x).toBeLessThan(lastX + 2); expect(c.color).toBe(STRIP_GREENS[levels[13] + 1]); }
      }
      expect(lit(t + 48)).toEqual(cs);
    }
    expect(on).toBe(6 * (T / 48));
    const first = Array.from({ length: 48 }, (_, t) => lit(t).length > 0);
    expect(first.filter(Boolean).length).toBe(6);
  });
  it('never pulses at level 4', () => {
    const l4 = [...levels.slice(0, 13), 4];
    for (let t = 0; t < 96; t++) expect(stripCellsAt(l4, t)).toEqual([]);
  });
  it('STRIP_GREENS are distinct at 4 bits per channel, and from the board colours', () => {
    expect(STRIP_GREENS.length).toBe(5);
    expect(STRIP_GREENS[0]).toBe('#0e1a0e');
    expect(STRIP_GREENS[4]).toBe('#39ff14');
    const qs = [...STRIP_GREENS, '#0a0a0a', '#111111'].map(q4);
    expect(new Set(qs).size).toBe(7);
  });
});
