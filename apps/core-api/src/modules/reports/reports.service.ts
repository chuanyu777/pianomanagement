import { Injectable } from '@nestjs/common';
import { LedgerEntryKind, ManualTransactionKind, PayrollStatus, Prisma, type ManualExpenseCategory, type ManualIncomeCategory, type PaymentChannel } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type MonthlyReport = {
  periodStart: Date;
  cashIncome: string; cashExpense: string; cashNet: string;
  lessonIncome: string; refundFeeIncome: string; manualIncome: string;
  payrollCost: string; giftCost: string; manualExpense: string; operatingExpense: string; operatingProfit: string;
};
export type CashFlowItem = {
  id: string;
  type: 'PAYMENT' | 'REFUND' | 'PAYROLL' | 'MANUAL_INCOME' | 'MANUAL_EXPENSE';
  direction: 'INCOME' | 'EXPENSE';
  occurredAt: Date;
  amount: string;
  channel: PaymentChannel | null;
  note: string | null;
  counterparty: string | null;
  category: ManualIncomeCategory | ManualExpenseCategory | null;
  reversal?: { ledgerEntryId: string; occurredAt: Date };
  feeAmount?: string;
  totalPaidRefund?: string;
};
export type CashFlowReport = {
  periodType: 'DAY' | 'MONTH';
  period: string;
  rangeStart: Date;
  rangeEnd: Date;
  cashIncome: string;
  cashExpense: string;
  cashNet: string;
  items: CashFlowItem[];
};
function businessMonthRange(start: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return { start: new Date(monthStart - offset), end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - offset) };
}
function sum(values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal { return values.reduce<Prisma.Decimal>((total, value) => total.add(value ?? new Prisma.Decimal(0)), new Prisma.Decimal(0)); }

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}
  async monthly(periodStart: Date): Promise<MonthlyReport> {
    const range = businessMonthRange(periodStart);
    const occurredInPeriod = { gte: range.start, lt: range.end };
    const [payments, refunds, manuals, paidPayrolls, payrolls, gifts, consumptions] = await Promise.all([
      this.prisma.paymentRecord.findMany({ where: { occurredAt: occurredInPeriod }, select: { amount: true } }),
      this.prisma.refundRecord.findMany({ where: { occurredAt: occurredInPeriod }, select: { actualRefundAmount: true, feeAmount: true } }),
      this.prisma.manualTransaction.findMany({ where: { occurredAt: occurredInPeriod }, select: { kind: true, amount: true } }),
      this.prisma.payroll.findMany({ where: { status: PayrollStatus.PAID, paidAt: occurredInPeriod }, select: { netSalary: true } }),
      this.prisma.payroll.findMany({ where: { periodStart }, select: { grossSalary: true } }),
      this.prisma.giftRecord.findMany({ where: { occurredAt: occurredInPeriod }, select: { amount: true } }),
      this.prisma.ledgerEntry.findMany({ where: { kind: { in: [LedgerEntryKind.LESSON_CONSUMPTION, LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL, LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION] }, occurredAt: occurredInPeriod }, select: { paidDelta: true, giftDelta: true } }),
    ]);
    const manualIncome = sum(manuals.filter((x) => x.kind === ManualTransactionKind.INCOME).map((x) => x.amount));
    const manualExpense = sum(manuals.filter((x) => x.kind === ManualTransactionKind.EXPENSE).map((x) => x.amount));
    const paymentIncome = sum(payments.map((x) => x.amount));
    const actualRefund = sum(refunds.map((x) => x.actualRefundAmount));
    const paidSalary = sum(paidPayrolls.map((x) => x.netSalary));
    const payrollCost = sum(payrolls.map((x) => x.grossSalary));
    const giftCost = sum(gifts.map((x) => x.amount));
    const refundFeeIncome = sum(refunds.map((x) => x.feeAmount));
    const lessonIncome = sum(consumptions.map((x) => x.paidDelta.add(x.giftDelta).negated()));
    const cashIncome = paymentIncome.add(manualIncome);
    const cashExpense = actualRefund.add(paidSalary).add(manualExpense);
    const operatingIncome = lessonIncome.add(refundFeeIncome).add(manualIncome);
    const operatingExpense = payrollCost.add(giftCost).add(manualExpense);
    return { periodStart, cashIncome: cashIncome.toFixed(2), cashExpense: cashExpense.toFixed(2), cashNet: cashIncome.sub(cashExpense).toFixed(2), lessonIncome: lessonIncome.toFixed(2), refundFeeIncome: refundFeeIncome.toFixed(2), manualIncome: manualIncome.toFixed(2), payrollCost: payrollCost.toFixed(2), giftCost: giftCost.toFixed(2), manualExpense: manualExpense.toFixed(2), operatingExpense: operatingExpense.toFixed(2), operatingProfit: operatingIncome.sub(operatingExpense).toFixed(2) };
  }

  async cashFlow(input: {
    periodType: 'DAY' | 'MONTH';
    period: string;
    range: { start: Date; end: Date };
  }): Promise<CashFlowReport> {
    const occurredAt = { gte: input.range.start, lt: input.range.end };
    const [payments, refunds, payrolls, manuals] = await Promise.all([
      this.prisma.paymentRecord.findMany({
        where: { occurredAt },
        select: {
          id: true, amount: true, occurredAt: true, channel: true, note: true,
          account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } },
          ledgerEntry: { select: { reversedBy: { select: { id: true, occurredAt: true } } } },
        },
      }),
      this.prisma.refundRecord.findMany({
        where: { occurredAt },
        select: { id: true, actualRefundAmount: true, totalPaidRefund: true, feeAmount: true, occurredAt: true, channel: true, note: true, student: { select: { name: true } } },
      }),
      this.prisma.payroll.findMany({
        where: { status: PayrollStatus.PAID, paidAt: occurredAt },
        select: { id: true, netSalary: true, paidAt: true, paymentChannel: true, paymentNote: true, teacher: { select: { name: true } } },
      }),
      this.prisma.manualTransaction.findMany({
        where: { occurredAt },
        select: { id: true, kind: true, incomeCategory: true, expenseCategory: true, amount: true, occurredAt: true, channel: true, note: true },
      }),
    ]);

    const items: CashFlowItem[] = [
      ...payments.map((payment): CashFlowItem => ({
        id: payment.id, type: 'PAYMENT', direction: 'INCOME', occurredAt: payment.occurredAt,
        amount: payment.amount.toFixed(2), channel: payment.channel, note: payment.note,
        counterparty: `${payment.account.student.name} · ${payment.account.course.name}`, category: null,
        ...(payment.ledgerEntry?.reversedBy ? { reversal: { ledgerEntryId: payment.ledgerEntry.reversedBy.id, occurredAt: payment.ledgerEntry.reversedBy.occurredAt } } : {}),
      })),
      ...refunds.map((refund): CashFlowItem => ({
        id: refund.id, type: 'REFUND', direction: 'EXPENSE', occurredAt: refund.occurredAt,
        amount: refund.actualRefundAmount.toFixed(2), channel: refund.channel, note: refund.note,
        counterparty: refund.student.name, category: null, feeAmount: refund.feeAmount.toFixed(2), totalPaidRefund: refund.totalPaidRefund.toFixed(2),
      })),
      ...payrolls.filter((payroll) => payroll.paidAt !== null).map((payroll): CashFlowItem => ({
        id: payroll.id, type: 'PAYROLL', direction: 'EXPENSE', occurredAt: payroll.paidAt!,
        amount: payroll.netSalary.toFixed(2), channel: payroll.paymentChannel, note: payroll.paymentNote,
        counterparty: payroll.teacher.name, category: null,
      })),
      ...manuals.map((manual): CashFlowItem => ({
        id: manual.id,
        type: manual.kind === ManualTransactionKind.INCOME ? 'MANUAL_INCOME' : 'MANUAL_EXPENSE',
        direction: manual.kind === ManualTransactionKind.INCOME ? 'INCOME' : 'EXPENSE',
        occurredAt: manual.occurredAt, amount: manual.amount.toFixed(2), channel: manual.channel, note: manual.note,
        counterparty: null, category: manual.kind === ManualTransactionKind.INCOME ? manual.incomeCategory : manual.expenseCategory,
      })),
    ];
    items.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || left.id.localeCompare(right.id));

    const income = sum(items.filter((item) => item.direction === 'INCOME').map((item) => new Prisma.Decimal(item.amount)));
    const expense = sum(items.filter((item) => item.direction === 'EXPENSE').map((item) => new Prisma.Decimal(item.amount)));
    return {
      periodType: input.periodType,
      period: input.period,
      rangeStart: input.range.start,
      rangeEnd: input.range.end,
      cashIncome: income.toFixed(2),
      cashExpense: expense.toFixed(2),
      cashNet: income.sub(expense).toFixed(2),
      items,
    };
  }
}
