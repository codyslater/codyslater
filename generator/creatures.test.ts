import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng.js';
import { ACCENT_LIST } from './layout.js';
import {
  BAND, LADDER_MAX_TRIES, MIN_MEAN_BODIES, POP_BAND, RATIO_KNOBS, RUNGS, ROW_PROFILE, SOUP,
  assess, biggestCluster, buildReleaseSchedule, findSoup, genLength, meets, rollAffinity,
  rungBand, simulateSoup, subSeeds, visibleAges, walkLadder, VOID_X0, VOID_X1, VOID_Y0, VOID_Y1,
  FORMED_FRAME_FRACTION, meetsShippedForm, voidOccupancy, BARE_QUARTER_CELLS, VOID_QUARTERS,
  SHIPPED_MONO, SHIPPED_SYM, VOID_FILL_MEAN_MAX, VOID_FILL_PEAK_MAX, nucleiBudgetFor, voidPopulation,
} from './creatures.js';
import { BONDED_MEAN_MIN, VOID_FILL_MEAN_RANGE } from './timeline.js';
import type { EscapeEvent, SoupRun } from './types.js';

const T = 288;
const S = genLength(T);

/** Nine escapes, one per finger, evenly staggered — the shape §13.2 guarantees. */
const EVENTS: EscapeEvent[] = Array.from({ length: 9 }, (_, i) => ({
  frame: Math.round(((i + 0.5) / 9) * T), finger: i, color: ACCENT_LIST[i % ACCENT_LIST.length],
}));

describe('§13.4 the generation arc', () => {
  it('runs 4 overlapping generations, S = 4T', () => {
    expect(SOUP.COPIES).toBe(4);
    expect(genLength(T)).toBe(1152);
  });

  it('shows four ages at once and is a pure function of t mod T — the seam', () => {
    expect(visibleAges(0, T)).toEqual([0, 288, 576, 864]);
    expect(visibleAges(T, T)).toEqual(visibleAges(0, T));
    expect(visibleAges(287, T)).toEqual([287, 575, 863, 1151]);
    for (const t of [0, 1, 143, 287]) expect(visibleAges(t, T)).toHaveLength(SOUP.COPIES);
  });
});

describe('§13.3 the release schedule', () => {
  it('fires one beat every 4 frames — 72 releases per loop at T=288', () => {
    const m = buildReleaseSchedule(EVENTS, T);
    const total = [...m.values()].reduce((n, v) => n + v.length, 0);
    expect(total).toBe(T / SOUP.BEAT);
    expect(total).toBe(72);
    expect(SOUP.BEAT).toBe(4);
  });

  it('caps the beat train at 2 feeder arcs (§13.4), restoring the reference flux exactly', () => {
    expect(SOUP.FEEDERS_MAX).toBe(2);
    const ages = [...buildReleaseSchedule(EVENTS, T).keys()].sort((a, b) => a - b);
    // ages land in [0, T) and [T, 2T) only — never in the third or fourth copy
    expect(Math.max(...ages)).toBeLessThan(2 * T);
    const window = Math.max(...ages) + SOUP.BEAT;
    expect(72 / window).toBeCloseTo(SOUP.BEATS_REF / SOUP.WINDOW_REF, 6);
  });

  it('fires from exactly one finger per beat, taking turns among the draining ones', () => {
    const m = buildReleaseSchedule(EVENTS, T);
    for (const rels of m.values()) expect(rels.length).toBeLessThanOrEqual(2);
    const fingers = new Set([...m.values()].flat().map(r => r.finger));
    expect(fingers.size).toBe(9);
  });

  it('returns an empty schedule when nothing escaped (no crash path)', () => {
    expect(buildReleaseSchedule([], T).size).toBe(0);
  });
});

