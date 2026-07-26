import { describe, expect, it } from 'vitest';
import { checkContinuity, islandsOf } from './continuity.js';
import { buildWorld } from './timeline.js';
import type { World } from './types.js';

const T = 288;
let cached: World | undefined;
const world = (): World => (cached ??= buildWorld(20260724, T));

describe('islandsOf', () => {
  it('counts 8-connected components', () => {
    expect(islandsOf([])).toBe(0);
    expect(islandsOf([{ x: 0, y: 0 }])).toBe(1);
    expect(islandsOf([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(1);   // diagonal counts
    expect(islandsOf([{ x: 0, y: 0 }, { x: 2, y: 0 }])).toBe(2);
    expect(islandsOf([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 5 }, { x: 6, y: 6 }])).toBe(2);
  });
});

describe('the five continuity checks', () => {
  it('report zero defects on the pinned configuration', () => {
    const r = checkContinuity(world());
    expect(r.brokenNets).toBe(0);
    expect(r.slotJumps).toBe(0);
    expect(r.fragmentedFrames).toBe(0);
    expect(r.darkTransits).toBe(0);
    expect(r.offCopper).toBe(0);
    expect(r.defects).toBe(0);
  });

  it('are not vacuous: every check has real material to look at', () => {
    const r = checkContinuity(world());
    expect(r.transitEvents).toBeGreaterThan(1000);   // §13.2 measured 1359-1586
    expect(r.contestedTransits).toBeGreaterThan(0);  // contested is allowed and expected
    expect(r.onCopper).toBeGreaterThan(4000);        // §13.1 measured 5254 on-board cells
  });

  // The checker has to be able to FAIL, or "0 defects" means nothing. Each of the
  // five is fed a deliberately broken world and must notice.
  it('detects a broken static copper run (A)', () => {
    const w = world();
    const broken: World = { ...w, nets: [{ ...w.nets[0], cells: [{ x: 10, y: 10 }, { x: 40, y: 40 }] }, ...w.nets.slice(1)] };
    expect(checkContinuity(broken).brokenNets).toBe(1);
  });

  it('detects a teleporting flow (B) and the fragmented comet it draws (C)', () => {
    const w = world();
    const f = w.flows.find(x => x.kind === 'interior')!;
    const slots = [...f.slots];
    slots[100] = { x: slots[100]!.x + 40, y: slots[100]!.y + 40 };
    const broken: World = { ...w, flows: [{ ...f, slots }] };
    const r = checkContinuity(broken);
    expect(r.slotJumps).toBeGreaterThan(0);
    expect(r.worstJump).toBeGreaterThan(1);
    expect(r.fragmentedFrames).toBeGreaterThan(0);
  });

  it('detects a signal crossing a dark part (D)', () => {
    const w = world();
    const broken: World = { ...w, takeovers: new Map() };
    expect(checkContinuity(broken).darkTransits).toBeGreaterThan(0);
  });

  it('detects a flow travelling off copper (E)', () => {
    const w = world();
    const broken: World = { ...w, nets: [], fabric: [] };
    expect(checkContinuity(broken).offCopper).toBeGreaterThan(0);
  });
});
