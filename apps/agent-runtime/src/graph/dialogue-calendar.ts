export type LessonDateResolution =
  | { kind: 'resolved'; dateFrom: string; dateTo: string }
  | { kind: 'ambiguous'; question: string }
  | { kind: 'absent' };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function parseDate(value: string): Date {
  const match = DATE.exec(value);
  if (!match) throw new Error('BUSINESS_DATE_INVALID');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (formatDate(date) !== value) throw new Error('BUSINESS_DATE_INVALID');
  return date;
}

function formatDate(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function addDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function monthRange(year: number, monthIndex: number): { dateFrom: string; dateTo: string } {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { dateFrom: formatDate(first), dateTo: formatDate(last) };
}

function validDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? formatDate(date)
    : undefined;
}

/**
 * Resolves only deterministic business-calendar expressions. It deliberately
 * returns `absent` for non-date text so an existing task range is preserved,
 * and `ambiguous` for phrases whose product meaning is not frozen.
 */
export function resolveLessonDateRange(message: string, businessDate: string): LessonDateResolution {
  const base = parseDate(businessDate);
  const text = message.trim();
  if (/最近(?:的)?几天/u.test(text)) {
    return { kind: 'ambiguous', question: '请说明具体的开始日期和结束日期。' };
  }

  const fullRange = /(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:到|至|—|~)\s*(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(text);
  if (fullRange) {
    const dateFrom = validDate(Number(fullRange[1]), Number(fullRange[2]), Number(fullRange[3]));
    const dateTo = validDate(Number(fullRange[4]), Number(fullRange[5]), Number(fullRange[6]));
    if (dateFrom && dateTo && dateFrom <= dateTo) return { kind: 'resolved', dateFrom, dateTo };
    return { kind: 'ambiguous', question: '请提供有效的开始日期和结束日期。' };
  }

  const shortRange = /(\d{1,2})月(\d{1,2})日?\s*(?:到|至|—|~)\s*(?:(\d{1,2})月)?(\d{1,2})日/u.exec(text);
  if (shortRange) {
    const year = base.getUTCFullYear();
    const dateFrom = validDate(year, Number(shortRange[1]), Number(shortRange[2]));
    const dateTo = validDate(year, Number(shortRange[3] ?? shortRange[1]), Number(shortRange[4]));
    if (dateFrom && dateTo && dateFrom <= dateTo) return { kind: 'resolved', dateFrom, dateTo };
    return { kind: 'ambiguous', question: '请提供有效的开始日期和结束日期。' };
  }

  const absolute = /(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(text);
  if (absolute) {
    const date = validDate(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]));
    return date
      ? { kind: 'resolved', dateFrom: date, dateTo: date }
      : { kind: 'ambiguous', question: '请提供有效的查询日期。' };
  }

  if (/本月/u.test(text)) return { kind: 'resolved', ...monthRange(base.getUTCFullYear(), base.getUTCMonth()) };
  if (/上月/u.test(text)) return { kind: 'resolved', ...monthRange(base.getUTCFullYear(), base.getUTCMonth() - 1) };
  if (/下月/u.test(text)) return { kind: 'resolved', ...monthRange(base.getUTCFullYear(), base.getUTCMonth() + 1) };

  const relative = /前天/u.test(text) ? -2
    : /昨天/u.test(text) ? -1
      : /后天/u.test(text) ? 2
        : /明天/u.test(text) ? 1
          : /今天|今日/u.test(text) ? 0
            : undefined;
  if (relative !== undefined) {
    const date = formatDate(addDays(base, relative));
    return { kind: 'resolved', dateFrom: date, dateTo: date };
  }
  return { kind: 'absent' };
}
