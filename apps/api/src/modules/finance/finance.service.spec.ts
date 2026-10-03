import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { periodRange } from '../../common/period.js';
import { AutoSource, LedgerKind, Prisma, UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import { FinanceService } from './finance.service.js';

// 工资口径由 payroll-totals 提供，本模块只消费。测试里 mock 掉它，
// 让我们能精确控制「应发」与「实发现金」两个不同的值。
vi.mock('../payroll/payroll-totals.js', () => ({
  computePeriodTotals: vi.fn(),
}));

import { computePeriodTotals } from '../payroll/payroll-totals.js';

const computePeriodTotalsMock = vi.mocked(computePeriodTotals);

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

/** 某段连续月份的查询跨度（与 service 里 periodSpan 一致）。 */
function span(startPeriod: string, endPeriod: string): { gte: Date; lt: Date } {
  return { gte: periodRange(startPeriod).start, lt: periodRange(endPeriod).end };
}

function keyOf(range: { gte: Date; lt: Date }): string {
  return `${range.gte.toISOString()}|${range.lt.toISOString()}`;
}

function createPrismaMock() {
  return {
    incomeItem: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), count: vi.fn() },
    expenseItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    ledgerEntry: {
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { giftDelta: null } }),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    manualIncome: {
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    lesson: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { unitPriceSnapshot: null } }),
      count: vi.fn().mockResolvedValue(0),
    },
    refundRecord: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { feeAmount: null, refundAmount: null } }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    otherExpense: {
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    payroll: { findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) },
    organization: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

/** 每个测试独有的「按查询跨度给交费流水」配置。 */
let paymentsBySpan: Map<string, unknown[]>;