// §13.3's tables are "binding, as built and measured", and every one of these
// numbers was arrived at over twelve calibration rounds. They live in exactly
// one object, so this is the test that turns the spec's tables into a gate: a
// retune has to change the spec and this test together, deliberately.
describe('§13.3 the pinned constants', () => {
  it('matches §13.3\'s physics table', () => {
    expect({
      JITTER: SOUP.JITTER, DRAG: SOUP.DRAG, TERMINAL: SOUP.TERMINAL,
      FORCE_RADIUS: SOUP.FORCE_RADIUS, FORCE_STRENGTH: SOUP.FORCE_STRENGTH,
      SAME_ATTRACT: SOUP.SAME_ATTRACT, BONDED_PULL: SOUP.BONDED_PULL,
      GATHER: SOUP.GATHER, GATHER_RADIUS: SOUP.GATHER_RADIUS,
      CAPTURE_RADIUS: SOUP.CAPTURE_RADIUS, BOND_MAX_SPEED: SOUP.BOND_MAX_SPEED,
      NUCLEATE_RATE: SOUP.NUCLEATE_RATE, ACCRETE_RATE: SOUP.ACCRETE_RATE,
      DRIFT: SOUP.DRIFT, WANDER: SOUP.WANDER, STICK_RATE: SOUP.STICK_RATE,
      RESTITUTION: SOUP.RESTITUTION,
    }).toEqual({
      JITTER: 42, DRAG: 0.55, TERMINAL: 13,
      FORCE_RADIUS: 6, FORCE_STRENGTH: 13,
      SAME_ATTRACT: 0.55, BONDED_PULL: 2.6,
      GATHER: 3.2, GATHER_RADIUS: 40,
      CAPTURE_RADIUS: 1.9, BOND_MAX_SPEED: 9,
      NUCLEATE_RATE: 0.09, ACCRETE_RATE: 4.0,
      DRIFT: 0.22, WANDER: 3.0, STICK_RATE: 0.9,
      RESTITUTION: 0.8,
    });
  });

  it('matches §13.3\'s spring-capture, body-formation and release constants', () => {
    expect({
      SPRING_K: SOUP.SPRING_K, SPRING_DAMP: SOUP.SPRING_DAMP, BOND_EASE: SOUP.BOND_EASE,
      ASSIMILATE: SOUP.ASSIMILATE,
      STICKY_PULL_RATE: SOUP.STICKY_PULL_RATE, STICKY_RADIUS: SOUP.STICKY_RADIUS,
      STICKY_ACCEL: SOUP.STICKY_ACCEL, STICKY_BONUS: SOUP.STICKY_BONUS,
      FORM_FROM: SOUP.FORM_FROM, FORM_FULL: SOUP.FORM_FULL,
      FORM_BONUS: SOUP.FORM_BONUS, FORM_PENALTY: SOUP.FORM_PENALTY,
      SHED_RATE: SOUP.SHED_RATE, UPRIGHT: SOUP.UPRIGHT, EYE_MIN_SIZE: SOUP.EYE_MIN_SIZE,
      MERGE_FREE_SIZE: SOUP.MERGE_FREE_SIZE, MERGE_MATURE_RATE: SOUP.MERGE_MATURE_RATE,
      SEPARATE: SOUP.SEPARATE,
      BEAT: SOUP.BEAT, DRAIN_SPAN: SOUP.DRAIN_SPAN, DOUBLE_P: SOUP.DOUBLE_P,
      CRUST_MAX: SOUP.CRUST_MAX, CRUST_DWELL_LO: SOUP.CRUST_DWELL_LO, CRUST_DWELL_HI: SOUP.CRUST_DWELL_HI,
    }).toEqual({
      SPRING_K: 34, SPRING_DAMP: 6, BOND_EASE: 0.11,
      ASSIMILATE: 2.6,
      STICKY_PULL_RATE: 0.8, STICKY_RADIUS: 7, STICKY_ACCEL: 26, STICKY_BONUS: 9,
      FORM_FROM: 22, FORM_FULL: 40, FORM_BONUS: 5.0, FORM_PENALTY: 8,
      SHED_RATE: 0.8, UPRIGHT: 0.94, EYE_MIN_SIZE: 20,
      MERGE_FREE_SIZE: 25, MERGE_MATURE_RATE: 0.25, SEPARATE: 5.0,
      BEAT: 4, DRAIN_SPAN: 48, DOUBLE_P: 0.45,
      CRUST_MAX: 12, CRUST_DWELL_LO: 90, CRUST_DWELL_HI: 380,
    });
  });

  it('keeps §13.3\'s two DIFFERENT symmetry gates apart — 0.8 per body, 0.9 on the loop', () => {
    // "A build may not raise FORMED_SYM to 0.9 to make the acceptance number
    // easier — that would change what `formed` means and silently shrink the
    // formed-frame count."
    expect(SOUP.FORMED_SYM).toBe(0.8);
    expect(SOUP.FORMED_MONO).toBe(0.9);
    expect(SOUP.FORMED_MIN).toBe(40);
    expect(SHIPPED_SYM).toBe(0.9);
    expect(SHIPPED_MONO).toBe(0.9);
    expect(SOUP.FORMED_SYM).toBeLessThan(SHIPPED_SYM);
  });

  it('pins §13.3\'s body size band and the void domain, both bounds of both', () => {
    expect(BAND).toEqual([45, 70]);
    expect([VOID_X0, VOID_X1]).toEqual([231, 298]);
    expect([VOID_Y0, VOID_Y1]).toEqual([2, 76]);
    expect(POP_BAND).toEqual([130, 340]);
    // §13.4's exit: EXIT_SPAN = S / COPIES, span-scaled wind
    expect(SOUP.COPIES).toBe(4);
    expect(S / SOUP.COPIES).toBe(288);
    expect(SOUP.EXIT_WIND * (SOUP.SPAN_REF / (S / SOUP.COPIES))).toBeCloseTo(8.125, 6);
  });
});

