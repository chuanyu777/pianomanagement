type TimedLesson = { id: string; startsAt: string; endsAt: string };
export const SCHEDULE_START_MINUTE = 7 * 60;
export const SCHEDULE_END_MINUTE = 22 * 60;
export type SchedulePlacement<T> = { lesson: T; startMinute: number; endMinute: number; column: number; columns: number; outside: boolean };

export function layoutScheduleDay<T extends TimedLesson>(lessons: readonly T[], day: string): SchedulePlacement<T>[] {
  const midnight = Date.parse(`${day}T00:00:00+08:00`);
  const clamp = (minute: number) => Math.max(SCHEDULE_START_MINUTE, Math.min(SCHEDULE_END_MINUTE, minute));
  const entries = lessons.flatMap((lesson) => {
    const start = (Date.parse(lesson.startsAt) - midnight) / 60_000;
    const end = (Date.parse(lesson.endsAt) - midnight) / 60_000;
    // Intersect the business day rather than grouping by UTC date or start date:
    // an overnight lesson belongs to both days it actually occupies.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= 1440 || end <= 0) return [];
    return [{ lesson, startMinute: clamp(start), endMinute: clamp(end), column: 0, columns: 1, outside: end <= SCHEDULE_START_MINUTE || start >= SCHEDULE_END_MINUTE }];
  }).sort((a, b) => Date.parse(a.lesson.startsAt) - Date.parse(b.lesson.startsAt) || a.lesson.id.localeCompare(b.lesson.id));
  const visible = entries.filter((entry) => !entry.outside);
  let group: typeof visible = [];
  let groupEnd = -Infinity;
  const finish = () => {
    const ends: number[] = [];
    for (const entry of group) {
      let column = ends.findIndex((end) => end <= entry.startMinute);
      if (column < 0) column = ends.length;
      entry.column = column;
      ends[column] = entry.endMinute;
    }
    for (const entry of group) entry.columns = ends.length;
  };
  for (const entry of visible) {
    if (entry.startMinute >= groupEnd) { finish(); group = []; groupEnd = -Infinity; }
    group.push(entry);
    groupEnd = Math.max(groupEnd, entry.endMinute);
  }
  finish();
  return entries;
}