describe('FinanceService', () => {
  let prisma: PrismaMock;
  let periods: { assertOpen: ReturnType<typeof vi.fn> };
  let service: FinanceService;

  beforeEach(() => {
    prisma = createPrismaMock();
    paymentsBySpan = new Map();
    prisma.ledgerEntry.groupBy.mockImplementation((args: unknown) => {
      const where = (args as { where: { occurredAt: { gte: Date; lt: Date } } }).where;
      return Promise.resolve(paymentsBySpan.get(keyOf(where.occurredAt)) ?? []);
    });
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') return (arg as (client: PrismaMock) => unknown)(prisma);
      return Promise.all(arg as readonly unknown[]);
    });
    periods = { assertOpen: vi.fn().mockResolvedValue(undefined) };
    computePeriodTotalsMock.mockReset();
    computePeriodTotalsMock.mockResolvedValue({
      accruedTotal: new Prisma.Decimal(0),
      cashTotal: new Prisma.Decimal(0),
    });
    service = new FinanceService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
    );
  });

  describe('收入表', () => {
    it('手工收入项：当月 = 交费流水 + 手工补录；ytd/prevYtd 用累计口径', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([
        { id: 'i1', name: '钢琴', autoSource: null, sortOrder: 0 },
      ]);
      paymentsBySpan.set(keyOf(span('2026-03', '2026-03')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('500') } },
      ]);
      paymentsBySpan.set(keyOf(span('2026-01', '2026-03')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('2500') } },
      ]);
      paymentsBySpan.set(keyOf(span('2026-01', '2026-02')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('2000') } },
      ]);
      prisma.manualIncome.groupBy.mockImplementation((args: unknown) => {
        const where = (args as { where: { period: { gte: string; lte: string } } }).where.period;
        const byRange: Record<string, string> = {
          '2026-03|2026-03': '100',
          '2026-01|2026-03': '900',
          '2026-01|2026-02': '800',
        };
        const amount = byRange[`${where.gte}|${where.lte}`];
        return Promise.resolve(
          amount
            ? [{ incomeItemId: 'i1', _sum: { amount: new Prisma.Decimal(amount) } }]
            : [],
        );
      });

      const rows = await service.buildIncomeStatement('2026-03');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        itemId: 'i1',
        name: '钢琴',
        isAuto: false,
        month: { cash: '600.00', consumption: '0.00', operating: '0.00' },
        ytd: { cash: '3400.00' },
        prevYtd: { cash: '2800.00' },
      });
    });

    it('课时消费：cash = 0，consumption = 当月非赠送已确认课快照合计', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([
        { id: 'i-cons', name: '课时消费', autoSource: AutoSource.LESSON_CONSUMPTION, sortOrder: 0 },
      ]);
      prisma.lesson.aggregate.mockResolvedValue({
        _sum: { unitPriceSnapshot: new Prisma.Decimal('8000') },
      });

      const rows = await service.buildIncomeStatement('2026-03');

      expect(rows[0].isAuto).toBe(true);
      expect(rows[0].month).toEqual({
        cash: '0.00',
        consumption: '8000.00',
        operating: '0.00',
      });
      expect(prisma.lesson.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'CONFIRMED', isGift: false }),
        }),
      );
    });

    it('退费手续费：cash = 当月 RefundRecord.feeAmount 合计', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([
        { id: 'i-fee', name: '退费手续费', autoSource: AutoSource.REFUND_FEE, sortOrder: 0 },
      ]);
      prisma.refundRecord.aggregate.mockResolvedValue({
        _sum: { feeAmount: new Prisma.Decimal('120'), refundAmount: null },
      });

      const rows = await service.buildIncomeStatement('2026-03');

      expect(rows[0].month.cash).toBe('120.00');
      expect(rows[0].month.consumption).toBe('0.00');
    });
  });

  describe('支出表', () => {
    it('工资行：operating = 应发合计，cash = 实发现金，两个口径取不同的值', async () => {
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-wage', name: '工资', autoSource: AutoSource.PAYROLL_ACCRUED, sortOrder: 0 },
      ]);
      computePeriodTotalsMock.mockImplementation((_prisma, period) =>
        Promise.resolve(
          period === '2026-03'
            ? {
                accruedTotal: new Prisma.Decimal('1000'),
                cashTotal: new Prisma.Decimal('800'),
              }
            : { accruedTotal: new Prisma.Decimal(0), cashTotal: new Prisma.Decimal(0) },
        ),
      );

      const rows = await service.buildExpenseStatement('2026-03');

      expect(rows[0].month.operating).toBe('1000.00');
      expect(rows[0].month.cash).toBe('800.00');
      expect(rows[0].ytd.operating).toBe('1000.00');
      expect(rows[0].ytd.cash).toBe('800.00');
      expect(computePeriodTotalsMock).toHaveBeenCalledWith(prisma, '2026-03');
    });

    it('清单里另有独立 PAYROLL_CASH 行时，工资行的现金口径让给那一行，同一笔工资不会被算两遍', async () => {
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-wage', name: '工资', autoSource: AutoSource.PAYROLL_ACCRUED, sortOrder: 0 },
        { id: 'e-wage-cash', name: '工资现金', autoSource: AutoSource.PAYROLL_CASH, sortOrder: 1 },
      ]);
      computePeriodTotalsMock.mockImplementation((_prisma, period) =>
        Promise.resolve(
          period === '2026-03'
            ? { accruedTotal: new Prisma.Decimal('1000'), cashTotal: new Prisma.Decimal('800') }
            : { accruedTotal: new Prisma.Decimal(0), cashTotal: new Prisma.Decimal(0) },
        ),
      );

      const rows = await service.buildExpenseStatement('2026-03');
      const wageRow = rows.find((row) => row.itemId === 'e-wage');
      const cashRow = rows.find((row) => row.itemId === 'e-wage-cash');

      // 应发（经营口径）仍挂在工资行；现金口径整体挪到独立行
      expect(wageRow?.month.operating).toBe('1000.00');
      expect(wageRow?.month.cash).toBe('0.00');
      expect(cashRow?.month.cash).toBe('800.00');

      const totalCash = rows.reduce((acc, row) => acc.plus(row.month.cash), new Prisma.Decimal(0));
      expect(totalCash.toFixed(2)).toBe('800.00');
    });

    it('赠课成本：用 GIFT 与 GIFT_REVOKE 的净额（带符号 giftDelta 求和）', async () => {
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-gift', name: '赠课成本', autoSource: AutoSource.GIFT_COST, sortOrder: 0 },
      ]);
      // GIFT +2000、GIFT_REVOKE −500 → 净成本 1500
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { giftDelta: new Prisma.Decimal('1500') },
      });

      const rows = await service.buildExpenseStatement('2026-03');

      expect(rows[0].month.operating).toBe('1500.00');
      expect(rows[0].month.cash).toBe('0.00');
      expect(prisma.ledgerEntry.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kind: { in: [LedgerKind.GIFT, LedgerKind.GIFT_REVOKE] },
          }),
        }),
      );
    });

    it('利润分配：cash 取的是「上月」盈利，不是本月', async () => {
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-profit', name: '利润分配', autoSource: AutoSource.PROFIT_SHARE, sortOrder: 0 },
      ]);
      // 上月（2026-01）有工资记录 → 2026-02 不是首月 → 取 2026-01 的盈利
      prisma.payroll.count.mockImplementation((args: unknown) =>
        Promise.resolve((args as { where: { period: string } }).where.period === '2026-01' ? 1 : 0),
      );
      // 利润 = 课时消费 − 经营支出 = 4000 − 1000 = 3000
      prisma.lesson.aggregate.mockImplementation((args: unknown) => {
        const where = (args as { where: { confirmedAt: { gte: Date; lt: Date } } }).where
          .confirmedAt;
        return Promise.resolve({
          _sum: {
            unitPriceSnapshot:
              keyOf(where) === keyOf(span('2026-01', '2026-01'))
                ? new Prisma.Decimal('4000')
                : null,
          },
        });
      });
      computePeriodTotalsMock.mockImplementation((_prisma, period) =>
        Promise.resolve(
          period === '2026-01'
            ? { accruedTotal: new Prisma.Decimal('1000'), cashTotal: new Prisma.Decimal('1000') }
            : { accruedTotal: new Prisma.Decimal(0), cashTotal: new Prisma.Decimal(0) },
        ),
      );
      // 首月回落值故意设成 999，用来证明「取的是上月盈利，不是首月回落值」
      prisma.organization.findFirst.mockResolvedValue({
        initialCashBalance: new Prisma.Decimal('0'),
        previousMonthProfit: new Prisma.Decimal('999'),
        previousMonthPayroll: new Prisma.Decimal('0'),
      });

      const rows = await service.buildExpenseStatement('2026-02');

      expect(rows[0].month.cash).toBe('3000.00');
      expect(rows[0].month.cash).not.toBe('999.00');
      expect(rows[0].month.operating).toBe('0.00');
    });

    it('手工支出项：cash = operating = 当月其它支出合计', async () => {
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-util', name: '水电', autoSource: null, sortOrder: 0 },
      ]);
      prisma.otherExpense.groupBy.mockResolvedValue([
        { expenseItemId: 'e-util', _sum: { cashAmount: new Prisma.Decimal('300') } },
      ]);

      const rows = await service.buildExpenseStatement('2026-03');

      expect(rows[0].month).toEqual({
        cash: '300.00',
        consumption: '0.00',
        operating: '300.00',
      });
    });
  });

  describe('小计与结余', () => {
    it('profit = incomeConsumption − expenseOperating', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([
        { id: 'i-cons', name: '课时消费', autoSource: AutoSource.LESSON_CONSUMPTION, sortOrder: 0 },
      ]);
      prisma.expenseItem.findMany.mockResolvedValue([
        { id: 'e-wage', name: '工资', autoSource: AutoSource.PAYROLL_ACCRUED, sortOrder: 0 },
        { id: 'e-gift', name: '赠课成本', autoSource: AutoSource.GIFT_COST, sortOrder: 1 },
      ]);
      prisma.lesson.aggregate.mockResolvedValue({
        _sum: { unitPriceSnapshot: new Prisma.Decimal('5000') },
      });
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { giftDelta: new Prisma.Decimal('500') },
      });
      computePeriodTotalsMock.mockResolvedValue({
        accruedTotal: new Prisma.Decimal('1000'),
        cashTotal: new Prisma.Decimal('700'),
      });

      const summary = await service.buildSummary('2026-03');

      expect(summary.incomeConsumption).toBe('5000.00');
      expect(summary.expenseOperating).toBe('1500.00');
      expect(summary.profit).toBe('3500.00');
    });

    it('cashBalance 累加历史月份的资金净流，不是只看当月', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([
        { id: 'i1', name: '钢琴', autoSource: null, sortOrder: 0 },
      ]);
      // 期初现金 1000；1 月交费 2000、3 月交费 500（2 月无流水）
      prisma.organization.findFirst.mockResolvedValue({
        initialCashBalance: new Prisma.Decimal('1000'),
        previousMonthProfit: new Prisma.Decimal('0'),
        previousMonthPayroll: new Prisma.Decimal('0'),
      });
      prisma.ledgerEntry.findFirst.mockResolvedValue({
        occurredAt: new Date('2026-01-15T04:00:00.000Z'),
      });
      paymentsBySpan.set(keyOf(span('2026-03', '2026-03')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('500') } },
      ]);
      paymentsBySpan.set(keyOf(span('2026-01', '2026-03')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('2500') } },
      ]);
      paymentsBySpan.set(keyOf(span('2026-01', '2026-02')), [
        { incomeItemId: 'i1', _sum: { paidDelta: new Prisma.Decimal('2000') } },
      ]);

      const summary = await service.buildSummary('2026-03');

      // 当月现金收入只有 3 月的 500
      expect(summary.incomeCash).toBe('500.00');
      // 结余 = 期初 1000 + (1月 2000 + 2月 0 + 3月 500) = 3500
      expect(summary.cashBalance).toBe('3500.00');
      // 累加确实用了「1 月到 3 月」的整段跨度
      expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ occurredAt: span('2026-01', '2026-03') }),
        }),
      );
    });
  });

  describe('其它支出 CRUD', () => {
    it('金额必须 > 0', async () => {
      await expect(
        service.createOtherExpense(
          { expenseItemId: 'e1', period: '2026-03', summary: '水电', cashAmount: 0 },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.otherExpense.create).not.toHaveBeenCalled();
    });

    it('关账月新增其它支出 → 409，且不写库', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({
        id: 'e1',
        isActive: true,
        autoSource: null,
      });
      periods.assertOpen.mockRejectedValue(new ConflictException('月份 2026-03 已关账'));

      await expect(
        service.createOtherExpense(
          { expenseItemId: 'e1', period: '2026-03', summary: '水电', cashAmount: 100 },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.otherExpense.create).not.toHaveBeenCalled();
    });

    it('正常新增：过 assertOpen，记录归属月份与制单人', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({
        id: 'e1',
        isActive: true,
        autoSource: null,
      });
      prisma.otherExpense.create.mockResolvedValue({ id: 'o1' });

      await service.createOtherExpense(
        { expenseItemId: 'e1', period: '2026-03', summary: '水电', cashAmount: 100.5 },
        OWNER,
      );

      expect(periods.assertOpen).toHaveBeenCalledWith('2026-03', expect.anything());
      const data = prisma.otherExpense.create.mock.calls[0][0].data;
      expect(data.expenseItemId).toBe('e1');
      expect(data.period).toBe('2026-03');
      expect(data.summary).toBe('水电');
      expect((data.cashAmount as Prisma.Decimal).equals(new Prisma.Decimal('100.5'))).toBe(true);
      expect(data.createdById).toBe('owner-1');
    });

    it('自动取数支出项不能手工记其它支出', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({
        id: 'e1',
        isActive: true,
        autoSource: AutoSource.GIFT_COST,
      });

      await expect(
        service.createOtherExpense(
          { expenseItemId: 'e1', period: '2026-03', summary: '水电', cashAmount: 100 },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.otherExpense.create).not.toHaveBeenCalled();
    });

    it('删除关账月记录 → 409', async () => {
      prisma.otherExpense.findUnique.mockResolvedValue({ id: 'o1', period: '2026-03' });
      periods.assertOpen.mockRejectedValue(new ConflictException('已关账'));

      await expect(service.removeOtherExpense('o1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.otherExpense.delete).not.toHaveBeenCalled();
    });
  });

  describe('手工补录收入 CRUD', () => {
    it('incomeItemId 指向自动项时被拒（400）', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue({
        id: 'i-auto',
        isActive: true,
        autoSource: AutoSource.LESSON_CONSUMPTION,
      });

      await expect(
        service.createManualIncome(
          { incomeItemId: 'i-auto', period: '2026-03', amount: 100 },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.manualIncome.create).not.toHaveBeenCalled();
    });

    it('金额必须 > 0', async () => {
      await expect(
        service.createManualIncome(
          { incomeItemId: 'i1', period: '2026-03', amount: 0 },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('正常补录：过 assertOpen 并记录制单人', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue({
        id: 'i1',
        isActive: true,
        autoSource: null,
      });
      prisma.manualIncome.create.mockResolvedValue({ id: 'm1' });

      await service.createManualIncome(
        { incomeItemId: 'i1', period: '2026-03', amount: 200, note: '补录' },
        OWNER,
      );

      expect(periods.assertOpen).toHaveBeenCalledWith('2026-03', expect.anything());
      const data = prisma.manualIncome.create.mock.calls[0][0].data;
      expect(data.incomeItemId).toBe('i1');
      expect((data.amount as Prisma.Decimal).equals(new Prisma.Decimal('200'))).toBe(true);
      expect(data.createdById).toBe('owner-1');
    });
  });
});