describe('§13.3 the soup', () => {
  const releaseAt = buildReleaseSchedule(EVENTS, T);
  const frames = simulateSoup(mulberry32(0x51a7c0de), releaseAt, S, ACCENT_LIST);

  it('records exactly S frames and is exactly replayable', () => {
    expect(frames).toHaveLength(S);
    const again = simulateSoup(mulberry32(0x51a7c0de), releaseAt, S, ACCENT_LIST);
    expect(again[500].parts.length).toBe(frames[500].parts.length);
    expect(JSON.stringify(again[900])).toBe(JSON.stringify(frames[900]));
  });

  it('keeps every particle in the void and never on the board', () => {
    for (const st of frames)
      for (const p of st.parts) {
        expect(Math.round(p.x)).toBeGreaterThanOrEqual(VOID_X0);
        expect(Math.round(p.y)).toBeGreaterThanOrEqual(VOID_Y0 - 1);
        expect(Math.round(p.y)).toBeLessThanOrEqual(VOID_Y1 + 1);
      }
    expect(VOID_X0).toBe(231);
    expect(VOID_X1).toBe(298);
  });

  it('ends the arc genuinely bare — no particles, no clusters, no crust (the wrap invariant)', () => {
    const last = frames[S - 1];
    expect(last.parts).toHaveLength(0);
    expect(last.clusters).toHaveLength(0);
    expect(last.crust).toHaveLength(0);
  });

  it('never fades anything out: population falls only by exit or by bonding', () => {
    // a particle's only exits are the right edge, a body, or the crust — so no
    // frame may lose matter while the exit current is still off
    const exitStart = S - S / SOUP.COPIES;
    for (let t = 1; t < exitStart; t++) {
      const before = frames[t - 1].parts.length + frames[t - 1].crust.length;
      const after = frames[t].parts.length + frames[t].crust.length;
      expect(after).toBeGreaterThanOrEqual(before - 2);
    }
  });

  it('grows bodies that open a mirrored pair of 2x1 eyes — four cells', () => {
    const withEyes = frames.filter(st => st.parts.some(p => p.eye > 0.5));
    expect(withEyes.length).toBeGreaterThan(0);
    const st = withEyes[Math.floor(withEyes.length / 2)];
    const byCluster = new Map<number, number>();
    for (const p of st.parts) if (p.eye > 0.5) byCluster.set(p.cluster, (byCluster.get(p.cluster) ?? 0) + 1);
    for (const n of byCluster.values()) expect(n).toBe(4);
  });

  it('caps nuclei at floor(releases / 26), min 2 — a small cast, not a shoal', () => {
    // At the pinned configuration this lands on the MINIMUM (72/26 -> 2), which
    // is why the max clamp needs its own test below rather than riding on this.
    expect(nucleiBudgetFor(72)).toBe(SOUP.NUCLEI_MIN);
    const maxClusters = Math.max(...frames.map(st => st.clusters.length));
    expect(maxClusters).toBeLessThanOrEqual(nucleiBudgetFor(72));
  });

  it('exercises BOTH ends of §13.3\'s nuclei clamp — min 2 and max 4', () => {
    // "Nuclei per arc: floor(releases / 26), min 2, max 4." No run the suite
    // makes reaches the maximum, so it is asserted against the formula directly.
    expect(SOUP.NUCLEI_PER).toBe(26);
    expect([SOUP.NUCLEI_MIN, SOUP.MAX_NUCLEI]).toEqual([2, 4]);
    expect(nucleiBudgetFor(0)).toBe(2);          // floor clamp
    expect(nucleiBudgetFor(51)).toBe(2);         // floor(51/26) = 1 -> clamped up
    expect(nucleiBudgetFor(78)).toBe(3);         // floor(78/26) = 3, linear
    expect(nucleiBudgetFor(104)).toBe(4);        // floor(104/26) = 4, at the ceiling
    expect(nucleiBudgetFor(10_000)).toBe(4);     // ceiling clamp
  });

  it('carries the 12-row anatomy: head at rows 2-3, neck pinch, torso, legs', () => {
    expect(ROW_PROFILE).toHaveLength(12);
    expect(ROW_PROFILE[4]).toBeLessThan(ROW_PROFILE[3]);       // neck pinch under the head
    expect(ROW_PROFILE[5]).toBeGreaterThan(ROW_PROFILE[4]);    // torso is the widest part
    expect(Math.max(...ROW_PROFILE)).toBe(ROW_PROFILE[5]);
    expect(ROW_PROFILE[11]).toBeLessThan(ROW_PROFILE[8]);      // legs taper
  });

  it('rolls an asymmetric affinity matrix — same colour attracts, most cross pairs repel', () => {
    const aff = rollAffinity(mulberry32(7), 5);
    for (let i = 0; i < 5; i++) expect(aff[i][i]).toBe(SOUP.SAME_ATTRACT);
    const cross = aff.flatMap((row, i) => row.filter((_, j) => i !== j));
    expect(cross.filter(v => v < 0).length).toBeGreaterThan(cross.length / 2);
    expect(cross.some(v => v > 0)).toBe(true);
    // asymmetric: at least one pair disagrees across the diagonal
    expect(aff.some((row, i) => row.some((v, j) => i !== j && v !== aff[j][i]))).toBe(true);
  });
});

