import { describe, expect, it } from 'vitest';
import { mulberry32, pick, randInt, shuffled } from './rng.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('yields values in [0,1) and differs across seeds', () => {
    const r = mulberry32(20260724);
    const vals = Array.from({ length: 200 }, () => r());
    for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    expect(vals[0]).not.toBe(mulberry32(20260725)());
  });

  it('randInt covers inclusive bounds; pick returns members', () => {
    const r = mulberry32(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(randInt(r, 3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(arr).toContain(pick(r, arr));
  });
});

describe('shuffled', () => {
  it('permutes without mutating the input, and is seeded', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(mulberry32(11), src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort((a, b) => a - b)).toEqual(src);
    expect(shuffled(mulberry32(11), src)).toEqual(out);
    expect(shuffled(mulberry32(12), src)).not.toEqual(out);
  });
});
