import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng.js';
import {
  ACCENT_LIST, BOARD_RIGHT, FANOUT_X, FIELD_X, FINGERS, GUTTERS, HUB_RECTS, MOUNT_HOLES,
  NAME_BASELINE_PX, NAME_FONT_PX, NAME_X_PX, NAME_ZONE, REV_BASELINE_PX, REV_FONT_PX, REV_RIGHT_PX, REV_ZONE,
  TEXT_ZONES, THESIS_ZONE, buildGraph, buildLayout, fabricCells, inRect, overlaps, revFromSeed,
  segment, stubPath, transit,
} from './layout.js';
import { buildNets } from './growth.js';
import type { Cell, Rect } from './types.js';

const SEEDS = [20260724, 20260101, 20260315];
const cache = new Map<number, ReturnType<typeof buildLayout>>();
const layoutOf = (seed: number): ReturnType<typeof buildLayout> => {
  if (!cache.has(seed)) cache.set(seed, buildLayout(mulberry32(seed)));
  return cache.get(seed)!;
};

const contiguous = (path: readonly Cell[]): boolean =>
  path.every((c, i) => i === 0
    || Math.max(Math.abs(c.x - path[i - 1].x), Math.abs(c.y - path[i - 1].y)) === 1);

describe('board geometry (§12, carried unchanged by §13.5)', () => {
  it('splits board and void at x=230 and places 9 fingers in 3 groups', () => {
    expect(BOARD_RIGHT).toBe(230);
    expect(FINGERS).toHaveLength(9);
    for (const band of [0, 1, 2]) expect(FINGERS.filter(f => f.band === band)).toHaveLength(3);
    for (const f of FINGERS) { expect(f.x).toBe(227); expect(f.h).toBe(3); }
  });

  it('keeps §12.4\'s four fixed mount holes, the right pair between finger groups', () => {
    expect(MOUNT_HOLES).toEqual([{ x: 6, y: 6 }, { x: 6, y: 74 }, { x: 222, y: 21 }, { x: 222, y: 42 }]);
    for (const h of MOUNT_HOLES.filter(m => m.x > 200))
      expect(FINGERS.some(f => h.y >= f.y - 1 && h.y <= f.y + f.h)).toBe(false);
  });

  it('formats REV from the seed and rejects non-dates', () => {
    expect(revFromSeed(20260724)).toBe('2026.07.24');
    expect(() => revFromSeed(20260230)).toThrow();
    expect(() => revFromSeed(1234)).toThrow();
  });
});

describe('§13.5 text layer', () => {
  it('pins the split legend: name 15px LEFT at NAME_ZONE.x + 9 cells, REV 11px RIGHT at the board edge', () => {
    expect(NAME_X_PX).toBe((NAME_ZONE.x + 9) * 4);
    expect(NAME_X_PX).toBe(NAME_ZONE.x * 4 + 36);
    expect(NAME_FONT_PX).toBe(15);
    expect(REV_FONT_PX).toBe(11);
    // Cody, 2026-07-25: "can we move rev to right side of board." The REV line
    // ends 2 cells (8 px) inside REV_ZONE's right edge, which IS the board edge
    // x = 230 — so it prints on the board and never in the void.
    expect(REV_RIGHT_PX).toBe((REV_ZONE.x + REV_ZONE.w - 2) * 4);
    expect(REV_RIGHT_PX).toBe(912);
    expect(REV_RIGHT_PX).toBeLessThan(BOARD_RIGHT * 4);
    // one shared baseline, size the only hierarchy (§12.7's rule, restored)
    expect(NAME_BASELINE_PX).toBe(22);
    expect(REV_BASELINE_PX).toBe(NAME_BASELINE_PX);
    expect(NAME_ZONE.y).toBe(REV_ZONE.y);
  });

  it('clears the right-hand mount holes and the connector fingers by construction', () => {
    // The right-hand mount pair sits at y 21 and 42 and the fingers stop at
    // y 58; the legend band is y 66-78, so nothing in the band has a keepout.
    for (const y of [21, 42]) expect(y).toBeLessThan(REV_ZONE.y);
    expect(Math.max(...FINGERS.map(f => f.y + f.h))).toBeLessThan(REV_ZONE.y);
  });

  it('keeps all three zones as binding exclusion masks; only THESIS_ZONE is retired as text', () => {
    expect(TEXT_ZONES).toEqual([NAME_ZONE, THESIS_ZONE, REV_ZONE]);
    expect(THESIS_ZONE).toEqual({ x: 80, y: 66, w: 54, h: 12 });
    expect(REV_ZONE).toEqual({ x: 134, y: 66, w: 96, h: 12 });
    // the three zones tile the bottom band without intersecting
    for (let i = 0; i < TEXT_ZONES.length; i++)
      for (let j = i + 1; j < TEXT_ZONES.length; j++)
        expect(overlaps(TEXT_ZONES[i], TEXT_ZONES[j])).toBe(false);
  });
});

