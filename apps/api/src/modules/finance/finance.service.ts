import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { money, sumMoney, toMoneyString, ZERO, type Money } from '../../common/money.js';
import {
  nextPeriod,
  periodRange,
  periodsOfYearTo,
  prevPeriod,
  toPeriod,
  type Period,
} from '../../common/period.js';
import { AutoSource, LedgerKind, LessonStatus, Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { computePeriodTotals } from '../payroll/payroll-totals.js';
import { CreateManualIncomeDto } from './dto/create-manual-income.dto.js';
import { CreateOtherExpenseDto } from './dto/create-other-expense.dto.js';
import { ListManualIncomesQueryDto } from './dto/list-manual-incomes.dto.js';
import { ListOtherExpensesQueryDto } from './dto/list-other-expenses.dto.js';
import { UpdateManualIncomeDto } from './dto/update-manual-income.dto.js';
import { UpdateOtherExpenseDto } from './dto/update-other-expense.dto.js';

/** 三个口径的金额，一律两位小数字符串。用不到的口径填 '0.00'。 */
export type StatementAmounts = { cash: string; consumption: string; operating: string };

/** 收支表行（§12 跨模块契约，收入表与支出表共用）。 */
export type StatementRow = {
  itemId: string;
  name: string;
  isAuto: boolean;
  month: StatementAmounts;
  prevYtd: StatementAmounts;
  ytd: StatementAmounts;
};

export type FinanceSummary = {
  incomeCash: string;
  incomeConsumption: string;
  expenseCash: string;
  expenseOperating: string;
  cashBalance: string;
  profit: string;
};

type DateSpan = { start: Date; end: Date };

/** 某个收入项在某段跨度上的取值来源。 */
type IncomeBundle = {
  pay: Map<string, Money>;
  manual: Map<string, Money>;
  consumption: Money;
  refundFee: Money;
};

/** 某个支出项在某段跨度上的取值来源。 */
type ExpenseBundle = {
  payroll: { accrued: Money; cash: Money };
  /** 清单里是否存在独立的 PAYROLL_CASH 行 —— 决定工资行要不要让出现金口径 */
  hasPayrollCashItem: boolean;
  gift: Money;
  profitShare: Money;
  refundPaid: Money;
  other: Map<string, Money>;
};

type ItemShape = { id: string; autoSource: AutoSource | null };

function zeroAmounts(): StatementAmounts {
  return { cash: '0.00', consumption: '0.00', operating: '0.00' };
}

/**
 * 收支表（US-IE-01 / 02 / 04）与小计结余。
 *
 * 三条必须守住的口径（见实施计划 §5，别在这里重新解释）：
 * 1. 工资行的两个口径**故意不同**：operating = 本月应发、cash = 上月应发，
 *    这正是需求要的「相差一个月」。两处都取自 payroll 的 computePeriodTotals，是唯一权威实现。
 * 2. 赠课成本是经营支出、现金口径为 0；利润分配 / 退费是现金支出、经营口径为 0。
 * 3. 现金结余累加**所有 ≤ period 的月份**的资金净流，不是只看当月。
 *    「所有月份」从最早有数据的那个月算起（就等于首月），到 period 为止。
 *
 * 每月合计与逐行明细来自同一批聚合原语（paymentsByItem / lessonConsumption / …），
 * 所以小计永远等于各行之和，不会出现「表对不上小计」。
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  // ── 跨模块契约（§12） ─────────────────────────────────────────────────

  async buildIncomeStatement(period: Period): Promise<StatementRow[]> {
    const items = await this.prisma.incomeItem.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const [month, ytd, prevYtd] = await Promise.all([
      this.incomeBundle(items, [period]),
      this.incomeBundle(items, periodsOfYearTo(period)),
      this.incomeBundle(items, periodsOfYearTo(prevPeriod(period))),
    ]);

    return items.map((item) => ({
      itemId: item.id,
      name: item.name,
      isAuto: item.autoSource !== null,
      month: this.incomeAmounts(item, month),
      prevYtd: this.incomeAmounts(item, prevYtd),
      ytd: this.incomeAmounts(item, ytd),
    }));
  }

  async buildExpenseStatement(period: Period): Promise<StatementRow[]> {
    const items = await this.prisma.expenseItem.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const needsProfitShare = items.some((item) => item.autoSource === AutoSource.PROFIT_SHARE);
    const previousMonthProfit = needsProfitShare
      ? (await this.getOrganization()).previousMonthProfit
      : ZERO;

    const [month, ytd, prevYtd] = await Promise.all([
      this.expenseBundle(items, [period], previousMonthProfit),
      this.expenseBundle(items, periodsOfYearTo(period), previousMonthProfit),
      this.expenseBundle(items, periodsOfYearTo(prevPeriod(period)), previousMonthProfit),
    ]);

    return items.map((item) => ({
      itemId: item.id,
      name: item.name,
      isAuto: item.autoSource !== null,
      month: this.expenseAmounts(item, month),
      prevYtd: this.expenseAmounts(item, prevYtd),
      ytd: this.expenseAmounts(item, ytd),
    }));
  }

  async buildSummary(period: Period): Promise<FinanceSummary> {
    const [incomeRows, expenseRows, organization] = await Promise.all([
      this.buildIncomeStatement(period),
      this.buildExpenseStatement(period),
      this.getOrganization(),
    ]);

    const incomeCash = sumMoney(incomeRows.map((row) => row.month.cash));
    const incomeConsumption = sumMoney(incomeRows.map((row) => row.month.consumption));
    const expenseCash = sumMoney(expenseRows.map((row) => row.month.cash));
    const expenseOperating = sumMoney(expenseRows.map((row) => row.month.operating));
    const profit = incomeConsumption.minus(expenseOperating);
    const cashBalance = await this.computeCashBalance(period, organization);

    return {
      incomeCash: toMoneyString(incomeCash),
      incomeConsumption: toMoneyString(incomeConsumption),
      expenseCash: toMoneyString(expenseCash),
      expenseOperating: toMoneyString(expenseOperating),
      cashBalance: toMoneyString(cashBalance),
      profit: toMoneyString(profit),
    };
  }

  // ── 其它支出 CRUD（US-IE-03） ────────────────────────────────────────

  async listOtherExpenses(query: ListOtherExpensesQueryDto) {
    const where: Prisma.OtherExpenseWhereInput = {};
    if (query.period !== undefined) where.period = query.period;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.otherExpense.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.otherExpense.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async createOtherExpense(dto: CreateOtherExpenseDto, actor: AuthenticatedUser) {
    const amount = money(dto.cashAmount);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException('其它支出金额必须大于 0');
    }
    const item = await this.getManualExpenseItem(dto.expenseItemId);
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      // 关账校验与写入同一个事务：否则校验通过、写入前刚好关账就会漏网。
      await this.periods.assertOpen(dto.period, tx);
      return tx.otherExpense.create({
        data: {
          expenseItemId: item.id,
          period: dto.period,
          summary: dto.summary,
          cashAmount: amount,
          occurredAt,
          createdById: actor.id,
        },
      });
    });
  }

  async updateOtherExpense(id: string, dto: UpdateOtherExpenseDto) {
    const current = await this.prisma.otherExpense.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('其它支出记录不存在');

    const targetPeriod = dto.period ?? current.period;
    const data: {
      expenseItemId?: string;
      period?: string;
      summary?: string;
      cashAmount?: Prisma.Decimal;
      occurredAt?: Date;
    } = {};

    if (dto.expenseItemId !== undefined) {
      data.expenseItemId = (await this.getManualExpenseItem(dto.expenseItemId)).id;
    }
    if (dto.period !== undefined) data.period = dto.period;
    if (dto.summary !== undefined) data.summary = dto.summary;
    if (dto.cashAmount !== undefined) {
      const amount = money(dto.cashAmount);
      if (amount.lessThanOrEqualTo(ZERO)) {
        throw new BadRequestException('其它支出金额必须大于 0');
      }
      data.cashAmount = amount;
    }
    if (dto.occurredAt !== undefined) data.occurredAt = new Date(dto.occurredAt);

    return this.prisma.$transaction(async (tx) => {
      // 改动会同时触碰原月份与目标月份，两个都必须未关账。
      await this.periods.assertOpen(current.period, tx);
      if (targetPeriod !== current.period) await this.periods.assertOpen(targetPeriod, tx);
      return tx.otherExpense.update({ where: { id }, data });
    });
  }

  async removeOtherExpense(id: string): Promise<void> {
    const current = await this.prisma.otherExpense.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('其它支出记录不存在');

    await this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(current.period, tx);
      await tx.otherExpense.delete({ where: { id } });
    });
  }

  // ── 手工补录收入 CRUD（US-IE-01） ────────────────────────────────────

  async listManualIncomes(query: ListManualIncomesQueryDto) {
    const where: Prisma.ManualIncomeWhereInput = {};
    if (query.period !== undefined) where.period = query.period;
    if (query.incomeItemId !== undefined) where.incomeItemId = query.incomeItemId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.manualIncome.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.manualIncome.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async createManualIncome(dto: CreateManualIncomeDto, actor: AuthenticatedUser) {
    const amount = money(dto.amount);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException('补录金额必须大于 0');
    }
    const item = await this.getManualIncomeItem(dto.incomeItemId);

    return this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(dto.period, tx);
      return tx.manualIncome.create({
        data: {
          incomeItemId: item.id,
          period: dto.period,
          amount,
          note: dto.note ?? null,
          createdById: actor.id,
        },
      });
    });
  }

  async updateManualIncome(id: string, dto: UpdateManualIncomeDto) {
    const current = await this.prisma.manualIncome.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('补录收入记录不存在');

    const targetPeriod = dto.period ?? current.period;
    const data: { incomeItemId?: string; period?: string; amount?: Prisma.Decimal; note?: string | null } =
      {};

    if (dto.incomeItemId !== undefined) {
      data.incomeItemId = (await this.getManualIncomeItem(dto.incomeItemId)).id;
    }
    if (dto.period !== undefined) data.period = dto.period;
    if (dto.amount !== undefined) {
      const amount = money(dto.amount);
      if (amount.lessThanOrEqualTo(ZERO)) {
        throw new BadRequestException('补录金额必须大于 0');
      }
      data.amount = amount;
    }
    if (dto.note !== undefined) data.note = dto.note;

    return this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(current.period, tx);
      if (targetPeriod !== current.period) await this.periods.assertOpen(targetPeriod, tx);
      return tx.manualIncome.update({ where: { id }, data });
    });
  }

  async removeManualIncome(id: string): Promise<void> {
    const current = await this.prisma.manualIncome.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('补录收入记录不存在');

    await this.prisma.$transaction(async (tx) => {
      await this.periods.assertOpen(current.period, tx);
      await tx.manualIncome.delete({ where: { id } });
    });
  }

  // ── 逐行取值 ────────────────────────────────────────────────────────

  private incomeAmounts(item: ItemShape, bundle: IncomeBundle): StatementAmounts {
    const amounts = zeroAmounts();
    if (item.autoSource === null) {
      amounts.cash = toMoneyString(
        sumMoney([bundle.pay.get(item.id) ?? ZERO, bundle.manual.get(item.id) ?? ZERO]),
      );
    } else if (item.autoSource === AutoSource.LESSON_CONSUMPTION) {
      amounts.consumption = toMoneyString(bundle.consumption);
    } else if (item.autoSource === AutoSource.REFUND_FEE) {
      amounts.cash = toMoneyString(bundle.refundFee);
    }
    // 其余 autoSource（如 PAYMENT）当前无默认模板，也无明确口径 → 留 0，见报告「已知未做」。
    return amounts;
  }

  private expenseAmounts(item: ItemShape, bundle: ExpenseBundle): StatementAmounts {
    const amounts = zeroAmounts();
    switch (item.autoSource) {
      case AutoSource.PAYROLL_ACCRUED:
        amounts.operating = toMoneyString(bundle.payroll.accrued);
        // 清单里如果另建了独立的 PAYROLL_CASH 行，现金口径就交给那一行承担，
        // 这里必须置 0 —— 否则同一笔工资会在支出表里被算两遍（小计和现金结余都错）。
        // 默认模板只有一个工资行（PAYROLL_ACCRUED），此时它同时承担两个口径。
        amounts.cash = bundle.hasPayrollCashItem ? '0.00' : toMoneyString(bundle.payroll.cash);
        break;
      case AutoSource.PAYROLL_CASH:
        amounts.cash = toMoneyString(bundle.payroll.cash);
        break;
      case AutoSource.GIFT_COST:
        amounts.operating = toMoneyString(bundle.gift);
        break;
      case AutoSource.PROFIT_SHARE:
        amounts.cash = toMoneyString(bundle.profitShare);
        break;
      case AutoSource.REFUND_PAID:
        amounts.cash = toMoneyString(bundle.refundPaid);
        break;
      case null: {
        const value = toMoneyString(bundle.other.get(item.id) ?? ZERO);
        amounts.cash = value;
        amounts.operating = value;
        break;
      }
      default:
        break;
    }
    return amounts;
  }

  // ── 聚合原语 ────────────────────────────────────────────────────────

  private async incomeBundle(items: readonly ItemShape[], periods: Period[]): Promise<IncomeBundle> {
    const span = this.periodSpan(periods);
    const needsManual = items.some((item) => item.autoSource === null);
    const needsConsumption = items.some(
      (item) => item.autoSource === AutoSource.LESSON_CONSUMPTION,
    );
    const needsRefundFee = items.some((item) => item.autoSource === AutoSource.REFUND_FEE);

    const [pay, manual, consumption, refundFee] = await Promise.all([
      needsManual ? this.paymentsByItem(span) : Promise.resolve(new Map<string, Money>()),
      needsManual ? this.manualIncomesByItem(periods) : Promise.resolve(new Map<string, Money>()),
      needsConsumption ? this.lessonConsumption(span) : Promise.resolve(ZERO),
      needsRefundFee ? this.refundFees(span) : Promise.resolve(ZERO),
    ]);

    return { pay, manual, consumption, refundFee };
  }

  private async expenseBundle(
    items: readonly ItemShape[],
    periods: Period[],
    previousMonthProfit: Money,
  ): Promise<ExpenseBundle> {
    const span = this.periodSpan(periods);
    const needsPayroll = items.some(
      (item) =>
        item.autoSource === AutoSource.PAYROLL_ACCRUED ||
        item.autoSource === AutoSource.PAYROLL_CASH,
    );
    const needsGift = items.some((item) => item.autoSource === AutoSource.GIFT_COST);
    const needsProfitShare = items.some((item) => item.autoSource === AutoSource.PROFIT_SHARE);
    const needsRefundPaid = items.some((item) => item.autoSource === AutoSource.REFUND_PAID);
    const needsOther = items.some((item) => item.autoSource === null);

    const [payroll, gift, profitShare, refundPaid, other] = await Promise.all([
      needsPayroll
        ? this.payrollTotalsOver(periods)
        : Promise.resolve({ accrued: ZERO, cash: ZERO }),
      needsGift ? this.giftCostNet(span) : Promise.resolve(ZERO),
      needsProfitShare ? this.profitShareOver(periods, previousMonthProfit) : Promise.resolve(ZERO),
      needsRefundPaid ? this.refundPaid(span) : Promise.resolve(ZERO),
      needsOther ? this.otherExpensesByItem(periods) : Promise.resolve(new Map<string, Money>()),
    ]);

    const hasPayrollCashItem = items.some(
      (item) => item.autoSource === AutoSource.PAYROLL_CASH,
    );

    return { payroll, hasPayrollCashItem, gift, profitShare, refundPaid, other };
  }

  private async paymentsByItem(span: DateSpan): Promise<Map<string, Money>> {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['incomeItemId'],
      where: {
        kind: LedgerKind.PAYMENT,
        occurredAt: { gte: span.start, lt: span.end },
        incomeItemId: { not: null },
      },
      _sum: { paidDelta: true },
    });

    const map = new Map<string, Money>();
    for (const row of rows) {
      if (row.incomeItemId) map.set(row.incomeItemId, money(row._sum.paidDelta));
    }
    return map;
  }

  private async manualIncomesByItem(periods: readonly Period[]): Promise<Map<string, Money>> {
    const rows = await this.prisma.manualIncome.groupBy({
      by: ['incomeItemId'],
      where: { period: { gte: periods[0], lte: periods[periods.length - 1] } },
      _sum: { amount: true },
    });
    return new Map(rows.map((row) => [row.incomeItemId, money(row._sum.amount)]));
  }

  private async otherExpensesByItem(periods: readonly Period[]): Promise<Map<string, Money>> {
    const rows = await this.prisma.otherExpense.groupBy({
      by: ['expenseItemId'],
      where: { period: { gte: periods[0], lte: periods[periods.length - 1] } },
      _sum: { cashAmount: true },
    });
    return new Map(rows.map((row) => [row.expenseItemId, money(row._sum.cashAmount)]));
  }

  /** 课时消费口径：已确认且**非赠送**课的单价快照合计。 */
  private async lessonConsumption(span: DateSpan): Promise<Money> {
    const agg = await this.prisma.lesson.aggregate({
      where: {
        status: LessonStatus.CONFIRMED,
        isGift: false,
        confirmedAt: { gte: span.start, lt: span.end },
      },
      _sum: { unitPriceSnapshot: true },
    });
    return money(agg._sum.unitPriceSnapshot);
  }

  private async refundFees(span: DateSpan): Promise<Money> {
    const agg = await this.prisma.refundRecord.aggregate({
      where: { occurredAt: { gte: span.start, lt: span.end } },
      _sum: { feeAmount: true },
    });
    return money(agg._sum.feeAmount);
  }

  private async refundPaid(span: DateSpan): Promise<Money> {
    const agg = await this.prisma.refundRecord.aggregate({
      where: { occurredAt: { gte: span.start, lt: span.end } },
      _sum: { refundAmount: true },
    });
    return money(agg._sum.refundAmount);
  }

  /**
   * 赠课成本**净额**：GIFT 入池为正、GIFT_REVOKE 冲回为负，按带符号 giftDelta 求和。
   * 只算 GIFT 会把已撤销的赠送也算成成本。
   */
  private async giftCostNet(span: DateSpan): Promise<Money> {
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: {
        kind: { in: [LedgerKind.GIFT, LedgerKind.GIFT_REVOKE] },
        occurredAt: { gte: span.start, lt: span.end },
      },
      _sum: { giftDelta: true },
    });
    return money(agg._sum.giftDelta);
  }

  /** 工资两个口径的累计，唯一实现是 payroll 的 computePeriodTotals。 */
  private async payrollTotalsOver(
    periods: readonly Period[],
  ): Promise<{ accrued: Money; cash: Money }> {
    let accrued = ZERO;
    let cash = ZERO;
    for (const period of periods) {
      const totals = await computePeriodTotals(this.prisma, period);
      accrued = accrued.plus(money(totals.accruedTotal));
      cash = cash.plus(money(totals.cashTotal));
    }
    return { accrued, cash };
  }

  private async expenseOperatingOver(periods: readonly Period[]): Promise<Money> {
    const span = this.periodSpan([...periods]);
    const [payroll, gift, other] = await Promise.all([
      this.payrollTotalsOver(periods),
      this.giftCostNet(span),
      this.otherExpensesByItem(periods),
    ]);
    return payroll.accrued.plus(gift).plus(sumMoney([...other.values()]));
  }

  private async profitOf(period: Period): Promise<Money> {
    const span = this.periodSpan([period]);
    const [consumption, operating] = await Promise.all([
      this.lessonConsumption(span),
      this.expenseOperatingOver([period]),
    ]);
    return consumption.minus(operating);
  }

  /**
   * 「上月」判定：prevPeriod 既没有工资记录、也没有已确认课、也没有任何台账流水 → 视作首月，
   * 回落 `Organization.previousMonthProfit`（US-IW-02 的接续数据）。
   */
  private async isFirstMonth(period: Period): Promise<boolean> {
    const previous = prevPeriod(period);
    const { start, end } = periodRange(previous);
    const [payrollCount, lessonCount, ledgerCount] = await Promise.all([
      this.prisma.payroll.count({ where: { period: previous } }),
      this.prisma.lesson.count({
        where: { status: LessonStatus.CONFIRMED, confirmedAt: { gte: start, lt: end } },
      }),
      this.prisma.ledgerEntry.count({ where: { occurredAt: { gte: start, lt: end } } }),
    ]);
    return payrollCount === 0 && lessonCount === 0 && ledgerCount === 0;
  }

  private async profitShareOver(
    periods: readonly Period[],
    previousMonthProfit: Money,
  ): Promise<Money> {
    let total = ZERO;
    for (const period of periods) {
      const value = (await this.isFirstMonth(period))
        ? previousMonthProfit
        : await this.profitOf(prevPeriod(period));
      total = total.plus(value);
    }
    return total;
  }

  // ── 结余 ────────────────────────────────────────────────────────────

  private async computeCashBalance(
    period: Period,
    organization: { initialCashBalance: Money; previousMonthProfit: Money },
  ): Promise<Money> {
    const firstMonth = await this.resolveFirstMonth(period);
    if (firstMonth > period) return organization.initialCashBalance;

    const months = this.periodsBetween(firstMonth, period);
    const span = this.periodSpan(months);

    const [pay, manual, fees, refundOut, other] = await Promise.all([
      this.paymentsByItem(span),
      this.manualIncomesByItem(months),
      this.refundFees(span),
      this.refundPaid(span),
      this.otherExpensesByItem(months),
    ]);

    const incomeCash = sumMoney([...pay.values()])
      .plus(sumMoney([...manual.values()]))
      .plus(fees);

    let expenseCash = refundOut.plus(sumMoney([...other.values()]));
    for (const month of months) {
      const payroll = await computePeriodTotals(this.prisma, month);
      // 工资现金支出只加一次。有无独立的 PAYROLL_CASH 行都不影响总额 ——
      // 那是「这笔钱记在哪一行」的问题（见 expenseAmounts），不是「记几遍」的问题。
      expenseCash = expenseCash.plus(money(payroll.cashTotal));
      expenseCash = expenseCash.plus(
        await this.profitShareOver([month], organization.previousMonthProfit),
      );
    }

    return organization.initialCashBalance.plus(incomeCash).minus(expenseCash);
  }

  /** 最早有数据的月份（就等于首月）；一点数据都没有时退回 period 本身。 */
  private async resolveFirstMonth(period: Period): Promise<Period> {
    const [ledger, manual, other, refund, payroll] = await Promise.all([
      this.prisma.ledgerEntry.findFirst({
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.manualIncome.findFirst({
        orderBy: { period: 'asc' },
        select: { period: true },
      }),
      this.prisma.otherExpense.findFirst({
        orderBy: { period: 'asc' },
        select: { period: true },
      }),
      this.prisma.refundRecord.findFirst({
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.payroll.findFirst({ orderBy: { period: 'asc' }, select: { period: true } }),
    ]);

    const candidates: Period[] = [];
    if (ledger) candidates.push(toPeriod(ledger.occurredAt));
    if (manual) candidates.push(manual.period);
    if (other) candidates.push(other.period);
    if (refund) candidates.push(toPeriod(refund.occurredAt));
    if (payroll) candidates.push(payroll.period);
    if (candidates.length === 0) return period;
    return candidates.sort()[0];
  }

  private periodsBetween(from: Period, to: Period): Period[] {
    const out: Period[] = [];
    let cursor = from;
    while (cursor <= to) {
      out.push(cursor);
      cursor = nextPeriod(cursor);
    }
    return out;
  }

  private periodSpan(periods: readonly Period[]): DateSpan {
    return {
      start: periodRange(periods[0]).start,
      end: periodRange(periods[periods.length - 1]).end,
    };
  }

  // ── 机构设置与小工具 ────────────────────────────────────────────────

  private async getOrganization(): Promise<{
    initialCashBalance: Money;
    previousMonthProfit: Money;
  }> {
    const org = await this.prisma.organization.findFirst();
    return {
      initialCashBalance: money(org?.initialCashBalance),
      previousMonthProfit: money(org?.previousMonthProfit),
    };
  }

  /** 手工记账只能挂人工项：自动取数项由报表汇总，再手工记一笔就是重复计数。 */
  private async getManualExpenseItem(id: string) {
    const item = await this.prisma.expenseItem.findUnique({ where: { id } });
    if (!item) throw new BadRequestException('支出项不存在');
    if (!item.isActive) throw new BadRequestException('该支出项已停用，不能用于记账');
    if (item.autoSource !== null) {
      throw new BadRequestException('该支出项是自动取数项，由报表自动汇总，不能手工记账');
    }
    return item;
  }

  private async getManualIncomeItem(id: string) {
    const item = await this.prisma.incomeItem.findUnique({ where: { id } });
    if (!item) throw new BadRequestException('收入项不存在');
    if (!item.isActive) throw new BadRequestException('该收入项已停用，不能用于记账');
    if (item.autoSource !== null) {
      throw new BadRequestException('该收入项是自动取数项，由报表自动汇总，不能手工补录');
    }
    return item;
  }
}