describe('the free-vs-bonded ratio', () => {
  it('names every knob that moves it, and every one is a real SOUP constant', () => {
    // Cody, 2026-07-25: "lean toward having lower ratio of floating pixels vs
    // part of some life form." That pass moved GATHER_RADIUS and ACCRETE_RATE;
    // this test holds the index honest so the next one is also a constants
    // change and not a refactor.
    expect(RATIO_KNOBS.length).toBeGreaterThan(10);
    for (const k of RATIO_KNOBS) {
      expect(SOUP).toHaveProperty(k);
      expect(typeof SOUP[k]).toBe('number');
    }
    expect(new Set(RATIO_KNOBS).size).toBe(RATIO_KNOBS.length);
    // the levers the tuning round actually moved must be in the list
    expect(RATIO_KNOBS).toContain('ACCRETE_RATE');
    expect(RATIO_KNOBS).toContain('GATHER_RADIUS');
    expect(RATIO_KNOBS).toContain('NUCLEATE_RATE');
  });
});

describe('§13.4 the relaxation ladder', () => {
  const base: SoupRun = {
    frames: [], peak: 55, peakAt: 800, meanPop: 250, minPop: 200, maxPop: 300, meanBodies: 5.5,
    eyes: true, empty: true, tailEmptyFrom: 1100, formedFrames: 300, ripeFrames: 380, mono: 0.95, sym: 0.98,
    bondedMean: 0.72, bondedMin: 0.60, fillMean: 0.032, fillPeak: 0.040, bareQuarter: 0,
  };

  it('never drops the band floor below FORMED_MIN', () => {
    for (const r of RUNGS) expect(rungBand(BAND, r.grow)[0]).toBeGreaterThanOrEqual(SOUP.FORMED_MIN);
  });

  it('holds §13.3\'s small cast on EVERY rung — no rung can ship "one creature plus confetti"', () => {
    // Raised 1.8 -> 4.0 at Cody's 2026-07-25 gate: seed 20260101 shipped a
    // rung-0 pick at 2.90 mean coexisting bodies against 5.27-5.68 on the other
    // gate seeds, and its void read as one creature plus drifting grains.
    expect(MIN_MEAN_BODIES).toBe(4.0);
    expect(RUNGS[0].bodies).toBe(MIN_MEAN_BODIES);
    // relaxable, like the other richness targets — but the LOOSEST rung a date
    // can ship on still excludes the 2.90 look, which is the whole point of
    // touching the lower rungs at all.
    for (const r of RUNGS) expect(r.bodies).toBeGreaterThan(2.9);
    for (let i = 1; i < RUNGS.length; i++)
      expect(RUNGS[i].bodies).toBeLessThanOrEqual(RUNGS[i - 1].bodies);
  });

  it('never relaxes eyes or the seam', () => {
    for (const r of RUNGS) {
      expect(meets({ ...base, eyes: false }, BAND, r)).toBe(false);
      expect(meets({ ...base, empty: false }, BAND, r)).toBe(false);
    }
  });

  it('never relaxes the shipped-loop mono/symmetry means — §13.3 forbids trading them', () => {
    for (const r of RUNGS) {
      expect(meets({ ...base, mono: 0.88 }, BAND, r)).toBe(false);
      expect(meets({ ...base, sym: 0.88 }, BAND, r)).toBe(false);
    }
    // and they are compared at the two decimals §13.3 quotes them to
    expect(meetsShippedForm({ ...base, mono: 0.8996 })).toBe(true);
    expect(meetsShippedForm({ ...base, mono: 0.8949 })).toBe(false);
  });

  it('relaxes every richness target, in order', () => {
    for (let i = 1; i < RUNGS.length; i++) {
      expect(RUNGS[i].formed).toBeLessThan(RUNGS[i - 1].formed);
      expect(RUNGS[i].formedFrac).toBeLessThan(RUNGS[i - 1].formedFrac);
      expect(RUNGS[i].bodies).toBeLessThan(RUNGS[i - 1].bodies);
      expect(RUNGS[i].bonded).toBeLessThan(RUNGS[i - 1].bonded);
      expect(RUNGS[i].fill).toBeLessThan(RUNGS[i - 1].fill);
      expect(RUNGS[i].pop[0]).toBeLessThanOrEqual(RUNGS[i - 1].pop[0]);
      expect(RUNGS[i].pop[1]).toBeGreaterThanOrEqual(RUNGS[i - 1].pop[1]);
      expect(RUNGS[i].upto).toBeGreaterThan(RUNGS[i - 1].upto);
    }
    expect(RUNGS.map(r => r.upto)).toEqual([6, 12, 20, 28]);
    expect(RUNGS[0].pop).toEqual(POP_BAND);
    // rung 0 searches on exactly the numbers the frame sweep asserts
    expect(RUNGS[0].formedFrac).toBe(FORMED_FRAME_FRACTION);
    expect(RUNGS[0].bonded).toBe(BONDED_MEAN_MIN);
    expect(RUNGS[0].fill).toBe(VOID_FILL_MEAN_RANGE[0]);
  });

  // §13.4's table, verbatim. The ladder is the only place these numbers live, so
  // pinning them here is what stops a "small" retune sliding the whole search.
  it('is §13.4\'s table, column for column', () => {
    const table = [
      { upto: 6, band: [45, 70], formed: 120, formedFrac: 0.70, pop: [130, 340], bodies: 4.0, bonded: 0.60, fill: 0.025, bare: 0.02 },
      { upto: 12, band: [42, 78], formed: 90, formedFrac: 0.62, pop: [120, 360], bodies: 3.6, bonded: 0.55, fill: 0.023, bare: 0.05 },
      { upto: 20, band: [40, 88], formed: 60, formedFrac: 0.55, pop: [110, 380], bodies: 3.2, bonded: 0.50, fill: 0.021, bare: 0.10 },
      { upto: 28, band: [40, Infinity], formed: 30, formedFrac: 0.45, pop: [100, 420], bodies: 3.0, bonded: 0.45, fill: 0.020, bare: 0.15 },
    ];
    expect(RUNGS).toHaveLength(table.length);
    RUNGS.forEach((r, i) => {
      const want = table[i];
      const [lo, hi] = rungBand(BAND, r.grow);
      expect(`rung ${i} band ${[lo, hi < 1e8 ? hi : Infinity]}`)
        .toBe(`rung ${i} band ${want.band}`);
      expect({
        upto: r.upto, formed: r.formed, formedFrac: r.formedFrac,
        pop: r.pop, bodies: r.bodies, bonded: r.bonded, fill: r.fill, bare: r.bare,
      }).toEqual({
        upto: want.upto, formed: want.formed, formedFrac: want.formedFrac,
        pop: want.pop, bodies: want.bodies, bonded: want.bonded, fill: want.fill, bare: want.bare,
      });
    });
    // §13.4: "The void-fill CEILINGS are tested at every rung and do not relax."
    for (const r of RUNGS) {
      expect(meets({ ...base, fillMean: VOID_FILL_MEAN_MAX + 0.001 }, BAND, r)).toBe(false);
      expect(meets({ ...base, fillPeak: VOID_FILL_PEAK_MAX + 0.001 }, BAND, r)).toBe(false);
    }
  });

  // Every clause of `meets` gated directly, not only through a corpus build:
  // a clause that only ever runs inside `findSoup` is a clause whose sign can be
  // wrong without any test noticing, because a real candidate rarely trips one
  // bound alone.
  it('rejects on EACH clause on its own — population, bodies, fill peak, bare quarter, band', () => {
    const r0 = RUNGS[0];
    expect(meets(base, BAND, r0)).toBe(true);                                  // the control
    // §13.5: "Standing population is the per-frame MINIMUM and MAXIMUM."
    expect(meets({ ...base, minPop: r0.pop[0] - 1 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, maxPop: r0.pop[1] + 1 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, minPop: r0.pop[0], maxPop: r0.pop[1] }, BAND, r0)).toBe(true);
    // a candidate that dips out of band cannot average its way back in
    expect(meets({ ...base, minPop: 10, meanPop: 250 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, meanBodies: r0.bodies - 0.01 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, fillPeak: VOID_FILL_PEAK_MAX + 0.001 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, bareQuarter: r0.bare + 0.001 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, formedFrames: r0.formed - 1 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, peak: 44 }, BAND, r0)).toBe(false);
    expect(meets({ ...base, peak: 71 }, BAND, r0)).toBe(false);
    // a run with no ripe frames at all cannot be failed on a 0/0 ratio
    expect(meets({ ...base, formedFrames: 300, ripeFrames: 0 }, BAND, r0)).toBe(true);
  });

  it('relaxes population and the bare quarter with the rung, and never the fill ceilings', () => {
    expect(meets({ ...base, minPop: 115 }, BAND, RUNGS[0])).toBe(false);
    expect(meets({ ...base, minPop: 115 }, BAND, RUNGS[2])).toBe(true);
    expect(meets({ ...base, maxPop: 370 }, BAND, RUNGS[0])).toBe(false);
    expect(meets({ ...base, maxPop: 370 }, BAND, RUNGS[2])).toBe(true);
    expect(meets({ ...base, bareQuarter: 0.04 }, BAND, RUNGS[0])).toBe(false);
    expect(meets({ ...base, bareQuarter: 0.04 }, BAND, RUNGS[1])).toBe(true);
  });

  it('searches on composition and fill, so the sweep cannot assert what the search ignores', () => {
    // a candidate that is otherwise perfect but half-loose, or a thin void
    expect(meets({ ...base, bondedMean: 0.52 }, BAND, RUNGS[0])).toBe(false);
    expect(meets({ ...base, bondedMean: 0.52 }, BAND, RUNGS[2])).toBe(true);
    expect(meets({ ...base, fillMean: 0.022 }, BAND, RUNGS[0])).toBe(false);
    expect(meets({ ...base, fillMean: 0.022 }, BAND, RUNGS[2])).toBe(true);
    // §13.3's formed-frame expectation is a RATIO: a long ripe window that is
    // mostly unformed no longer qualifies on its absolute count alone
    expect(meets({ ...base, formedFrames: 300, ripeFrames: 900 }, BAND, RUNGS[0])).toBe(false);
  });

  it('tries the STRICTEST bounds first inside a rung\'s budget', () => {
    // candidate 0 only meets rung 1; candidate 7 meets rung 0. The ladder must
    // reach candidate 7 (rung 0) rather than shipping candidate 0 relaxed.
    const runs: SoupRun[] = Array.from({ length: 28 }, (_, i) =>
      i === 0 ? { ...base, formedFrames: 100, ripeFrames: 140 }
        : i === 7 ? base
          : { ...base, eyes: false });
    const hit = walkLadder(BAND, 28, i => runs[i]);
    expect(hit.rung).toBe(0);
    expect(hit.cand).toBe(7);
  });

  it('falls to the next rung only when the budget is exhausted', () => {
    const runs: SoupRun[] = Array.from({ length: 28 }, () => ({ ...base, formedFrames: 100, ripeFrames: 140 }));
    const hit = walkLadder(BAND, 28, i => runs[i]);
    expect(hit.rung).toBe(1);
    expect(hit.cand).toBe(0);
  });

  it('reports rung -1 when nothing meets any rung, so the caller can rank', () => {
    const runs: SoupRun[] = Array.from({ length: 28 }, () => ({ ...base, empty: false }));
    expect(walkLadder(BAND, 28, i => runs[i]).rung).toBe(-1);
  });

  it('draws candidates from a deterministic hash chain off the date seed', () => {
    expect(subSeeds(20260724, 5)).toEqual(subSeeds(20260724, 5));
    expect(subSeeds(20260724, 5)).not.toEqual(subSeeds(20260725, 5));
    expect(subSeeds(20260724, 28).slice(0, 5)).toEqual(subSeeds(20260724, 5));
    expect(LADDER_MAX_TRIES).toBe(28);
  });

  it('always returns a pick, even with a budget of one candidate', () => {
    const pick = findSoup(20260724, buildReleaseSchedule(EVENTS, T), S, T, ACCENT_LIST, BAND, 1);
    expect(pick.frames).toHaveLength(S);
    expect(pick.candidate).toBe(0);
    expect(pick.sims).toBe(1);
  });
});

