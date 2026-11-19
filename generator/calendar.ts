// From GitHub's contribution calendar to the generator's two daily inputs: the
// seed (the last ACTIVE day, which is also the REV date) and the 14 activity
// levels ending on that day.
//
// Why the calendar and not the public events feed: the feed holds only public
// events (a handful per month here), while the calendar counts private work too,
// as bare numbers, exactly as the profile page already shows them.
//
// Why the window ends on the last active day and not on "today": a quiet day
// then resolves to the same seed and the same levels as the day before, so the
// render is byte-identical and the workflow's commit step skips, as it always
// has. The board evolves only on days there was something to show.

export interface CalendarDay { date: string; contributionCount: number; contributionLevel: string }
export interface Resolved { seed: number; levels: number[] }

export const WINDOW = 14;

const LEVEL: Record<string, number> = {
  NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4,
};

/** The level a day shows: GitHub's own quartile, but never 0 for a day that has
 * contributions, and 1 for a quartile name this code has not seen. */
function levelOf(d: CalendarDay): number {
  if (d.contributionCount === 0) return 0;
  return Math.max(1, LEVEL[d.contributionLevel] ?? 1);
}

export function activityFromCalendar(days: readonly CalendarDay[]): Resolved | null {
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error(`calendar: bad date ${JSON.stringify(d.date)}`);
    if (!Number.isInteger(d.contributionCount) || d.contributionCount < 0)
      throw new Error(`calendar: bad count ${JSON.stringify(d.contributionCount)} on ${d.date}`);
  }
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let last = -1;
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].contributionCount > 0) { last = i; break; }
  if (last < 0) return null;
  const levels: number[] = [];
  for (let i = last - WINDOW + 1; i <= last; i++) levels.push(i < 0 ? 0 : levelOf(sorted[i]));
  return { seed: Number(sorted[last].date.replaceAll('-', '')), levels };
}

/** Flatten a GraphQL `contributionCalendar` response; throw on anything else. */
export function daysFromGraphql(body: unknown): CalendarDay[] {
  const weeks = (body as { data?: { user?: { contributionsCollection?: { contributionCalendar?: { weeks?: unknown } } } | null } })
    ?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) throw new Error('calendar: response has no contributionCalendar.weeks');
  const out: CalendarDay[] = [];
  for (const w of weeks) {
    const ds = (w as { contributionDays?: unknown }).contributionDays;
    if (!Array.isArray(ds)) throw new Error('calendar: a week has no contributionDays');
    for (const d of ds) out.push(d as CalendarDay);
  }
  return out;
}
