import type { PrismaService } from '../../prisma/prisma.service.js';
import { LessonStatus, Prisma, StudentStatus } from '../../prisma/generated.js';

// 余额口径来自 ledger 的权威实现（computeEnrollmentBalances），本模块只消费。
vi.mock('../ledger/balance.js', () => ({
  computeEnrollmentBalances: vi.fn(),
}));

import {
  computeEnrollmentBalances,
  type EnrollmentBalance,
} from '../ledger/balance.js';
import { RisksService, SLEEPING_IDLE_DAYS } from './risks.service.js';

const balancesMock = vi.mocked(computeEnrollmentBalances);

const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function balance(enrollmentId: string, paid: string, gift: string): EnrollmentBalance {
  const paidValue = dec(paid);
  const giftValue = dec(gift);
  return { enrollmentId, paid: paidValue, gift: giftValue, total: paidValue.plus(giftValue) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function createPrismaMock() {
  return {
    enrollment: { findMany: vi.fn() },
    student: { findMany: vi.fn() },
    lesson: { groupBy: vi.fn() },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('RisksService', () => {
  let prisma: PrismaMock;
  let service: RisksService;

  beforeEach(() => {
    prisma = createPrismaMock();
    balancesMock.mockReset();
    balancesMock.mockResolvedValue(new Map());
    service = new RisksService(prisma as unknown as PrismaService);
  });

  describe('RA-01 欠费名单', () => {
    it('列出余额为负的报名关系，按欠费升序（欠得最多的在前），并给出学生维度合计', async () => {
      prisma.enrollment.findMany.mockResolvedValue([
        { id: 'e1', student: { id: 's1', name: '小明', status: StudentStatus.ENROLLED }, courseType: { name: '钢琴' } },
        { id: 'e2', student: { id: 's1', name: '小明', status: StudentStatus.ENROLLED }, courseType: { name: '听力' } },
        { id: 'e3', student: { id: 's2', name: '小红', status: StudentStatus.ENROLLED }, courseType: { name: '钢琴' } },
      ]);
      balancesMock.mockResolvedValue(
        new Map([
          ['e1', balance('e1', '-100', '0')],
          ['e2', balance('e2', '50', '0')],
          ['e3', balance('e3', '-20', '0')],
        ]),
      );

      const rows = await service.listUnpaid();

      expect(prisma.enrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { student: { status: { not: StudentStatus.WITHDRAWN } } },
        }),
      );
      // 只统计未退学学生；e2 余额为正 → 不算欠费；s1 只有 e1 一条为负 → 只出现一行
      expect(rows).toEqual([
        { studentId: 's1', studentName: '小明', enrollmentId: 'e1', courseTypeName: '钢琴', balance: '-100.00', totalBalance: '-50.00' },
        { studentId: 's2', studentName: '小红', enrollmentId: 'e3', courseTypeName: '钢琴', balance: '-20.00', totalBalance: '-20.00' },
      ]);
    });

    it('已退学学生不出现在欠费名单里', async () => {
      prisma.enrollment.findMany.mockResolvedValue([
        { id: 'e1', student: { id: 's1', name: '小明', status: StudentStatus.ENROLLED }, courseType: { name: '钢琴' } },
        { id: 'e9', student: { id: 's9', name: '已退', status: StudentStatus.WITHDRAWN }, courseType: { name: '钢琴' } },
      ]);
      balancesMock.mockResolvedValue(
        new Map([
          ['e1', balance('e1', '-10', '0')],
          ['e9', balance('e9', '-999', '0')],
        ]),
      );

      const rows = await service.listUnpaid();

      expect(rows.map((row) => row.studentId)).toEqual(['s1']);
    });
  });

  describe('RA-02 沉睡学生名单', () => {
    const now = new Date('2026-10-03T00:00:00.000Z');

    function stubStudents(): void {
      prisma.student.findMany.mockResolvedValue([
        { id: 's1', name: '沉睡甲', status: StudentStatus.ENROLLED, createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 's2', name: '边界乙', status: StudentStatus.ENROLLED, createdAt: new Date('2026-01-02T00:00:00.000Z') },
        { id: 's3', name: '新生丙', status: StudentStatus.ENROLLED, createdAt: new Date('2026-09-28T00:00:00.000Z') },
        { id: 's9', name: '退学丁', status: StudentStatus.WITHDRAWN, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ]);
    }

    it('第 41 天算沉睡、正好第 40 天不算；从未有确认课落入 never；已退学被排除', async () => {
      stubStudents();
      prisma.lesson.groupBy.mockResolvedValue([
        // 距今 41 天 → 沉睡
        { studentId: 's1', _max: { confirmedAt: new Date('2026-08-23T00:00:00.000Z') } },
        // 距今正好 40 天 → 不算沉睡、也不在 never
        { studentId: 's2', _max: { confirmedAt: new Date('2026-08-24T00:00:00.000Z') } },
        // s9 已退学，本不该被查，但即便返回也要被排除
        { studentId: 's9', _max: { confirmedAt: new Date('2026-01-03T00:00:00.000Z') } },
      ]);

      const result = await service.listSleeping(now);

      // 阈值必须来自单一来源常量并回传，前端不硬编码 40
      expect(result.thresholdDays).toBe(SLEEPING_IDLE_DAYS);
      expect(SLEEPING_IDLE_DAYS).toBe(40);

      expect(result.sleeping).toEqual([
        { studentId: 's1', studentName: '沉睡甲', lastConfirmedAt: '2026-08-23T00:00:00.000Z', idleDays: 41 },
      ]);
      // 「一次确认课都没有」单独列出，且 lastConfirmedAt 为 null
      expect(result.never).toEqual([
        { studentId: 's3', studentName: '新生丙', lastConfirmedAt: null, idleDays: 5 },
      ]);
      // 边界学生既不在 sleeping 也不在 never
      expect([...result.sleeping, ...result.never].some((row) => row.studentId === 's2')).toBe(false);
      // 已退学学生出现在任何名单里都算错
      expect([...result.sleeping, ...result.never].some((row) => row.studentId === 's9')).toBe(false);
    });

    it('只认已确认的课：查询条件限定 CONFIRMED，且排除已退学学生', async () => {
      stubStudents();
      prisma.lesson.groupBy.mockResolvedValue([]);

      await service.listSleeping(now);

      expect(prisma.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { not: StudentStatus.WITHDRAWN } },
        }),
      );
      expect(prisma.lesson.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: { in: ['s1', 's2', 's3'] }, status: LessonStatus.CONFIRMED },
          _max: { confirmedAt: true },
        }),
      );
    });

    it('从不带任何金额字段', async () => {
      stubStudents();
      prisma.lesson.groupBy.mockResolvedValue([
        { studentId: 's1', _max: { confirmedAt: new Date('2026-08-23T00:00:00.000Z') } },
      ]);

      const result = await service.listSleeping(now);

      expect(Object.keys(result.sleeping[0])).toEqual([
        'studentId',
        'studentName',
        'lastConfirmedAt',
        'idleDays',
      ]);
      expect(result.sleeping[0]).not.toHaveProperty('balance');
    });

    it('idleDays 以注入的当前时间为准（天 = 向下取整）', async () => {
      stubStudents();
      prisma.lesson.groupBy.mockResolvedValue([
        { studentId: 's1', _max: { confirmedAt: new Date(now.getTime() - 41 * DAY_MS - 3600 * 1000) } },
      ]);

      const result = await service.listSleeping(now);

      // 41 天零 1 小时 → 仍按 41 天计（离散天数）
      expect(result.sleeping[0].idleDays).toBe(41);
    });
  });
});
