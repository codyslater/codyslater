import { describe, expect, it } from 'vitest';
import { activityFromCalendar, daysFromGraphql } from './calendar.js';

const day = (date: string, contributionCount: number, contributionLevel: string) => ({ date, contributionCount, contributionLevel });
/** N consecutive days ending 2026-11-19, with the given [count, level] pairs for the tail. */
function tail(pairs: [number, string][], total = 30): ReturnType<typeof day>[] {
  const end = Date.UTC(2026, 10, 19);
  const out: ReturnType<typeof day>[] = [];
  for (let i = total - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400000).toISOString().slice(0, 10);
    const p = pairs[pairs.length - 1 - i] ?? [0, 'NONE'];
    out.push(day(d, p[0], p[1]));
  }
  return out;
}

describe('activityFromCalendar', () => {
  it('takes the 14 days ending at the last day with any contribution', () => {
    const days = tail([[3, 'FIRST_QUARTILE'], [0, 'NONE'], [210, 'FOURTH_QUARTILE'], [85, 'SECOND_QUARTILE']]);
    const r = activityFromCalendar(days)!;
    expect(r.seed).toBe(20261119);
    expect(r.levels).toHaveLength(14);
    expect(r.levels.slice(-4)).toEqual([1, 0, 4, 2]);
    expect(r.levels.slice(0, 10)).toEqual(Array(10).fill(0));
  });

  it('a quiet today does not move the seed: the window ends on the last ACTIVE day', () => {
    const days = tail([[5, 'THIRD_QUARTILE'], [0, 'NONE'], [0, 'NONE']]);
    const r = activityFromCalendar(days)!;
    expect(r.seed).toBe(20261117);
    expect(r.levels[13]).toBe(3);
    // and it is the same answer the day before and the day after, so a quiet day re-renders byte-identically
    expect(activityFromCalendar(days.slice(0, -1))).toEqual(r);
  });

  it('pads the front with zeros when fewer than 14 days precede the last active day', () => {
    const r = activityFromCalendar([day('2026-01-01', 2, 'FIRST_QUARTILE'), day('2026-01-02', 9, 'FOURTH_QUARTILE')])!;
    expect(r.seed).toBe(20260102);
    expect(r.levels).toEqual([...Array(12).fill(0), 1, 4]);
  });

  it('is order-independent: days are sorted by date first', () => {
    const days = tail([[1, 'FIRST_QUARTILE'], [7, 'THIRD_QUARTILE']]);
    expect(activityFromCalendar([...days].reverse())).toEqual(activityFromCalendar(days));
  });

  it('returns null when nothing in the calendar is active, so the caller falls back', () => {
    expect(activityFromCalendar(tail([]))).toBeNull();
    expect(activityFromCalendar([])).toBeNull();
  });

  it('a count with level NONE still counts as active, and an unknown level reads as 1', () => {
    const r = activityFromCalendar(tail([[2, 'NONE'], [4, 'SOMETHING_NEW']]))!;
    expect(r.levels.slice(-2)).toEqual([1, 1]);
  });

  it('rejects a malformed day rather than guessing', () => {
    expect(() => activityFromCalendar([{ date: '19/11/2026', contributionCount: 1, contributionLevel: 'NONE' }])).toThrow(/date/);
    expect(() => activityFromCalendar([{ date: '2026-11-19', contributionCount: -1, contributionLevel: 'NONE' }])).toThrow(/count/);
  });
});

describe('daysFromGraphql', () => {
  it('flattens the contributionCalendar response', () => {
    const body = { data: { user: { contributionsCollection: { contributionCalendar: { weeks: [
      { contributionDays: [day('2026-11-18', 210, 'FOURTH_QUARTILE')] },
      { contributionDays: [day('2026-11-19', 85, 'SECOND_QUARTILE')] },
    ] } } } } };
    expect(daysFromGraphql(body).map(d => d.date)).toEqual(['2026-11-18', '2026-11-19']);
  });

  it('throws on an error body or a missing user, so the workflow falls back', () => {
    expect(() => daysFromGraphql({ errors: [{ message: 'bad credentials' }] })).toThrow();
    expect(() => daysFromGraphql({ data: { user: null } })).toThrow();
    expect(() => daysFromGraphql('<html>')).toThrow();
  });
});
