// activity.ts — the owner's GitHub activity as a PURE input to the banner's pace.
//
// The daily job passes the last 14 days of his contribution-calendar LEVELS (GitHub's 0-4 scale,
// oldest first, the last being the seed date). Only the last week sets the pace: it picks how often
// soma 1 fires on its own (`SPONTANEOUS_FIRINGS`, which starts cascades) and how fast the CPU's
// lub-dub beats (`HEARTBEAT_PERIOD`). Nothing else in the world reads it, so the board, the flows,
// the escapes and the soup are identical for every activity.
//
// Every pace's period divides 288 (T), so each pace still closes the loop.

export const ACTIVITY_DAYS = 14;
/** the last this-many levels set the pace */
const PACE_DAYS = 7;
const MAX_LEVEL = 4;

export interface Activity {
  /** ACTIVITY_DAYS integers, 0..4, oldest first; the last is the seed date (the last active day) */
  levels: number[];
}

/** A neutral "steady" week: fourteen 1s (sum of the last 7 = 7), so default output keeps today's pace. */
export const DEFAULT_ACTIVITY: Activity = Object.freeze({
  levels: Object.freeze(Array.from({ length: ACTIVITY_DAYS }, () => 1)) as unknown as number[],
}) as Activity;

/** Throws unless `a` is ACTIVITY_DAYS integers in 0..4. Returns `a` so a caller can validate inline. */
export function assertActivity(a: unknown): Activity {
  const levels = (a as Activity | null | undefined)?.levels;
  if (!Array.isArray(levels)) throw new Error('activity: expected an object with a `levels` array');
  if (levels.length !== ACTIVITY_DAYS) {
    throw new Error(`activity: expected ${ACTIVITY_DAYS} levels, got ${levels.length}`);
  }
  levels.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`activity: level ${i + 1} is not an integer (got ${JSON.stringify(v)})`);
    }
    if (v < 0 || v > MAX_LEVEL) {
      throw new Error(`activity: level ${i + 1} is ${v}, outside 0..${MAX_LEVEL}`);
    }
  });
  return a as Activity;
}

/**
 * "l1,l2,...,l14" -> Activity. Strict: exactly ACTIVITY_DAYS comma-separated integers 0..4, each a
 * bare digit run. Spaces are NOT trimmed (" 3" is rejected, and the message says so), and an empty
 * item (a trailing or doubled comma, or an empty string) is an error.
 */
export function parseActivity(text: string): Activity {
  if (typeof text !== 'string') throw new Error('activity: expected a string like "0,1,2,...,4"');
  const items = text.split(',');
  if (items.length !== ACTIVITY_DAYS) {
    throw new Error(`activity: expected ${ACTIVITY_DAYS} comma-separated levels, got ${text === '' ? 0 : items.length}`);
  }
  const levels = items.map((s, i) => {
    if (s === '') throw new Error(`activity: level ${i + 1} is empty (a doubled or trailing comma?)`);
    if (!/^\d+$/.test(s)) {
      throw new Error(`activity: level ${i + 1} is ${JSON.stringify(s)}, not a whole number 0..${MAX_LEVEL} `
        + '(spaces are not trimmed)');
    }
    return Number(s);
  });
  return assertActivity({ levels });
}

export type Pace = 'calm' | 'steady' | 'busy';

/** By the sum of the LAST 7 levels: <= 6 calm, 7..13 steady, >= 14 busy. */
export function paceOf(a: Activity): Pace {
  const sum = a.levels.slice(-PACE_DAYS).reduce((s, v) => s + v, 0);
  return sum <= 6 ? 'calm' : sum >= 14 ? 'busy' : 'steady';
}

/** The CPU heartbeat's period in frames. All divide 288. */
export const HEARTBEAT_PERIOD: Record<Pace, number> = { calm: 36, steady: 24, busy: 18 };
/** How many times per loop soma 1 is asked to fire on its own (a target the tissue honours where it can). */
export const SPONTANEOUS_FIRINGS: Record<Pace, number> = { calm: 1, steady: 2, busy: 3 };
