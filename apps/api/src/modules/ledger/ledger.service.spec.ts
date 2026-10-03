import { NotFoundException } from '@nestjs/common';
import { LedgerKind, Prisma, StudentStatus } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from './ledger.service.js';

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * 只 mock 用到的方法，不做「内存数据库替身」。
 *
 * `enrollment.findMany` 会被调用两次，含义不同，靠参数区分：
 * - 带 `include`：service 取「报名关系 + 课程名 / 老师名」；
 * - 带 `select.initialPaidBalance`：`computeEnrollmentBalances` 内部取起始值。
 * 第二次数出来的是权威余额，service 不许自己 SUM —— 用 `ledgerEntry.groupBy`
 * 是否被调用来反证它确实走了 balance.ts。
 */
function createPrismaMock() {
  return {
    student: { findUnique: vi.fn() },
    enrollment: { findMany: vi.fn() },
    ledgerEntry: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('LedgerService', () => {
  let prisma: PrismaMock;
  let service: LedgerService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    service = new LedgerService(prisma as unknown as PrismaService);
  });

  /** 报名的展示用实体（带 include 的那次查询）。 */
  function enrollmentRow(overrides: {
    id: string;
    unitPrice: string;
    courseTypeName: string;
    teacherName: string;
    studentId?: string;
    studentName?: string;
  }) {
    return {
      id: overrides.id,
      studentId: overrides.studentId ?? 's1',
      unitPrice: D(overrides.unitPrice),
      courseType: { name: overrides.courseTypeName },
      teacher: { id: `t-${overrides.teacherName}`, name: overrides.teacherName },
      student: { id: overrides.studentId ?? 's1', name: overrides.studentName ?? '小明' },
    };
  }

  /** balance.ts 内部取起始值的那次查询。 */
  function balanceRow(id: string, paid: string, gift: string) {
    return { id, initialPaidBalance: D(paid), initialGiftBalance: D(gift) };
  }

  function stubEnrollments(
    displayRows: ReturnType<typeof enrollmentRow>[],
    balanceRows: ReturnType<typeof balanceRow>[],
  ): void {
    prisma.enrollment.findMany.mockImplementation((args: { include?: unknown }) => {
      if (args.include !== undefined) return Promise.resolve(displayRows);
      return Promise.resolve(balanceRows);
    });
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
  }

  describe('getStudentLedger', () => {
    it('每条报名一行：课程名 / 老师名 / 单价 / 实收 / 赠送 / 合计，并走权威余额计算', async () => {
      prisma.student.findUnique.mockResolvedValue({
        id: 's1',
        name: '小明',
        status: StudentStatus.ENROLLED,
      });
      stubEnrollments(
        [
          enrollmentRow({ id: 'e1', unitPrice: '300', courseTypeName: '钢琴', teacherName: '张老师' }),
          enrollmentRow({ id: 'e2', unitPrice: '0', courseTypeName: '陪练', teacherName: '李老师' }),
        ],
        [balanceRow('e1', '1000', '200'), balanceRow('e2', '0', '0')],
      );

      const result = await service.getStudentLedger('s1');

      expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledTimes(1);
      expect(result.student).toEqual({
        id: 's1',
        name: '小明',
        status: StudentStatus.ENROLLED,
      });
      expect(result.enrollments[0]).toEqual({
        enrollmentId: 'e1',
        courseTypeName: '钢琴',
        teacherName: '张老师',
        unitPrice: '300.00',
        paidBalance: '1000.00',
        giftBalance: '200.00',
        totalBalance: '1200.00',
        remainingLessons: 4,
      });
      expect(result.totals).toEqual({
        paidBalance: '1000.00',
        giftBalance: '200.00',
        totalBalance: '1200.00',
      });
      expect(result.balanceStatus).toBe('正常');
    });

    it('预计剩余课时保留 1 位小数（1250 ÷ 300 = 4.2）', async () => {
      prisma.student.findUnique.mockResolvedValue({
        id: 's1',
        name: '小明',
        status: StudentStatus.ENROLLED,
      });
      stubEnrollments(
        [enrollmentRow({ id: 'e1', unitPrice: '300', courseTypeName: '钢琴', teacherName: '张老师' })],
        [balanceRow('e1', '1250', '0')],
      );

      const result = await service.getStudentLedger('s1');

      expect(result.enrollments[0].remainingLessons).toBe(4.2);
    });

    it('unitPrice 为 0 时不返回 remainingLessons，给维护单价提示（不返回 Infinity / NaN）', async () => {
      prisma.student.findUnique.mockResolvedValue({
        id: 's1',
        name: '小明',
        status: StudentStatus.ENROLLED,
      });
      stubEnrollments(
        [enrollmentRow({ id: 'e2', unitPrice: '0', courseTypeName: '陪练', teacherName: '李老师' })],
        [balanceRow('e2', '500', '0')],
      );

      const result = await service.getStudentLedger('s1');

      expect(result.enrollments[0]).not.toHaveProperty('remainingLessons');
      expect(result.enrollments[0].remainingLessonsHint).toBe('该课程单价为 0，请先维护单价');
    });

    it('任一课程合计余额为负 → 欠费，且学生合计如实反映负数', async () => {
      prisma.student.findUnique.mockResolvedValue({
        id: 's1',
        name: '小明',
        status: StudentStatus.ENROLLED,
      });
      stubEnrollments(
        [
          enrollmentRow({ id: 'e1', unitPrice: '300', courseTypeName: '钢琴', teacherName: '张老师' }),
          enrollmentRow({ id: 'e2', unitPrice: '200', courseTypeName: '陪练', teacherName: '李老师' }),
        ],
        [balanceRow('e1', '600', '0'), balanceRow('e2', '-50', '0')],
      );

      const result = await service.getStudentLedger('s1');

      expect(result.balanceStatus).toBe('欠费');
      expect(result.totals.totalBalance).toBe('550.00');
    });

    it('学生不存在 → 404', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      await expect(service.getStudentLedger('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.enrollment.findMany).not.toHaveBeenCalled();
    });

    it('period 非法 → 400（service 层兜底，不依赖 controller DTO）', async () => {
      await expect(service.getStudentLedger('s1', '2026-13')).rejects.toThrow(/period/);
    });
  });

  describe('listEntries', () => {
    it('按 occurredAt 倒序分页，学生 / 课程 / 类型 / 月份过滤（月份用 periodRange）', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [
          {
            id: 'le1',
            kind: LedgerKind.PAYMENT,
            occurredAt: new Date('2026-10-05T02:00:00.000Z'),
            paidDelta: D('500'),
            giftDelta: D('0'),
            note: '首期',
            enrollment: {
              courseType: { name: '钢琴' },
              student: { name: '小明' },
              teacher: { name: '张老师' },
            },
          },
        ],
        1,
      ]);

      const result = await service.listEntries({
        page: 2,
        pageSize: 5,
        studentId: 's1',
        enrollmentId: 'e1',
        kind: LedgerKind.PAYMENT,
        period: '2026-10',
      });

      const args = prisma.ledgerEntry.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        kind: LedgerKind.PAYMENT,
        enrollmentId: 'e1',
        enrollment: { studentId: 's1' },
        occurredAt: {
          gte: new Date('2026-09-30T16:00:00.000Z'),
          lt: new Date('2026-10-31T16:00:00.000Z'),
        },
      });
      expect(args.orderBy).toEqual({ occurredAt: 'desc' });
      expect(args.skip).toBe(5);
      expect(args.take).toBe(5);
      expect(prisma.ledgerEntry.count.mock.calls[0][0].where).toEqual(args.where);

      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(5);
      expect(result.items[0]).toEqual({
        id: 'le1',
        occurredAt: '2026-10-05T02:00:00.000Z',
        kind: LedgerKind.PAYMENT,
        courseTypeName: '钢琴',
        studentName: '小明',
        teacherName: '张老师',
        paidDelta: '500.00',
        giftDelta: '0.00',
        note: '首期',
      });
    });

    it('不带过滤条件时不加 where 子句', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);

      await service.listEntries({ page: 1, pageSize: 20 });

      expect(prisma.ledgerEntry.findMany.mock.calls[0][0].where).toEqual({});
    });
  });

  describe('listByTeacher', () => {
    it('按老师分组：老师 → 学生 → 各课程余额，并给出老师合计', async () => {
      stubEnrollments(
        [
          enrollmentRow({
            id: 'e1',
            unitPrice: '300',
            courseTypeName: '钢琴',
            teacherName: '张老师',
            studentId: 's1',
            studentName: '小明',
          }),
          enrollmentRow({
            id: 'e2',
            unitPrice: '300',
            courseTypeName: '钢琴',
            teacherName: '张老师',
            studentId: 's2',
            studentName: '小红',
          }),
          enrollmentRow({
            id: 'e3',
            unitPrice: '200',
            courseTypeName: '陪练',
            teacherName: '李老师',
            studentId: 's1',
            studentName: '小明',
          }),
        ],
        [balanceRow('e1', '1000', '0'), balanceRow('e2', '600', '0'), balanceRow('e3', '0', '0')],
      );

      const result = await service.listByTeacher();

      expect(result).toHaveLength(2);
      expect(result[0].teacherName).toBe('张老师');
      expect(result[0].students).toHaveLength(2);
      expect(result[0].students[0].studentName).toBe('小明');
      expect(result[0].students[0].enrollments[0]).toEqual({
        enrollmentId: 'e1',
        courseTypeName: '钢琴',
        unitPrice: '300.00',
        paidBalance: '1000.00',
        giftBalance: '0.00',
        totalBalance: '1000.00',
      });
      expect(result[0].totals.totalBalance).toBe('1600.00');
      expect(result[1].teacherName).toBe('李老师');
      expect(result[1].totals.totalBalance).toBe('0.00');
    });

    it('period 非法 → 400', async () => {
      await expect(service.listByTeacher('2026-1')).rejects.toThrow(/period/);
    });
  });
});
