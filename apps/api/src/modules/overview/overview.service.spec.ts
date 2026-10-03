import { Prisma } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FinanceService, FinanceSummary } from '../finance/finance.service.js';
import type { OrganizationService } from '../organization/organization.service.js';

// 工资口径由 payroll-totals 提供，本模块只消费。mock 掉它以便精确控制实发工资。
vi.mock('../payroll/payroll-totals.js', () => ({
  computePayrollSheet: vi.fn(),
}));

import {
  computePayrollSheet,
  type PayrollComputation,
} from '../payroll/payroll-totals.js';
import { OverviewService } from './overview.service.js';

const computePayrollSheetMock = vi.mocked(computePayrollSheet);

const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function summary(over: Partial<FinanceSummary> = {}): FinanceSummary {
  return {
    incomeCash: '0.00',
    incomeConsumption: '0.00',
    expenseCash: '0.00',
    expenseOperating: '0.00',
    cashBalance: '0.00',
    profit: '0.00',
    ...over,
  };
}

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
    ledgerEntry: { count: vi.fn().mockResolvedValue(0) },
    manualIncome: { count: vi.fn().mockResolvedValue(0) },
    otherExpense: { count: vi.fn().mockResolvedValue(0) },
    payroll: { count: vi.fn().mockResolvedValue(0) },
    refundRecord: { count: vi.fn().mockResolvedValue(0) },
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('OverviewService', () => {
  let prisma: PrismaMock;
  let finance: {
    buildSummary: ReturnType<typeof vi.fn>;
    buildIncomeStatement: ReturnType<typeof vi.fn>;
    buildExpenseStatement: ReturnType<typeof vi.fn>;
  };
  let organization: { listProfitShares: ReturnType<typeof vi.fn> };
  let service: OverviewService;

  beforeEach(() => {
    prisma = createPrismaMock();
    finance = {
      buildSummary: vi.fn().mockResolvedValue(summary()),
      buildIncomeStatement: vi.fn().mockResolvedValue([]),
      buildExpenseStatement: vi.fn().mockResolvedValue([]),
    };
    organization = { listProfitShares: vi.fn().mockResolvedValue([]) };
    computePayrollSheetMock.mockReset();
    computePayrollSheetMock.mockResolvedValue([]);
    service = new OverviewService(
      prisma as unknown as PrismaService,
      finance as unknown as FinanceService,
      organization as unknown as OrganizationService,
    );
  });

  describe('OV-01 指标卡', () => {
    it('6 张卡：本月值取 buildSummary(period)，本年累计为 1 月到该月求和', async () => {
      const byPeriod: Record<string, FinanceSummary> = {
        '2026-01': summary({
          incomeCash: '1000',
          incomeConsumption: '2000',
          expenseOperating: '500',
          profit: '1500',
          cashBalance: '10000',
        }),
        '2026-02': summary({
          incomeCash: '100',
          incomeConsumption: '300',
          expenseOperating: '100',
          profit: '200',
          cashBalance: '10100',
        }),
        '2026-03': summary({
          incomeCash: '50',
          incomeConsumption: '400',
          expenseOperating: '150',
          profit: '250',
          cashBalance: '10200',
        }),
      };
      finance.buildSummary.mockImplementation((period: string) =>
        Promise.resolve(byPeriod[period] ?? summary()),
      );
      const payrollByMonth: Record<string, PayrollComputation[]> = {
        '2026-01': [payrollRow({ netSalary: dec('500') })],
        '2026-02': [],
        '2026-03': [payrollRow({ netSalary: dec('300') })],
      };
      computePayrollSheetMock.mockImplementation((_prisma, period: string) =>
        Promise.resolve(payrollByMonth[period] ?? []),
      );

      const cards = await service.buildCards('2026-03');

      expect(cards).toHaveLength(6);
      const byKey = new Map(cards.map((card) => [card.key, card]));
      expect(byKey.get('incomeCash')).toEqual({
        key: 'incomeCash',
        label: '实收现金',
        current: '50.00',
        ytd: '1150.00',
      });
      expect(byKey.get('incomeConsumption')).toMatchObject({ current: '400.00', ytd: '2700.00' });
      expect(byKey.get('expense')).toMatchObject({ current: '150.00', ytd: '750.00' });
      expect(byKey.get('profit')).toMatchObject({ current: '250.00', ytd: '1950.00' });
      expect(byKey.get('netSalary')).toMatchObject({ current: '300.00', ytd: '800.00' });
      // 现金结余是时点值（存量），本年累计 = period 当月的结余，绝不是三个月的结余之和
      expect(byKey.get('cashBalance')).toMatchObject({ current: '10200.00', ytd: '10200.00' });
      expect(byKey.get('cashBalance')?.ytd).not.toBe('30300.00');
    });
  });

  describe('OV-02 收入 / 支出构成', () => {
    it('收入按 cash + consumption 展开，降序、金额为 0 的行不返回，并给出 total', async () => {
      finance.buildIncomeStatement.mockResolvedValue([
        { itemId: 'i1', name: '钢琴', isAuto: false, month: { cash: '600', consumption: '0', operating: '0' }, prevYtd: {}, ytd: {} },
        { itemId: 'i2', name: '课时消费', isAuto: true, month: { cash: '0', consumption: '8000', operating: '0' }, prevYtd: {}, ytd: {} },
        { itemId: 'i3', name: '听力', isAuto: false, month: { cash: '0', consumption: '0', operating: '0' }, prevYtd: {}, ytd: {} },
        { itemId: 'i4', name: '书费', isAuto: false, month: { cash: '200', consumption: '0', operating: '0' }, prevYtd: {}, ytd: {} },
      ]);

      const composition = await service.buildComposition('2026-03');

      expect(composition.income.items).toEqual([
        { name: '课时消费', amount: '8000.00' },
        { name: '钢琴', amount: '600.00' },
        { name: '书费', amount: '200.00' },
      ]);
      expect(composition.income.total).toBe('8800.00');
      // 「听力」金额为 0 → 不返回
      expect(composition.income.items.some((item) => item.name === '听力')).toBe(false);
    });

    it('支出按 operating 口径展开并降序', async () => {
      finance.buildExpenseStatement.mockResolvedValue([
        { itemId: 'e1', name: '工资', isAuto: true, month: { cash: '900', consumption: '0', operating: '1000' }, prevYtd: {}, ytd: {} },
        { itemId: 'e2', name: '水电', isAuto: false, month: { cash: '300', consumption: '0', operating: '300' }, prevYtd: {}, ytd: {} },
        { itemId: 'e3', name: '赠课成本', isAuto: true, month: { cash: '0', consumption: '0', operating: '0' }, prevYtd: {}, ytd: {} },
      ]);

      const composition = await service.buildComposition('2026-03');

      expect(composition.expense.items).toEqual([
        { name: '工资', amount: '1000.00' },
        { name: '水电', amount: '300.00' },
      ]);
      expect(composition.expense.total).toBe('1300.00');
    });
  });

  describe('OV-03 近 12 个月盈利趋势', () => {
    it('只返回有数据的月份，金额为字符串', async () => {
      finance.buildSummary.mockImplementation((period: string) =>
        Promise.resolve(summary({ profit: period === '2026-03' ? '250' : '120' })),
      );
      // 用「手工补录收入」作为该月有数据的信号；其余月份无任何记录 → 跳过
      prisma.manualIncome.count.mockImplementation((args: unknown) => {
        const period = (args as { where: { period: string } }).where.period;
        return Promise.resolve(period === '2026-01' || period === '2026-03' ? 1 : 0);
      });

      const trend = await service.buildProfitTrend('2026-03');

      expect(trend).toEqual([
        { period: '2026-01', profit: '120.00' },
        { period: '2026-03', profit: '250.00' },
      ]);
    });
  });

  describe('OV-04 利润分配展示', () => {
    it('取的是「上月」盈利：amount = prevPeriod(period) 盈利 × 比例，ratio 原样 4 位小数', async () => {
      finance.buildSummary.mockResolvedValue(summary({ profit: '20000' }));
      organization.listProfitShares.mockResolvedValue([
        { id: 'r1', name: '甲', ratio: dec('0.6'), sortOrder: 0, isActive: true },
        { id: 'r2', name: '乙', ratio: dec('0.4'), sortOrder: 1, isActive: true },
      ]);

      const result = await service.buildProfitShare('2026-03');

      expect(finance.buildSummary).toHaveBeenCalledWith('2026-02');
      expect(result.totalProfit).toBe('20000.00');
      expect(result.shares).toEqual([
        { name: '甲', ratio: '0.6000', amount: '12000.00' },
        { name: '乙', ratio: '0.4000', amount: '8000.00' },
      ]);
    });
  });
});