describe('assess', () => {
  it('measures peak over the formative part of the arc only', () => {
    const empty = { parts: [], clusters: [], crust: [] };
    const frames = Array.from({ length: S }, (_, i) => (i === S - 10
      ? { parts: [], clusters: [{ n: 200 } as never], crust: [] }
      : empty));
    // a body that only reaches size while being carried out of frame does not count
    expect(assess(frames as never, T).peak).toBe(0);
    expect(biggestCluster({ parts: [], clusters: [{ n: 12 }] as never, crust: [] })).toBe(12);
  });
});


describe('§13.3 lone-nub shedding conserves the lattice', () => {
  // The rule zeroed `q.sx/q.sy` BEFORE deleting the slot from the cluster's
  // occupancy set, so it deleted the nucleus key "0,0" instead of the slot being
  // vacated. That freed the ORIGIN for a second occupant while its first one was
  // still sitting there, and leaked the slot actually vacated.
  //
  // Both are invisible in aggregate metrics, so the test asserts the structural
  // invariant they break: within one cluster, live particles occupy DISTINCT
  // lattice slots. Reverting the two lines makes this go red.
  const arcFor = (seed: number) =>
    simulateSoup(mulberry32(seed), buildReleaseSchedule(EVENTS, T), S, ACCENT_LIST);

  it('never lets two live particles of one body share a slot', () => {
    let shedSeen = 0, checked = 0;
    for (const sub of subSeeds(20260315, 3)) {
      const frames = arcFor(sub);
      let prevBonded = new Map<number, number>();
      for (const st of frames) {
        const bySlot = new Map<string, number>();
        const bonded = new Map<number, number>();
        for (const p of st.parts) {
          if (p.cluster < 0) continue;
          bonded.set(p.cluster, (bonded.get(p.cluster) ?? 0) + 1);
          const key = `${p.cluster}:${p.sx},${p.sy}`;
          bySlot.set(key, (bySlot.get(key) ?? 0) + 1);
          checked++;
        }
        const dup = [...bySlot.entries()].filter(([, n]) => n > 1);
        expect(dup.map(([k, n]) => `${k} x${n}`)).toEqual([]);
        // a body losing a member while the arc is still running is a shed
        for (const [id, n] of prevBonded) {
          const now = bonded.get(id);
          if (now !== undefined && now < n) shedSeen++;
        }
        prevBonded = bonded;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // the rule under test actually fires on this seed, so the assertion above is
    // not passing merely because nothing was ever shed
    expect(shedSeen).toBeGreaterThan(0);
  });

  it('never re-uses the nucleus slot while its occupant is still there', () => {
    // The sharper statement of the same bug: the key the buggy delete removed was
    // always "0,0", so the ORIGIN specifically became re-allocatable. Assert it
    // directly, because a duplicate at the origin is the failure that reaches the
    // renderer as two particles springing to one point.
    let origins = 0;
    for (const sub of subSeeds(20260315, 3))
      for (const st of simulateSoup(mulberry32(sub), buildReleaseSchedule(EVENTS, T), S, ACCENT_LIST)) {
        const atOrigin = new Map<number, number>();
        for (const p of st.parts) {
          if (p.cluster < 0 || p.sx !== 0 || p.sy !== 0) continue;
          atOrigin.set(p.cluster, (atOrigin.get(p.cluster) ?? 0) + 1);
          origins++;
        }
        expect([...atOrigin.entries()].filter(([, n]) => n > 1)).toEqual([]);
      }
    // nuclei do keep an origin cell, so the scan has something to look at
    expect(origins).toBeGreaterThan(0);
  });
});

describe('§13.5 voidPopulation — one definition for the search and the sweep', () => {
  // The searched statistic and the gated statistic used to be three separate
  // loops (assess, checkInvariants, measureTraffic). They agreed, but nothing
  // made them agree; this is now the single definition all three call.
  const frame = (n: number, crust = 0) => ({
    parts: Array.from({ length: n }, () => ({
      x: VOID_X0, y: VOID_Y0, vx: 0, vy: 0, c: 0, streak: 0, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
    })),
    clusters: [],
    crust: Array.from({ length: crust }, () => ({ x: 230, y: 4, c: 0, born: 0, dwell: 100 })),
  });

  it('sums the four visible ages per LOOP frame and keeps both extremes', () => {
    const frames = Array.from({ length: S }, () => frame(1)) as never;
    expect(voidPopulation(frames, T)).toEqual({ min: 4, mean: 4, max: 4 });
  });

  it('counts crust in the standing population, and catches a single-frame dip', () => {
    const frames = Array.from({ length: S }, () => frame(1, 1));
    expect(voidPopulation(frames as never, T)).toEqual({ min: 8, mean: 8, max: 8 });
    // one empty age at t = 0 only: min drops, the mean barely moves — which is
    // exactly why §13.4 searches the per-frame extremes and not the mean.
    const dip = [frame(0, 0), ...frames.slice(1)];
    const p = voidPopulation(dip as never, T);
    expect(p.min).toBe(6);
    expect(p.max).toBe(8);
    expect(p.mean).toBeGreaterThan(7.9);
  });
});

describe('§13.3/§13.5 voidOccupancy', () => {
  const frameWith = (cells: [number, number][]) => ({
    parts: cells.map(([x, y]) => ({
      x, y, vx: 0, vy: 0, c: 0, streak: 0, cluster: -1, sx: 0, sy: 0, bond: 0, eye: 0,
    })),
    clusters: [], crust: [],
  });
  /** one arc-length run whose every visible age is the same frame */
  const arcOf = (cells: [number, number][]) =>
    Array.from({ length: S }, () => frameWith(cells)) as never;

  it('counts distinct occupied void cells, not particles', () => {
    // three particles, two distinct cells
    const occ = voidOccupancy(arcOf([[VOID_X0 + 1, VOID_Y0 + 1], [VOID_X0 + 1, VOID_Y0 + 1], [VOID_X0 + 2, VOID_Y0 + 1]]), T);
    expect(occ.fill[0]).toBeCloseTo(2 / ((VOID_X1 - VOID_X0 + 1) * (VOID_Y1 - VOID_Y0 + 1)), 10);
  });

  it('reports a quarter bare when it holds fewer than BARE_QUARTER_CELLS cells', () => {
    const W = VOID_X1 - VOID_X0 + 1;
    // fill every quarter generously => nothing bare
    const full: [number, number][] = [];
    for (let q = 0; q < VOID_QUARTERS; q++)
      for (let k = 0; k < BARE_QUARTER_CELLS + 1; k++)
        full.push([VOID_X0 + Math.floor((q + 0.5) * W / VOID_QUARTERS), VOID_Y0 + k]);
    expect(voidOccupancy(arcOf(full), T).bareQuarter).toBe(0);

    // strip the far quarter => it is bare in every frame
    const lopsided = full.filter(([x]) => (x - VOID_X0) / W < 0.75);
    expect(voidOccupancy(arcOf(lopsided), T).bareQuarter).toBe(1);
  });

  it('is the metric §13.3 needs: a big body on one side does not make the void wide', () => {
    // 60 particles packed into the far quarter, nothing anywhere else. A
    // particle-share metric would call this "60/60 in the far quarter"; the void
    // still reads as three empty quarters, and bareQuarter says so.
    const W = VOID_X1 - VOID_X0 + 1;
    const blob: [number, number][] = [];
    for (let i = 0; i < 60; i++)
      blob.push([VOID_X1 - 5 + (i % 5), VOID_Y0 + Math.floor(i / 5)]);
    expect(blob.every(([x]) => (x - VOID_X0) / W >= 0.75)).toBe(true);
    expect(voidOccupancy(arcOf(blob), T).bareQuarter).toBe(1);
  });
});
