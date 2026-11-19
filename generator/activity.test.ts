import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_DAYS, DEFAULT_ACTIVITY, HEARTBEAT_PERIOD, SPONTANEOUS_FIRINGS,
  paceOf, parseActivity, type Activity, type Pace,
} from './activity.js';
import { idleCellsAt } from './idle.js';
import { tissueCellsAt } from './tissue.js';
import { buildWorld } from './timeline.js';
import type { World } from './types.js';

const T = 288;
const SEED = 20260724;
const act = (...levels: number[]): Activity => ({ levels });
/** fourteen levels whose LAST seven sum to `sum` (the first seven are `head`) */
const withTail = (head: number, tail: number[]): Activity => act(...Array(7).fill(head), ...tail);

describe('parseActivity', () => {
  it('round-trips fourteen levels, oldest first', () => {
    const a = parseActivity('0,1,2,3,4,0,1,2,3,4,0,1,2,3');
    expect(a.levels).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3]);
    expect(a.levels).toHaveLength(ACTIVITY_DAYS);
    expect(parseActivity(a.levels.join(','))).toEqual(a);
    expect(parseActivity('1,1,1,1,1,1,1,1,1,1,1,1,1,1')).toEqual(DEFAULT_ACTIVITY);
  });

  const good = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3];
  const with_ = (i: number, v: string): string => good.map((n, k) => (k === i ? v : String(n))).join(',');
  const bad: [string, string][] = [
    ['13 items', good.slice(1).join(',')],
    ['15 items', [...good, 1].join(',')],
    ['a non-number', with_(2, 'x')],
    ['5 (above the scale)', with_(5, '5')],
    ['a negative', with_(0, '-1')],
    ['a decimal', with_(7, '1.5')],
    ['an empty string', ''],
    ['a trailing comma', `${good.join(',')},`],
    ['a doubled comma', with_(4, '')],
    ['a space (not trimmed)', with_(3, ' 2')],
  ];
  it.each(bad)('rejects %s with a message', (_label, text) => {
    expect(() => parseActivity(text)).toThrow(/activity:/);
  });

  it('names what was wrong', () => {
    expect(() => parseActivity(good.slice(1).join(','))).toThrow(/expected 14.*got 13/);
    expect(() => parseActivity(with_(5, '5'))).toThrow(/level 6 is 5, outside 0\.\.4/);
    expect(() => parseActivity(with_(2, 'x'))).toThrow(/level 3/);
    expect(() => parseActivity(with_(3, ' 2'))).toThrow(/spaces are not trimmed/);
  });
});

describe('paceOf', () => {
  it('splits the last seven levels at 6 / 7 and 13 / 14', () => {
    expect(paceOf(withTail(1, [1, 1, 1, 1, 1, 1]))).toBe('steady');   // 7
    expect(paceOf(withTail(1, [1, 1, 1, 1, 1, 0]))).toBe('calm');     // 6
    expect(paceOf(withTail(1, [0, 0, 0, 0, 0, 0, 0]))).toBe('calm');  // 0
    expect(paceOf(withTail(1, [2, 2, 2, 2, 2, 2, 1]))).toBe('steady');  // 13
    expect(paceOf(withTail(1, [2, 2, 2, 2, 2, 2, 2]))).toBe('busy');    // 14
    expect(paceOf(withTail(1, [4, 4, 4, 4, 4, 4, 4]))).toBe('busy');    // 28
  });

  it('counts only the last seven days', () => {
    const quiet = [0, 0, 0, 0, 0, 0, 0];
    const loud = [4, 4, 4, 4, 4, 4, 4];
    expect(paceOf(act(...loud, ...quiet))).toBe('calm');
    expect(paceOf(act(...quiet, ...loud))).toBe('busy');
    // moving one level from the sixth-last day (outside) to the last (inside) changes the sum
    expect(paceOf(act(...Array(7).fill(0), 4, 0, 0, 0, 0, 0, 2))).toBe('calm');
  });

  it('DEFAULT_ACTIVITY is steady, and every pace has a period that divides T', () => {
    expect(DEFAULT_ACTIVITY.levels).toHaveLength(ACTIVITY_DAYS);
    expect(DEFAULT_ACTIVITY.levels.every(v => v === 1)).toBe(true);
    expect(paceOf(DEFAULT_ACTIVITY)).toBe('steady');
    for (const p of ['calm', 'steady', 'busy'] as Pace[]) expect(T % HEARTBEAT_PERIOD[p]).toBe(0);
    expect(HEARTBEAT_PERIOD).toEqual({ calm: 36, steady: 24, busy: 18 });
    expect(SPONTANEOUS_FIRINGS).toEqual({ calm: 1, steady: 2, busy: 3 });
  });
});

// ---------------------------------------------------------------------------
// The world. Two builds: the default (no argument) and a busy one.
// ---------------------------------------------------------------------------

