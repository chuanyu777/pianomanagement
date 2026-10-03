import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { LedgerKind, Prisma, RefundMode, StudentStatus, UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OrganizationService } from '../organization/organization.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import { RefundsService } from './refunds.service.js';

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * 只 mock 用到的方法。
 *
 * `enrollment.findMany` 会被调用两次，靠 select 形状区分：
 * - `select.id`（service 取该学生的报名 id）；
 * - `select.initialPaidBalance`（`computeEnrollmentBalances` 内部取起始值）。
 */
function createPrismaMock() {
  return {
    student: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    enrollment: { findMany: vi.fn() },
    ledgerEntry: { create: vi.fn(), groupBy: vi.fn() },
    refundRecord: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    giftGrant: { findMany: vi.fn(), updateMany: vi.fn() },
    lesson: { groupBy: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('RefundsService', () => {
  let prisma: PrismaMock;
  let periods: { assertOpenForDate: ReturnType<typeof vi.fn> };
  let organization: { get: ReturnType<typeof vi.fn> };
  let service: RefundsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    periods = { assertOpenForDate: vi.fn().mockResolvedValue(undefined) };
    organization = { get: vi.fn().mockResolvedValue({ refundFeeRate: D('0.03') }) };
    service = new RefundsService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
      organization as unknown as OrganizationService,
    );
  });

  function stubEnrollments(
    ids: { id: string }[],
    balances: { id: string; paid: string; gift: string }[],
  ): void {
    prisma.enrollment.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      if (args.select !== undefined && 'initialPaidBalance' in args.select) {
        return Promise.resolve(
          balances.map((row) => ({
            id: row.id,
            initialPaidBalance: D(row.paid),
            initialGiftBalance: D(row.gift),
          })),
        );
      }
      return Promise.resolve(ids);
    });
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
  }

  /**
   * 通用「可退费」桩：学生 PAUSED，两条报名 e1(实收 60 / 赠送 10)、e2(实收 40 / 赠送 5)，
   * 合计实收 100 / 赠送 15。未撤销赠送额度为空。
   */
  function stubRefundable(status: StudentStatus = StudentStatus.PAUSED): void {
    prisma.student.findUnique.mockResolvedValue({ id: 's1', name: '小明', status });
    stubEnrollments([{ id: 'e1' }, { id: 'e2' }], [
      { id: 'e1', paid: '60', gift: '10' },
      { id: 'e2', paid: '40', gift: '5' },
    ]);
    prisma.refundRecord.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'r1',
        createdAt: new Date('2026-10-05T02:00:00.000Z'),
        ...args.data,
      }),
    );
    prisma.ledgerEntry.create.mockResolvedValue({ id: 'le' });
    prisma.giftGrant.findMany.mockResolvedValue([]);
    prisma.giftGrant.updateMany.mockResolvedValue({ count: 0 });
    prisma.lesson.groupBy.mockResolvedValue([]);
    prisma.student.update.mockResolvedValue({ id: 's1' });
  }

  describe('create · REFUND', () => {
    it('每条报名写一条 REFUND 流水：两池清零（paidDelta / giftDelta 取该条余额的相反数）', async () => {
      stubRefundable();

      await service.create(
        {
          studentId: 's1',
          mode: RefundMode.REFUND,
          occurredAt: '2026-10-05T02:00:00.000Z',
          feeRate: 0.03,
        },
        OWNER,
      );

      expect(prisma.ledgerEntry.create).toHaveBeenCalledTimes(2);
      const first = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(first.kind).toBe(LedgerKind.REFUND);
      expect(first.enrollmentId).toBe('e1');
      expect((first.paidDelta as Prisma.Decimal).equals(D('-60'))).toBe(true);
      expect((first.giftDelta as Prisma.Decimal).equals(D('-10'))).toBe(true);
      expect(first.refundRecordId).toBe('r1');
      expect(first.createdById).toBe('owner-1');

      const second = prisma.ledgerEntry.create.mock.calls[1][0].data;
      expect(second.enrollmentId).toBe('e2');
      expect((second.paidDelta as Prisma.Decimal).equals(D('-40'))).toBe(true);
      expect((second.giftDelta as Prisma.Decimal).equals(D('-5'))).toBe(true);
    });

    it('手续费 = 实收合计 × 费率，refundAmount = 实收合计 − 手续费（100 × 0.03 = 3.00 / 97.00）', async () => {
      stubRefundable();

      const result = await service.create(
        {
          studentId: 's1',
          mode: RefundMode.REFUND,
          occurredAt: '2026-10-05T02:00:00.000Z',
          feeRate: 0.03,
        },
        OWNER,
      );

      const record = prisma.refundRecord.create.mock.calls[0][0].data;
      expect((record.paidTotal as Prisma.Decimal).equals(D('100'))).toBe(true);
      expect((record.giftTotal as Prisma.Decimal).equals(D('15'))).toBe(true);
      expect((record.feeRate as Prisma.Decimal).equals(D('0.03'))).toBe(true);
      expect((record.feeAmount as Prisma.Decimal).equals(D('3'))).toBe(true);
      expect((record.refundAmount as Prisma.Decimal).equals(D('97'))).toBe(true);
      expect(record.mode).toBe(RefundMode.REFUND);
      expect(record.studentId).toBe('s1');
      expect(record.createdById).toBe('owner-1');

      expect(result.paidTotal).toBe('100.00');
      expect(result.giftTotal).toBe('15.00');
      expect(result.feeAmount).toBe('3.00');
      expect(result.refundAmount).toBe('97.00');
    });

    it('不传 feeRate 时取机构 refundFeeRate', async () => {
      stubRefundable();
      organization.get.mockResolvedValue({ refundFeeRate: D('0.05') });

      await service.create({ studentId: 's1', mode: RefundMode.REFUND }, OWNER);

      const record = prisma.refundRecord.create.mock.calls[0][0].data;
      expect((record.feeRate as Prisma.Decimal).equals(D('0.05'))).toBe(true);
      expect((record.feeAmount as Prisma.Decimal).equals(D('5'))).toBe(true);
    });

    it('学生状态 → WITHDRAWN，wantsRefund 置 false', async () => {
      stubRefundable();

      await service.create({ studentId: 's1', mode: RefundMode.REFUND }, OWNER);

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: StudentStatus.WITHDRAWN, wantsRefund: false },
      });
    });

    it('未用完的 GiftGrant 打 revokedAt；已用满的不动', async () => {
      stubRefundable();
      prisma.giftGrant.findMany.mockResolvedValue([
        { id: 'g1', lessons: 10 },
        { id: 'g2', lessons: 5 },
      ]);
      prisma.lesson.groupBy.mockResolvedValue([
        { giftGrantId: 'g1', _count: { _all: 3 } },
        { giftGrantId: 'g2', _count: { _all: 5 } },
      ]);
      prisma.giftGrant.updateMany.mockResolvedValue({ count: 1 });

      await service.create({ studentId: 's1', mode: RefundMode.REFUND }, OWNER);

      expect(prisma.giftGrant.findMany.mock.calls[0][0].where).toEqual({
        enrollmentId: { in: ['e1', 'e2'] },
        revokedAt: null,
      });
      expect(prisma.giftGrant.updateMany.mock.calls[0][0]).toEqual({
        where: { id: { in: ['g1'] }, revokedAt: null },
        data: { revokedAt: expect.any(Date), revokedById: 'owner-1' },
      });
    });

    it('全部赠送额度都已用满时不调用 updateMany', async () => {
      stubRefundable();
      prisma.giftGrant.findMany.mockResolvedValue([{ id: 'g1', lessons: 3 }]);
      prisma.lesson.groupBy.mockResolvedValue([{ giftGrantId: 'g1', _count: { _all: 3 } }]);

      await service.create({ studentId: 's1', mode: RefundMode.REFUND }, OWNER);

      expect(prisma.giftGrant.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('create · KEEP', () => {
    it('不写任何流水，余额原样保留，状态 → PAUSED，手续费与实退都记 0', async () => {
      stubRefundable(StudentStatus.ENROLLED);

      const result = await service.create(
        { studentId: 's1', mode: RefundMode.KEEP, occurredAt: '2026-10-05T02:00:00.000Z' },
        OWNER,
      );

      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.giftGrant.findMany).not.toHaveBeenCalled();
      expect(prisma.giftGrant.updateMany).not.toHaveBeenCalled();

      const record = prisma.refundRecord.create.mock.calls[0][0].data;
      expect(record.mode).toBe(RefundMode.KEEP);
      expect((record.paidTotal as Prisma.Decimal).equals(D('100'))).toBe(true);
      expect((record.giftTotal as Prisma.Decimal).equals(D('15'))).toBe(true);
      expect((record.feeAmount as Prisma.Decimal).isZero()).toBe(true);
      expect((record.refundAmount as Prisma.Decimal).isZero()).toBe(true);

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: StudentStatus.PAUSED, wantsRefund: false },
      });
      expect(result.refundAmount).toBe('0.00');
    });
  });

  describe('create · 边界与关账', () => {
    it('学生不存在 → 404，且不建记录', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      await expect(service.create({ studentId: 'nope', mode: RefundMode.REFUND }, OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.refundRecord.create).not.toHaveBeenCalled();
    });

    it('学生已 WITHDRAWN 再次退费 → 409', async () => {
      stubRefundable(StudentStatus.WITHDRAWN);

      await expect(service.create({ studentId: 's1', mode: RefundMode.REFUND }, OWNER)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.refundRecord.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('feeRate 不在 0~1 → 400，且不写任何数据', async () => {
      stubRefundable();

      await expect(
        service.create({ studentId: 's1', mode: RefundMode.REFUND, feeRate: 1.5 }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({ studentId: 's1', mode: RefundMode.REFUND, feeRate: -0.01 }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refundRecord.create).not.toHaveBeenCalled();
    });

    it('关账月退费 → 409，且不写任何流水 / 记录', async () => {
      stubRefundable();
      periods.assertOpenForDate.mockRejectedValue(new ConflictException('月份 2026-10 已关账'));

      await expect(
        service.create(
          { studentId: 's1', mode: RefundMode.REFUND, occurredAt: '2026-10-05T02:00:00.000Z' },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.refundRecord.create).not.toHaveBeenCalled();
      expect(prisma.student.update).not.toHaveBeenCalled();
    });
  });

  describe('listPendingLosses', () => {
    it('列出 WITHDRAWN 或 wantsRefund 的学生，并给其实收 / 赠送两池合计', async () => {
      prisma.student.findMany.mockResolvedValue([
        { id: 's1', name: '甲', status: StudentStatus.WITHDRAWN, wantsRefund: false },
        { id: 's2', name: '乙', status: StudentStatus.PAUSED, wantsRefund: true },
      ]);
      prisma.enrollment.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
        if (args.select !== undefined && 'initialPaidBalance' in args.select) {
          return Promise.resolve([
            { id: 'e1', initialPaidBalance: D('100'), initialGiftBalance: D('10') },
            { id: 'e2', initialPaidBalance: D('50'), initialGiftBalance: D('0') },
            { id: 'e3', initialPaidBalance: D('0'), initialGiftBalance: D('30') },
          ]);
        }
        return Promise.resolve([
          { id: 'e1', studentId: 's1' },
          { id: 'e2', studentId: 's1' },
          { id: 'e3', studentId: 's2' },
        ]);
      });
      prisma.ledgerEntry.groupBy.mockResolvedValue([]);

      const result = await service.listPendingLosses();

      expect(prisma.student.findMany.mock.calls[0][0].where).toEqual({
        OR: [{ status: StudentStatus.WITHDRAWN }, { wantsRefund: true }],
      });
      expect(result).toEqual([
        {
          student: { id: 's1', name: '甲', status: StudentStatus.WITHDRAWN, wantsRefund: false },
          paidBalance: '150.00',
          giftBalance: '10.00',
          totalBalance: '160.00',
        },
        {
          student: { id: 's2', name: '乙', status: StudentStatus.PAUSED, wantsRefund: true },
          paidBalance: '0.00',
          giftBalance: '30.00',
          totalBalance: '30.00',
        },
      ]);
    });

    it('没有流失学生时不查报名关系', async () => {
      prisma.student.findMany.mockResolvedValue([]);

      const result = await service.listPendingLosses();

      expect(result).toEqual([]);
      expect(prisma.enrollment.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('分页列出退费记录，按 occurredAt 倒序，可按学生过滤', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [
          {
            id: 'r1',
            studentId: 's1',
            mode: RefundMode.REFUND,
            occurredAt: new Date('2026-10-05T02:00:00.000Z'),
            paidTotal: D('100'),
            giftTotal: D('15'),
            feeRate: D('0.03'),
            feeAmount: D('3'),
            refundAmount: D('97'),
            createdById: 'owner-1',
            createdAt: new Date('2026-10-05T02:00:00.000Z'),
          },
        ],
        1,
      ]);

      const result = await service.list({ page: 2, pageSize: 5, studentId: 's1' });

      expect(prisma.refundRecord.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          where: { studentId: 's1' },
          orderBy: { occurredAt: 'desc' },
          skip: 5,
          take: 5,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.items[0]).toEqual({
        id: 'r1',
        studentId: 's1',
        mode: RefundMode.REFUND,
        occurredAt: '2026-10-05T02:00:00.000Z',
        paidTotal: '100.00',
        giftTotal: '15.00',
        feeRate: '0.03',
        feeAmount: '3.00',
        refundAmount: '97.00',
        createdById: 'owner-1',
        createdAt: '2026-10-05T02:00:00.000Z',
      });
    });
  });
});
