import { Injectable } from '@nestjs/common';
import { money, multiplyMoney, sumMoney, toMoneyString, ZERO, type Money } from '../../common/money.js';
import {
  lastPeriods,
  periodRange,
  periodsOfYearTo,
  prevPeriod,
  type Period,
} from '../../common/period.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { OrganizationService } from '../organization/organization.service.js';
import { computePayrollSheet } from '../payroll/payroll-totals.js';

/** OV-01 指标卡。金额一律两位小数字符串。 */
export type OverviewCard = {
  key: string;
  label: string;
  current: string;
  ytd: string;
};

/** OV-02 构成的一块（收入或支出）。 */
export type CompositionSlice = {
  items: { name: string; amount: string }[];
  total: string;
};

export type OverviewComposition = {
  income: CompositionSlice;
  expense: CompositionSlice;
};

/** OV-03 趋势点。 */
export type ProfitTrendPoint = {
  period: Period;
  profit: string;
};

/** OV-04 利润分配展示。 */
export type ProfitShareDisplay = {
  shares: { name: string; ratio: string; amount: string }[];
  totalProfit: string;
};

/**
 * 经营总览（US-OV-01…04）。
 *
 * 本模块**不自己算钱**：指标卡与构成一律走 finance 的 `buildSummary` /
 * `buildIncomeStatement` / `buildExpenseStatement`，实发工资走 payroll 的
 * `computePayrollSheet`，利润分配人走 organization 的 `listProfitShares`。
 * 自己再写一份口径 = 第二份实现，迟早和报表对不上且不报错。
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly organization: OrganizationService,
  ) {}

  // ── OV-01 指标卡 ─────────────────────────────────────────────────────

  /**
   * 六张卡，每张给「本月值 + 本年累计」。
   *
   * 本年累计口径（这里做了两种选择，理由如下）：
   * - 流量类（实收现金 / 课时消费 / 支出 / 盈利 / 实发工资）取 1 月到 period **各月求和**。
   * - 现金结余**取 period 当月的时点值**，不求和。它是「存量」：`buildSummary` 里的
   *   cashBalance 已经把期初现金与所有历史净流累加进去了，再把各月结余相加是重复累加，
   *   会得到一个毫无意义的数字（例如 10 月累计 = 10 个月结余之和）。
   */
  async buildCards(period: Period): Promise<OverviewCard[]> {
    const months = periodsOfYearTo(period);
    const [summaries, sheets] = await Promise.all([
      Promise.all(months.map((month) => this.finance.buildSummary(month))),
      Promise.all(months.map((month) => computePayrollSheet(this.prisma, month))),
    ]);

    const current = summaries[summaries.length - 1];
    const sum = (values: readonly string[]): string => toMoneyString(sumMoney(values));
    const netSalaryByMonth = sheets.map((sheet) =>
      sumMoney(sheet.map((row) => row.netSalary)),
    );
    const currentNetSalary = netSalaryByMonth[netSalaryByMonth.length - 1];

    // 对外一律 toMoneyString：buildSummary 契约上已是两位小数串，这里再规范化一次，
    // 保证即使上游口径变动，响应也不会漏出 '50' 这种非两位小数。
    return [
      {
        key: 'incomeCash',
        label: '实收现金',
        current: toMoneyString(current.incomeCash),
        ytd: sum(summaries.map((row) => row.incomeCash)),
      },
      {
        key: 'incomeConsumption',
        label: '课时消费',
        current: toMoneyString(current.incomeConsumption),
        ytd: sum(summaries.map((row) => row.incomeConsumption)),
      },
      {
        key: 'expense',
        label: '支出',
        current: toMoneyString(current.expenseOperating),
        ytd: sum(summaries.map((row) => row.expenseOperating)),
      },
      {
        key: 'profit',
        label: '盈利',
        current: toMoneyString(current.profit),
        ytd: sum(summaries.map((row) => row.profit)),
      },
      {
        key: 'cashBalance',
        label: '现金结余',
        current: toMoneyString(current.cashBalance),
        // 见方法注释：存量取时点值，不求和。
        ytd: toMoneyString(current.cashBalance),
      },
      {
        key: 'netSalary',
        label: '实发工资',
        current: toMoneyString(currentNetSalary),
        ytd: toMoneyString(sumMoney(netSalaryByMonth)),
      },
    ];
  }

  // ── OV-02 收入 / 支出构成 ────────────────────────────────────────────

  /**
   * 收入构成按 `month.cash + month.consumption` 展开（同一收入项的两个口径合并展示），
   * 支出构成按经营口径 `month.operating`。金额为 0 的行不返回。
   * 排序在服务端做，降序，前端不自己排。
   */
  async buildComposition(period: Period): Promise<OverviewComposition> {
    const [incomeRows, expenseRows] = await Promise.all([
      this.finance.buildIncomeStatement(period),
      this.finance.buildExpenseStatement(period),
    ]);

    return {
      income: this.toSlice(
        incomeRows.map((row) => ({
          name: row.name,
          amount: money(row.month.cash).plus(money(row.month.consumption)),
        })),
      ),
      expense: this.toSlice(
        expenseRows.map((row) => ({ name: row.name, amount: money(row.month.operating) })),
      ),
    };
  }

  // ── OV-03 近 12 个月盈利趋势 ─────────────────────────────────────────

  /**
   * 近 12 个月（含 period）的盈利。**无任何记录的月份跳过** ——
   * 空月份画进趋势图会造出一条「盈利 0」的假折线，看起来像零收入零支出。
   */
  async buildProfitTrend(period: Period): Promise<ProfitTrendPoint[]> {
    const points: ProfitTrendPoint[] = [];
    for (const month of lastPeriods(period, 12)) {
      if (!(await this.hasData(month))) continue;
      const summary = await this.finance.buildSummary(month);
      points.push({ period: month, profit: toMoneyString(summary.profit) });
    }
    return points;
  }

  // ── OV-04 利润分配展示 ───────────────────────────────────────────────

  /**
   * 利润分配（本月）= **上月盈利** × 各分配人比例。
   * 本月才产生的利润要下个月才分配，所以取 prevPeriod(period) 的盈利。
   * ratio 原样输出 4 位小数（如 0.1500），不乘 100 —— 展示成百分比是前端的事。
   */
  async buildProfitShare(period: Period): Promise<ProfitShareDisplay> {
    const lastMonth = prevPeriod(period);
    const [rules, summary] = await Promise.all([
      this.organization.listProfitShares(),
      this.finance.buildSummary(lastMonth),
    ]);

    const totalProfit = money(summary.profit);
    return {
      totalProfit: toMoneyString(totalProfit),
      shares: rules.map((rule) => ({
        name: rule.name,
        ratio: money(rule.ratio).toFixed(4),
        amount: toMoneyString(multiplyMoney(totalProfit, rule.ratio)),
      })),
    };
  }

  // ── 内部工具 ────────────────────────────────────────────────────────

  private toSlice(rows: { name: string; amount: Money }[]): CompositionSlice {
    const items = rows
      .filter((row) => row.amount.greaterThan(ZERO))
      .sort((a, b) => b.amount.comparedTo(a.amount))
      .map((row) => ({ name: row.name, amount: toMoneyString(row.amount) }));
    return { items, total: toMoneyString(sumMoney(items.map((item) => item.amount))) };
  }

  /**
   * 该月是否有任何经营记录（台账流水 / 手工补录 / 其它支出 / 工资 / 退费）。
   * 已确认课必然产生台账流水，所以不必单独数 lesson。
   */
  private async hasData(period: Period): Promise<boolean> {
    const { start, end } = periodRange(period);
    const [ledger, manual, other, payroll, refund] = await Promise.all([
      this.prisma.ledgerEntry.count({ where: { occurredAt: { gte: start, lt: end } } }),
      this.prisma.manualIncome.count({ where: { period } }),
      this.prisma.otherExpense.count({ where: { period } }),
      this.prisma.payroll.count({ where: { period } }),
      this.prisma.refundRecord.count({ where: { occurredAt: { gte: start, lt: end } } }),
    ]);
    return ledger + manual + other + payroll + refund > 0;
  }
}