const BUSY: Activity = act(...Array(14).fill(3));
let base: World | null = null, busy: World | null = null;
const baseWorld = (): World => (base ??= buildWorld(SEED, T));
const busyWorld = (): World => (busy ??= buildWorld(SEED, T, BUSY));

/** everything the pace is allowed to change, and what it must not */
const sha = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const paced = (w: World): unknown => {
  const { beatPeriod, ...idle } = w.idle;
  void beatPeriod;
  const frames: unknown[] = [];
  for (let t = 0; t < T; t += 7) frames.push(tissueCellsAt(w.tissue, t), idleCellsAt(w.idle, t, T));
  return { tissue: w.tissue, idle, frames, answers: w.answers, wake: w.wake };
};
const unpaced = (w: World): unknown => ({
  seed: w.seed, T: w.T, accents: w.accents, components: w.components, sections: w.sections,
  dressing: w.dressing, mountHoles: w.mountHoles, nets: w.nets, fabric: w.fabric,
  graph: w.graph, flows: w.flows, events: w.events, takeovers: [...w.takeovers.entries()],
  candidate: w.soup.candidate, subSeed: w.soup.subSeed, rung: w.soup.rung, arc: w.arc,
});

describe('buildWorld(seed, T, activity)', () => {
  it('the default argument is DEFAULT_ACTIVITY and the world stores it', () => {
    expect(baseWorld().activity).toEqual(DEFAULT_ACTIVITY);
    expect(baseWorld().idle.beatPeriod).toBe(24);
    expect(baseWorld().tissue.spontaneous.length).toBeGreaterThanOrEqual(2);
  });

  it('default output is pinned (golden digest of tissue, idle, answers, wake)', () => {
    // GOLDEN_UNPACED was computed on the commit BEFORE activity existed and has never moved: the
    // default fortnight changes nothing the pace does not read. GOLDEN_PACED (tissue + idle, with
    // `beatPeriod` left out) started the same way and was re-pinned once, on purpose, when the idle
    // layer itself changed (2026-11-19: five LEDs, and the repressilator's three 2x2 lights), and
    // once more the same day when the breathing tips' length got its deterministic rounding nudge.
    const got = sha(paced(baseWorld()));
    expect(got).toBe(GOLDEN_PACED);
    expect(sha(unpaced(baseWorld()))).toBe(GOLDEN_UNPACED);
  });

  it('an explicit DEFAULT_ACTIVITY is the same as no argument, on the builders that read the pace', async () => {
    const w = baseWorld();
    const { buildTissue } = await import('./tissue.js');
    const { buildIdle } = await import('./idle.js');
    expect(buildTissue(SEED, w.events, w.accents, T, SPONTANEOUS_FIRINGS.steady)).toEqual(w.tissue);
    expect(buildIdle(w, w.tissue.recordings, HEARTBEAT_PERIOD.steady)).toEqual(w.idle);
  });

  it('a busy week changes the spontaneous firings and the heartbeat, and nothing else', () => {
    const a = baseWorld(), b = busyWorld();
    expect(b.activity).toEqual(BUSY);
    expect(paceOf(b.activity)).toBe('busy');
    expect(b.idle.beatPeriod).toBe(HEARTBEAT_PERIOD.busy);
    expect(b.tissue.spontaneous).not.toEqual(a.tissue.spontaneous);
    expect(b.tissue.spontaneous.length).toBeGreaterThan(a.tissue.spontaneous.length);
    expect(b.idle.periods[0]).toBe(HEARTBEAT_PERIOD.busy);
    // the pace-independent world: components, nets, flows, events, the soup's candidate ...
    expect(b.components).toEqual(a.components);
    expect(b.nets).toEqual(a.nets);
    expect(b.flows).toEqual(a.flows);
    expect(b.events).toEqual(a.events);
    expect(b.soup.candidate).toBe(a.soup.candidate);
    expect(sha(unpaced(b))).toBe(sha(unpaced(a)));
  });

  it('refuses a malformed activity', () => {
    expect(() => buildWorld(SEED, T, act(1, 1, 1))).toThrow(/activity:/);
    expect(() => buildWorld(SEED, T, act(...Array(13).fill(1), 5))).toThrow(/activity:/);
    expect(() => buildWorld(SEED, T, act(...Array(13).fill(1), 1.5))).toThrow(/activity:/);
    expect(() => buildWorld(SEED, T, {} as Activity)).toThrow(/activity:/);
  });
});

const GOLDEN_PACED = '9881e12ebdef9a74844162b459b6783e16079f436c96fa9ed0301e1d77d44ec7';
const GOLDEN_UNPACED = 'cf1e8c2e5e895768b41e5fdc0bde8b66fd6d5d0741df1e6c978858e78b79cee6';
