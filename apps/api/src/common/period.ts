/**
 * 月份工具。全系统的「按月」一律用 `YYYY-MM` 字符串表示（Period），
 * 禁止各模块自己拼日期字符串。
 *
 * 关键约定：**业务月份按琴行所在地时区（UTC+8）划分，不按服务器时区。**
 * 库里存的是 UTC 时间，如果直接用 JS 的本地时间取月份，
 * 服务器换个时区（或部署到 UTC 的容器）就会把一笔 8 月 31 日 23:30 的交费
 * 算进 7 月或 9 月，而且**不会报错**。所以这里显式偏移。
 */

export type Period = string;

/** 琴行经营所在地固定偏移。中国不实行夏令时，用固定偏移即可。 */
export const BUSINESS_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function toPeriod(date: Date): Period {
  const shifted = new Date(date.getTime() + BUSINESS_TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function isValidPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

export function parsePeriod(period: Period): { year: number; month: number } {
  const matched = PERIOD_PATTERN.exec(period);
  if (!matched) {
    throw new Error(`非法月份 "${period}"，应形如 2026-10`);
  }
  return { year: Number(matched[1]), month: Number(matched[2]) };
}

export function currentPeriod(now: Date = new Date()): Period {
  return toPeriod(now);
}

/** 上一个月。跨年正确（2026-01 → 2025-12）。 */
export function prevPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function nextPeriod(period: Period): Period {
  const { year, month } = parsePeriod(period);
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * 该月的起止时刻（半开区间 [start, end)），按 UTC+8 划分后换算回 UTC。
 * 数据库查询一律用它，不要自己 new Date(year, month, 1)。
 */
export function periodRange(period: Period): { start: Date; end: Date } {
  const { year, month } = parsePeriod(period);
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BUSINESS_TZ_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BUSINESS_TZ_OFFSET_MS),
  };
}

/** 同一年内、从 1 月到该月的所有月份。年度累计（YTD）用它。 */
export function periodsOfYearTo(period: Period): Period[] {
  const { year, month } = parsePeriod(period);
  return Array.from(
    { length: month },
    (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
  );
}

/** 以 end 结尾、往前数 count 个月的月份列表（含 end）。趋势图用它。 */
export function lastPeriods(end: Period, count: number): Period[] {
  const out: Period[] = [];
  let cursor = end;
  for (let i = 0; i < count; i += 1) {
    out.unshift(cursor);
    cursor = prevPeriod(cursor);
  }
  return out;
}
