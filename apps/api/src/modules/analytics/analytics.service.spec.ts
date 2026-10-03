import { LessonStatus, Prisma } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { periodRange } from '../../common/period.js';

// 业绩口径来自 payroll 的权威实现（computePayrollSheet），本模块只消费。
// mock 掉它，才能精确控制每位老师的业绩与当月确认课时数。
vi.mock('../payroll/payroll-totals.js', () => ({
  computePayrollSheet: vi.fn(),
}));

import {
  computePayrollSheet,
  type PayrollComputation,
} from '../payroll/payroll-totals.js';
import { AnalyticsService } from './analytics.service.js';

const computePayrollSheetMock = vi.mocked(computePayrollSheet);

const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function payrollRow(over: Partial<PayrollComputation> = {}): PayrollComputation {
  return {
    teacherId: 't1',
    teacherName: '张老师',
    teacherStatus: 'ACTIVE',
    attendanceExpected: 0,
    attendanceActual: 0,
    attendanceAbsent: 0,
    baseSalary: dec(0),
    pianoBonus: dec(0),
    recruitBonus: dec(0),
    performance: dec(0),
    commissionRate: dec(0),
    commission: dec(0),
    grossSalary: dec(0),
    deductions: [],
    totalDeduction: dec(0),
    netSalary: dec(0),
    confirmedLessonCount: 0,
    ...over,
  };
}

function createPrismaMock() {
  return {
    lesson: { groupBy: vi.fn() },
    student: { findMany: vi.fn() },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('AnalyticsService', () => {
  let prisma: PrismaMock;
  let service: AnalyticsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    computePayrollSheetMock.mockReset();
    computePayrollSheetMock.mockResolvedValue([]);
    service = new AnalyticsService(prisma as unknown as PrismaService);
  });

  describe('AN-01 教师业绩排行', () => {
    it('按业绩降序，业绩为 0 的老师仍然返回（rank 从 1 连续编号）', async () => {
      computePayrollSheetMock.mockResolvedValue([
        payrollRow({ teacherId: 't1', teacherName: '张老师', performance: dec('3000'), confirmedLessonCount: 10 }),
        payrollRow({ teacherId: 't2', teacherName: '李老师', performance: dec('5000'), confirmedLessonCount: 20 }),
        payrollRow({ teacherId: 't3', teacherName: '王老师', performance: dec(0), confirmedLessonCount: 0 }),
      ]);

      const rows = await service.teacherRanking('2026-10');

      expect(computePayrollSheetMock).toHaveBeenCalledWith(prisma, '2026-10');
      expect(rows).toEqual([
        { rank: 1, teacherId: 't2', teacherName: '李老师', performance: '5000.00', lessonCount: 20 },
        { rank: 2, teacherId: 't1', teacherName: '张老师', performance: '3000.00', lessonCount: 10 },
        { rank: 3, teacherId: 't3', teacherName: '王老师', performance: '0.00', lessonCount: 0 },
      ]);
    });

    it('业绩相同按姓名稳定排序（前端不生成序号，名次由服务端给）', async () => {
      computePayrollSheetMock.mockResolvedValue([
        payrollRow({ teacherId: 'tb', teacherName: 'Bob', performance: dec('100') }),
        payrollRow({ teacherId: 'ta', teacherName: 'Alice', performance: dec('100') }),
      ]);

      const rows = await service.teacherRanking('2026-10');

      // 业绩相同时按姓名升序：Bob 在输入里在前，输出里应排到 Alice 之后
      expect(rows.map((row) => row.teacherName)).toEqual(['Alice', 'Bob']);
      expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    });
  });

  describe('AN-02 教师业绩趋势', () => {
    it('逐月返回每位老师的业绩点，缺失月份补 0', async () => {
      const byPeriod: Record<string, PayrollComputation[]> = {
        '2026-01': [payrollRow({ teacherId: 't1', teacherName: 'Alice', performance: dec('100') })],
        '2026-02': [payrollRow({ teacherId: 't2', teacherName: 'Bob', performance: dec('200') })],
        '2026-03': [
          payrollRow({ teacherId: 't1', teacherName: 'Alice', performance: dec('300') }),
          payrollRow({ teacherId: 't2', teacherName: 'Bob', performance: dec('0') }),
        ],
      };
      computePayrollSheetMock.mockImplementation((_client, period: string) =>
        Promise.resolve(byPeriod[period] ?? []),
      );

      const series = await service.teacherTrend('2026-03', 3);

      expect(computePayrollSheetMock.mock.calls.map((call) => call[1])).toEqual([
        '2026-01',
        '2026-02',
        '2026-03',
      ]);
      expect(series).toEqual([
        {
          teacherId: 't1',
          teacherName: 'Alice',
          points: [
            { period: '2026-01', performance: '100.00' },
            { period: '2026-02', performance: '0.00' },
            { period: '2026-03', performance: '300.00' },
          ],
        },
        {
          teacherId: 't2',
          teacherName: 'Bob',
          points: [
            { period: '2026-01', performance: '0.00' },
            { period: '2026-02', performance: '200.00' },
            { period: '2026-03', performance: '0.00' },
          ],
        },
      ]);
    });
  });

  describe('AN-03 学生消费排行', () => {
    it('按已确认且非赠送课的单价快照汇总，降序、消费为 0 不返回', async () => {
      prisma.lesson.groupBy.mockResolvedValue([
        { studentId: 's1', _sum: { unitPriceSnapshot: dec('1200') }, _count: { _all: 4 } },
        { studentId: 's2', _sum: { unitPriceSnapshot: dec('3600') }, _count: { _all: 12 } },
        { studentId: 's3', _sum: { unitPriceSnapshot: dec(0) }, _count: { _all: 2 } },
      ]);
      prisma.student.findMany.mockResolvedValue([
        { id: 's1', name: '小明' },
        { id: 's2', name: '小红' },
        { id: 's3', name: '小刚' },
      ]);

      const rows = await service.studentRanking('2026-10');

      const { start, end } = periodRange('2026-10');
      expect(prisma.lesson.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['studentId'],
          where: {
            status: LessonStatus.CONFIRMED,
            isGift: false,
            confirmedAt: { gte: start, lt: end },
          },
        }),
      );
      expect(rows).toEqual([
        { rank: 1, studentId: 's2', studentName: '小红', consumption: '3600.00', lessonCount: 12 },
        { rank: 2, studentId: 's1', studentName: '小明', consumption: '1200.00', lessonCount: 4 },
      ]);
    });

    it('该月没有任何确认课时，直接返回空数组（不发起学生查询）', async () => {
      prisma.lesson.groupBy.mockResolvedValue([]);

      const rows = await service.studentRanking('2026-10');

      expect(rows).toEqual([]);
      expect(prisma.student.findMany).not.toHaveBeenCalled();
    });
  });
});
