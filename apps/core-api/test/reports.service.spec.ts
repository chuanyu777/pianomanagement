import { LedgerEntryKind, ManualTransactionKind, PayrollStatus, Prisma } from '../src/generated/prisma/client.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { describe, expect, it, vi } from 'vitest';

const periodStart = new Date('2026-10-01T00:00:00.000Z');
const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('ReportsService', () => {
  it('computes cash flow by payment date and operating result from ledger, payroll, gifts, refunds and all manual activity', async () => {
    const prisma = {
      paymentRecord: { findMany: vi.fn().mockResolvedValue([{ amount: decimal('100.00') }]) },
      refundRecord: { findMany: vi.fn().mockResolvedValue([{ actualRefundAmount: decimal('30.00'), feeAmount: decimal('5.00') }]) },
      manualTransaction: { findMany: vi.fn().mockResolvedValue([
        { kind: ManualTransactionKind.INCOME, amount: decimal('20.00') },
        { kind: ManualTransactionKind.EXPENSE, amount: decimal('8.00') },
      ]) },
      payroll: { findMany: vi.fn()
        .mockResolvedValueOnce([{ netSalary: decimal('70.00') }])
        .mockResolvedValueOnce([{ grossSalary: decimal('115.00') }]) },
      giftRecord: { findMany: vi.fn().mockResolvedValue([{ amount: decimal('12.00') }]) },
      ledgerEntry: { findMany: vi.fn().mockResolvedValue([
        { kind: LedgerEntryKind.LESSON_CONSUMPTION, paidDelta: decimal('-30.00'), giftDelta: decimal('-20.00') },
        { kind: LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL, paidDelta: decimal('5.00'), giftDelta: decimal('0.00') },
      ]) },
    };
    const service = new ReportsService(prisma as never);

    await expect(service.monthly(periodStart)).resolves.toEqual({
      periodStart,
      cashIncome: '120.00', cashExpense: '108.00', cashNet: '12.00',
      lessonIncome: '45.00', refundFeeIncome: '5.00', manualIncome: '20.00',
      payrollCost: '115.00', giftCost: '12.00', manualExpense: '8.00', operatingProfit: '-65.00',
    });
    const start = new Date('2026-09-30T16:00:00.000Z');
    const end = new Date('2026-10-31T16:00:00.000Z');
    expect(prisma.paymentRecord.findMany).toHaveBeenCalledWith({ where: { occurredAt: { gte: start, lt: end } }, select: { amount: true } });
    expect(prisma.payroll.findMany).toHaveBeenNthCalledWith(1, {
      where: { status: PayrollStatus.PAID, paidAt: { gte: start, lt: end } },
      select: { netSalary: true },
    });
    expect(prisma.payroll.findMany).toHaveBeenNthCalledWith(2, { where: { periodStart }, select: { grossSalary: true } });
    expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith({
      where: { kind: { in: [LedgerEntryKind.LESSON_CONSUMPTION, LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL] }, occurredAt: { gte: start, lt: end } },
      select: { paidDelta: true, giftDelta: true },
    });
  });

  it('returns two-decimal zero totals when the month has no activity', async () => {
    const empty = vi.fn().mockResolvedValue([]);
    const service = new ReportsService({
      paymentRecord: { findMany: empty }, refundRecord: { findMany: empty }, manualTransaction: { findMany: empty },
      payroll: { findMany: empty }, giftRecord: { findMany: empty }, ledgerEntry: { findMany: empty },
    } as never);

    await expect(service.monthly(periodStart)).resolves.toMatchObject({
      cashIncome: '0.00', cashExpense: '0.00', cashNet: '0.00', lessonIncome: '0.00',
      refundFeeIncome: '0.00', manualIncome: '0.00', payrollCost: '0.00', giftCost: '0.00',
      manualExpense: '0.00', operatingProfit: '0.00',
    });
  });
});
