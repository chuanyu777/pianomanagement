import { describe, expect, it } from 'vitest';
import { resolveLessonDateRange } from '../src/graph/dialogue-calendar.js';

describe('课表业务日期解析', () => {
  const businessDate = '2026-10-21';

  it.each([
    ['今天有哪些排课', { dateFrom: '2026-10-21', dateTo: '2026-10-21' }],
    ['查看昨天排课', { dateFrom: '2026-10-20', dateTo: '2026-10-20' }],
    ['明天有哪些课', { dateFrom: '2026-10-22', dateTo: '2026-10-22' }],
    ['后天排课', { dateFrom: '2026-10-23', dateTo: '2026-10-23' }],
    ['查看2026-10-24的排课', { dateFrom: '2026-10-24', dateTo: '2026-10-24' }],
    ['查10月20日到22日的排课', { dateFrom: '2026-10-20', dateTo: '2026-10-22' }],
    ['本月排课', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
    ['上月排课', { dateFrom: '2026-09-01', dateTo: '2026-09-30' }],
    ['下月排课', { dateFrom: '2026-11-01', dateTo: '2026-11-30' }],
  ])('把“%s”解析成确定的业务日期范围', (message, expected) => {
    expect(resolveLessonDateRange(message, businessDate)).toEqual({ kind: 'resolved', ...expected });
  });

  it('跨年和闰年按业务日历推进', () => {
    expect(resolveLessonDateRange('明天排课', '2026-12-31')).toEqual({ kind: 'resolved', dateFrom: '2027-01-01', dateTo: '2027-01-01' });
    expect(resolveLessonDateRange('明天排课', '2028-02-28')).toEqual({ kind: 'resolved', dateFrom: '2028-02-29', dateTo: '2028-02-29' });
  });

  it('范围含糊时返回需要澄清，不自行猜天数', () => {
    expect(resolveLessonDateRange('查最近几天的课', businessDate)).toEqual({ kind: 'ambiguous', question: '请说明具体的开始日期和结束日期。' });
  });

  it('没有日期表达时不覆盖已有任务范围', () => {
    expect(resolveLessonDateRange('只看王老师的', businessDate)).toEqual({ kind: 'absent' });
  });
});
