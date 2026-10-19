import { Injectable } from '@nestjs/common';
import { LedgerEntryKind, ManualTransactionKind, PayrollStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type MonthlyReport = {
  periodStart: Date;
  cashIncome: string; cashExpense: string; cashNet: string;
  lessonIncome: string; refundFeeIncome: string; manualIncome: string;
  payrollCost: string; giftCost: string; manualExpense: string; operatingProfit: string;
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
      this.prisma.ledgerEntry.findMany({ where: { kind: { in: [LedgerEntryKind.LESSON_CONSUMPTION, LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL] }, occurredAt: occurredInPeriod }, select: { paidDelta: true, giftDelta: true } }),
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
    return { periodStart, cashIncome: cashIncome.toFixed(2), cashExpense: cashExpense.toFixed(2), cashNet: cashIncome.sub(cashExpense).toFixed(2), lessonIncome: lessonIncome.toFixed(2), refundFeeIncome: refundFeeIncome.toFixed(2), manualIncome: manualIncome.toFixed(2), payrollCost: payrollCost.toFixed(2), giftCost: giftCost.toFixed(2), manualExpense: manualExpense.toFixed(2), operatingProfit: operatingIncome.sub(operatingExpense).toFixed(2) };
  }
}
