import { LedgerEntryKind, ManualTransactionKind, PayrollStatus, Prisma } from '../src/generated/prisma/client.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { describe, expect, it, vi } from 'vitest';

const periodStart = new Date('2026-10-01T00:00:00.000Z');
const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('ReportsService', () => {
  it('returns a complete day cash ledger, retains reversals in the original collection period, and aggregates authoritative amounts', async () => {
    const range = { start: new Date('2026-10-26T16:00:00.000Z'), end: new Date('2026-10-27T16:00:00.000Z') };
    const prisma = {
      paymentRecord: { findMany: vi.fn().mockResolvedValue([
        { id: 'pay-live', amount: decimal('120.00'), occurredAt: new Date('2026-10-27T01:00:00Z'), channel: 'CASH', note: null, account: { student: { name: '小雨' }, course: { name: '钢琴课' } }, ledgerEntry: { reversedBy: null } },
        { id: 'pay-reversed', amount: decimal('50.00'), occurredAt: new Date('2026-10-27T02:00:00Z'), channel: 'CASH', note: '误录', account: { student: { name: '小林' }, course: { name: '钢琴课' } }, ledgerEntry: { reversedBy: { id: 'reversal-1', occurredAt: new Date('2026-11-02T01:00:00Z') } } },
      ]) },
      refundRecord: { findMany: vi.fn().mockResolvedValue([{ id: 'refund-1', actualRefundAmount: decimal('81.00'), totalPaidRefund: decimal('90.00'), feeAmount: decimal('9.00'), occurredAt: new Date('2026-10-27T03:00:00Z'), channel: 'BANK_TRANSFER', note: null, student: { name: '小周' } }]) },
      payroll: { findMany: vi.fn().mockResolvedValue([{ id: 'payroll-1', netSalary: decimal('70.50'), paidAt: new Date('2026-10-27T04:00:00Z'), paymentChannel: 'BANK_TRANSFER', paymentNote: '十月工资', teacher: { name: '王老师' } }]) },
      manualTransaction: { findMany: vi.fn().mockResolvedValue([
        { id: 'manual-in', kind: ManualTransactionKind.INCOME, incomeCategory: 'BOOK_SALE', expenseCategory: null, amount: decimal('20.00'), occurredAt: new Date('2026-10-27T05:00:00Z'), channel: 'CASH', note: null },
        { id: 'manual-out', kind: ManualTransactionKind.EXPENSE, incomeCategory: null, expenseCategory: 'RENT_PROPERTY', amount: decimal('12.00'), occurredAt: new Date('2026-10-27T06:00:00Z'), channel: 'CASH', note: '房租' },
      ]) },
    };

    const result = await new ReportsService(prisma as never).cashFlow({ range, periodType: 'DAY', period: '2026-10-27' });

    expect(result).toMatchObject({
      periodType: 'DAY', period: '2026-10-27', cashIncome: '190.00', cashExpense: '163.50', cashNet: '26.50',
      items: [
        { id: 'manual-out', type: 'MANUAL_EXPENSE', direction: 'EXPENSE', amount: '12.00', category: 'RENT_PROPERTY' },
        { id: 'manual-in', type: 'MANUAL_INCOME', direction: 'INCOME', amount: '20.00', category: 'BOOK_SALE' },
        { id: 'payroll-1', type: 'PAYROLL', direction: 'EXPENSE', amount: '70.50', counterparty: '王老师' },
        { id: 'refund-1', type: 'REFUND', direction: 'EXPENSE', amount: '81.00', counterparty: '小周', feeAmount: '9.00' },
        { id: 'pay-reversed', type: 'PAYMENT', direction: 'INCOME', amount: '50.00', reversal: { ledgerEntryId: 'reversal-1', occurredAt: new Date('2026-11-02T01:00:00Z') } },
        { id: 'pay-live', type: 'PAYMENT', direction: 'INCOME', amount: '120.00', counterparty: '小雨 · 钢琴课' },
      ],
    });
    expect(result.items.find(({ id }) => id === 'pay-reversed')?.reversal).toMatchObject({ ledgerEntryId: 'reversal-1' });
    expect(prisma.paymentRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { occurredAt: { gte: range.start, lt: range.end } }, select: expect.objectContaining({ ledgerEntry: { select: { reversedBy: { select: { id: true, occurredAt: true } } } } }) }));
    expect(prisma.refundRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { occurredAt: { gte: range.start, lt: range.end } } }));
    expect(prisma.payroll.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: PayrollStatus.PAID, paidAt: { gte: range.start, lt: range.end } } }));
    expect(prisma.manualTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { occurredAt: { gte: range.start, lt: range.end } } }));
  });

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
      payrollCost: '115.00', giftCost: '12.00', manualExpense: '8.00', operatingExpense: '135.00', operatingProfit: '-65.00',
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
      where: { kind: { in: [LedgerEntryKind.LESSON_CONSUMPTION, LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL, LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION] }, occurredAt: { gte: start, lt: end } },
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
      manualExpense: '0.00', operatingExpense: '0.00', operatingProfit: '0.00',
    });
  });
});
