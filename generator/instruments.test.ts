import { describe, expect, it } from 'vitest';
import { REV_ZONE, THESIS_ZONE } from './layout.js';
import { mixOnBg } from './render.js';
import type { Rect } from './types.js';
import {
  INSTRUMENT_COLOURS, REPRESSILATOR_LEVELS, REPRESSILATOR_PERIOD, RNA_BASE_COLOURS, RNA_FRAMES_PER_BASE, RNA_SEQUENCE,
  SCOPE, SCOPE_BASELINE_ALPHA, SCOPE_COLS, SCOPE_FRAMES_PER_COL, STRIP, STRIP_GREENS,
  repressilatorLevelsAt, RNA_CHANNEL_DARK, rnaCellsAt, rnaChannelCells, scopeCellsAt, scopeStaticCells, stripCellsAt, stripStaticCells,
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
    for (const c of ['#111111', '#2a2a2a', '#888888', ...STRIP_GREENS, '#ff2d78', '#ffd23f', '#00e5ff'])
      expect(INSTRUMENT_COLOURS).toContain(c);
    expect(INSTRUMENT_COLOURS.length).toBe(11);
  });
  it('the three baselines are their neuron\'s accent at 0.4 on the chip body, each in an rgb444 bin of its own, apart from the ticks and the body', () => {
    expect(SCOPE_BASELINE_ALPHA).toBe(0.4);
    const ACCENTS5 = ['#ff2d78', '#39ff14', '#bf5af2', '#00e5ff', '#ff6a00'];
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) {
      const acc = [ACCENTS5[i], ACCENTS5[j], ACCENTS5[k]] as const;
      const dim = acc.map(a => mixOnBg(a, 0.4, '#111111'));
      const bins = [...dim, ...acc, '#111111', '#2a2a2a', '#888888'].map(q4);
      expect(new Set(bins).size, acc.join(' ')).toBe(bins.length);
    }
  });
  it('every fixed colour the cells emit is in the list (accent-derived ones aside)', () => {
    const accentish = new Set<string>([...ACC, ...ACC.map(a => mixOnBg(a, 0.4, '#111111'))]);
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
  it('has bezel, corner pins, body padding, and baselines in each neuron\'s accent at 0.4', () => {
    const at = (x: number, y: number): string => statics.find(c => c.x === x && c.y === y)!.color;
    const x1 = SCOPE.x + SCOPE.w - 1, y1 = SCOPE.y + SCOPE.h - 1;
    for (const [x, y] of [[SCOPE.x, SCOPE.y], [x1, SCOPE.y], [SCOPE.x, y1], [x1, y1]]) expect(at(x, y)).toBe('#888888');
    expect(at(SCOPE.x + 10, SCOPE.y)).toBe('#2a2a2a');
    expect(at(SCOPE.x, SCOPE.y + 5)).toBe('#2a2a2a');
    expect(at(SCOPE.x + 1, SCOPE.y + 5)).toBe('#111111');           // padding
    expect(at(SCOPE.x + 10, SCOPE.y + 1)).toBe('#111111');
    for (let s = 0; s < 3; s++) {
      const dim = mixOnBg(ACC[s], 0.4, '#111111');
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
  it('a tick is 2 cells tall, in the neuron\'s full accent, and brighter than its baseline', () => {
    for (const soma of [0, 1, 2]) {
      const cs = scopeCellsAt([{ soma, t: 4 }], ACC, 4, T);
      expect(cs.length).toBe(2);
      for (const c of cs) expect(c.color).toBe(ACC[soma]);
      expect(new Set(cs.map(c => c.x)).size).toBe(1);
      expect(Math.abs(cs[0].y - cs[1].y)).toBe(1);
    }
  });
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
  it('has fixed base colours, the same for every seed, each in an rgb444 bin of its own', () => {
    expect(RNA_BASE_COLOURS).toEqual({ A: '#39ff14', U: '#ff2d78', G: '#ffd23f', C: '#00e5ff' });
    const qs = [...Object.values(RNA_BASE_COLOURS), '#0a0a0a', '#111111', '#2a2a2a', '#3a3a3a', '#888888'].map(q4);
    expect(new Set(qs).size).toBe(9);
  });
  const mod = (a: number, n: number): number => ((a % n) + n) % n;
  const colAt = (s: Rect, cs: InstrumentCell[]): Map<number, string> =>
    new Map(cs.filter(c => c.x === s.x + 1 && c.y >= s.y && c.y < s.y + s.h).map(c => [c.y, c.color]));

  it('has a channel: the centre column, rows y + 1 .. y + h - 2 of each slot, and a dark colour for it', () => {
    expect(RNA_CHANNEL_DARK).toBe('#0a0a0a');
    const ch = rnaChannelCells(slots);
    expect(ch.length).toBe(slots.reduce((n, s) => n + s.h - 2, 0));
    expect(new Set(ch.map(key)).size).toBe(ch.length);
    for (const c of rnaCellsAt(slots, colours, 77)) expect(ch.some(p => p.x === c.x && p.y === c.y)).toBe(true);
    slots.forEach(s => {
      const mine = ch.filter(c => c.x === s.x + 1);
      expect(Math.min(...mine.filter(c => c.y >= s.y && c.y < s.y + s.h).map(c => c.y))).toBe(s.y + 1);
    });
  });
  it('draws only every second row of the channel (one lit cell, one dark), in the centre column', () => {
    for (const t of [0, 1, 2, 3, 50]) {
      const cs = rnaCellsAt(slots, colours, t);
      expect(new Set(cs.map(key)).size).toBe(cs.length);
      slots.forEach(s => {
        const mine = [...colAt(s, cs).keys()].sort((p, q) => p - q);
        expect(mine.length).toBeGreaterThanOrEqual(Math.floor((s.h - 2) / 2));
        expect(mine.length).toBeLessThanOrEqual(Math.ceil((s.h - 2) / 2));
        expect(mine[0]).toBeGreaterThanOrEqual(s.y + 1);
        expect(mine[mine.length - 1]).toBeLessThanOrEqual(s.y + s.h - 2);
        for (let i = 1; i < mine.length; i++) expect(mine[i] - mine[i - 1]).toBe(2);   // a dark cell between bases
      });
      for (const c of cs) expect(slots.some(s => c.x === s.x + 1)).toBe(true);
    }
  });
  it('row r of slot k shows base (k * 9 + (r - shift) / 2) when r - shift is even, shift = floor(t / 2)', () => {
    for (const t of [0, 1, 3, 4, 17, 100, 143, 200, 287]) {
      const cs = rnaCellsAt(slots, colours, t), shift = Math.floor(t / 2);
      slots.forEach((s, k) => {
        const col = colAt(s, cs);
        for (let r = 1; r <= s.h - 2; r++) {
          const u = r - shift;
          if (mod(u, 2) !== 0) { expect(col.has(s.y + r)).toBe(false); continue; }
          const base = RNA_SEQUENCE[mod(k * 9 + u / 2, 36)] as 'A' | 'U' | 'G' | 'C';
          expect(col.get(s.y + r)).toBe(colours[base]);
        }
      });
    }
  });
  it('scrolls down ONE CELL every 2 frames: smooth, and a base crosses 2 cells in 4 frames', () => {
    const s = slots[0];
    expect(rnaCellsAt(slots, colours, 4)).toEqual(rnaCellsAt(slots, colours, 5));      // holds for 2 frames
    for (const t of [0, 2, 10, 40, 142]) {
      const a = colAt(s, rnaCellsAt(slots, colours, t)), b = colAt(s, rnaCellsAt(slots, colours, t + 2));
      let compared = 0;
      for (const [y, color] of a) if (y + 1 <= s.y + s.h - 2) { expect(b.get(y + 1)).toBe(color); compared++; }
      expect(compared).toBeGreaterThan(5);
    }
    expect(RNA_FRAMES_PER_BASE).toBe(4);
  });
  it('shows different parts of the sequence in different slots (the per-slot offset)', () => {
    const cs = rnaCellsAt(slots, colours, 0);
    const seqs = slots.slice(0, 2).map(s => [...colAt(s, cs).values()].join(''));
    expect(seqs[0]).not.toBe(seqs[1]);
  });
  it('repeats exactly every 144 frames, and not sooner', () => {
    for (let t = 0; t < 144; t += 5) expect(rnaCellsAt(slots, colours, t + 144)).toEqual(rnaCellsAt(slots, colours, t));
    for (const half of [36, 72]) expect(rnaCellsAt(slots, colours, half)).not.toEqual(rnaCellsAt(slots, colours, 0));
    expect(T % 144).toBe(0);
  });
});

describe('activity strip', () => {
  const levels = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 1, 2, 3, 2];
  const ST = stripStaticCells(levels);

  it('is 14 lights of 2 wide x 3 tall cells with 1-cell gaps, inside STRIP and REV_ZONE', () => {
    expect(STRIP).toEqual({ x: 137, y: 69, w: 41, h: 3 });
    expect(inside(STRIP, REV_ZONE)).toBe(true);
    expect(ST.length).toBe(84);
    expect(new Set(ST.map(key)).size).toBe(84);
    for (const c of ST) {
      expect(c.x).toBeGreaterThanOrEqual(STRIP.x); expect(c.x).toBeLessThan(STRIP.x + STRIP.w);
      expect(c.y).toBeGreaterThanOrEqual(STRIP.y); expect(c.y).toBeLessThan(STRIP.y + STRIP.h);
    }
    for (let i = 0; i < 14; i++) {
      const mine = ST.filter(c => c.x >= STRIP.x + 3 * i && c.x < STRIP.x + 3 * i + 2);
      expect(mine.length).toBe(6);
      expect(new Set(mine.map(c => c.y)).size).toBe(3);
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
        expect(cs.length).toBe(6);
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
    expect([...STRIP_GREENS]).toEqual(['#0e1a0e', '#1d6a18', '#28a51a', '#31d417', '#39ff14']);
    const qs = [...STRIP_GREENS, '#0a0a0a', '#111111'].map(q4);
    expect(new Set(qs).size).toBe(7);
    // levels can be told apart: every step up gains at least 2 bins of green
    const g = STRIP_GREENS.map(c => parseInt(q4(c).split(',')[1]));
    for (let i = 1; i < 5; i++) expect(g[i] - g[i - 1]).toBeGreaterThanOrEqual(2);
    expect(g[1]).toBeGreaterThanOrEqual(5);                     // the lowest lit level is already a visible green
  });
});