describe('§12.2/§12.3 canonical floorplan', () => {
  it.each(SEEDS)('places the whole vocabulary with only §12.8\'s counts varying (seed %i)', seed => {
    const l = layoutOf(seed);
    const n = (kind: string): number => l.components.filter(c => c.kind === kind).length;
    expect(n('cpuSocket')).toBe(1);
    expect(n('heatsink')).toBe(1);
    expect(n('fan')).toBe(1);
    expect(n('coinCell')).toBe(1);
    expect(n('pcieSlot')).toBe(2);
    expect(n('qfp')).toBe(5);
    expect(n('choke')).toBe(n('mosfet'));
    expect(n('choke')).toBeGreaterThanOrEqual(5);
    expect(n('choke')).toBeLessThanOrEqual(6);
    expect(n('dimmSlot')).toBeGreaterThanOrEqual(3);
    expect(n('dimmSlot')).toBeLessThanOrEqual(4);
    // §13.1's measured node count: 92-96 §12.3 parts plus the seeded extras
    expect(l.components.length).toBeGreaterThanOrEqual(90);
    expect(l.components.length).toBeLessThanOrEqual(100);
  });

  it.each(SEEDS)('keeps every component field footprint out of a routing gutter (seed %i)', seed => {
    for (const c of layoutOf(seed).components) {
      if (c.rect.x > FIELD_X[1]) continue; // the fanout zone has its own rule
      for (const [lo, hi] of GUTTERS)
        expect(c.rect.y > hi || c.rect.y + c.rect.h - 1 < lo).toBe(true);
    }
  });

  it.each(SEEDS)('puts fanout-zone parts only in the dead lanes between finger groups (seed %i)', seed => {
    const fanout = layoutOf(seed).components.filter(c => c.rect.x >= FANOUT_X[0]);
    expect(fanout.length).toBeGreaterThan(0);
    for (const c of fanout)
      for (const f of FINGERS)
        expect(overlaps(c.rect, { x: f.x - 30, y: f.y, w: 34, h: f.h })).toBe(false);
  });

  it.each(SEEDS)('places the three §12.4 hub QFPs at their fixed coordinates (seed %i)', seed => {
    for (const hub of HUB_RECTS)
      expect(layoutOf(seed).components.some(c => c.kind === 'qfp' && c.body.x === hub.x && c.body.y === hub.y)).toBe(true);
  });

  it.each(SEEDS)('never overlaps a text zone and never strays off the board (seed %i)', seed => {
    const l = layoutOf(seed);
    for (const c of [...l.components.map(x => x.rect), ...l.dressing.features.map(f => f.rect)] as Rect[]) {
      expect(TEXT_ZONES.some(z => overlaps(c, z))).toBe(false);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(BOARD_RIGHT);
    }
  });

  it('is deterministic and assigns a real accent permutation (§12.8)', () => {
    expect(JSON.stringify(buildLayout(mulberry32(20260724))))
      .toBe(JSON.stringify(buildLayout(mulberry32(20260724))));
    const l = layoutOf(20260724);
    expect([...l.accents].sort()).toEqual([...ACCENT_LIST].sort());
    for (const c of l.components) if (c.accent) expect(ACCENT_LIST).toContain(c.accent);
  });
});

describe('§13.1 canonical walk geometry', () => {
  it('segment/stubPath produce 4-connected runs that end on the target', () => {
    const s = segment({ x: 3, y: 3 }, { x: 9, y: 7 }, true);
    expect(contiguous([{ x: 3, y: 3 }, ...s])).toBe(true);
    expect(s[s.length - 1]).toEqual({ x: 9, y: 7 });
    const st = stubPath({ x: 20, y: 4 }, { x: 20, y: 12 });
    expect(contiguous([{ x: 20, y: 4 }, ...st])).toBe(true);
    expect(st[st.length - 1]).toEqual({ x: 20, y: 12 });
    expect(stubPath({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([]);
  });

  it('transit crosses a component: contiguous, through the centre, ending on the next spine start', () => {
    const from = { x: 10, y: 20 }, via = { x: 16, y: 24 }, to = { x: 22, y: 27 };
    const cells = transit(from, via, to);
    expect(contiguous([from, ...cells])).toBe(true);
    expect(cells.some(c => c.x === via.x && c.y === via.y)).toBe(true);
    expect(cells[cells.length - 1]).toEqual(to);
  });
});

describe('§13.1 graph + fabric', () => {
  it.each(SEEDS)('emits one fabric stub per node/edge incidence, from the same stubPath a walk uses (seed %i)', seed => {
    const l = layoutOf(seed);
    const g = buildGraph(l.components, buildNets(l));
    const fabric = new Set(fabricCells(g).map(c => `${c.x},${c.y}`));
    for (const e of g.edges) {
      const ends: [number, Cell][] = [[e.a, e.cells[0]], [e.b, e.cells[e.cells.length - 1]]];
      for (const [node, endpoint] of ends) {
        expect(fabric.has(`${endpoint.x},${endpoint.y}`)).toBe(true);
        for (const c of stubPath(endpoint, g.nodes[node].center)) expect(fabric.has(`${c.x},${c.y}`)).toBe(true);
      }
    }
  });

  it.each(SEEDS)('never draws fabric inside a text zone (seed %i)', seed => {
    const l = layoutOf(seed);
    const g = buildGraph(l.components, buildNets(l));
    for (const c of fabricCells(g)) expect(TEXT_ZONES.some(z => inRect(c.x, c.y, z))).toBe(false);
  });
});
