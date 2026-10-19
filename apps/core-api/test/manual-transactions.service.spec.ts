import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, ManualTransactionKind, ManualIncomeCategory, ManualExpenseCategory } from '../src/generated/prisma/client.js';
import { ManualTransactionsService } from '../src/modules/manual-transactions/manual-transactions.service.js';
import { describe, expect, it, vi } from 'vitest';

const createdAt = new Date('2026-10-17T02:00:00.000Z');
const baseInput = {
  kind: ManualTransactionKind.INCOME,
  incomeCategory: ManualIncomeCategory.BOOK_SALE,
  amount: new Prisma.Decimal('123.40'),
  channel: 'CASH' as const,
  occurredAt: createdAt,
  createdById: 'owner-1',
};

describe('ManualTransactionsService', () => {
  it('records an allowed manual income as Decimal, normalized to a two-decimal response, inside the writable-period transaction', async () => {
    const record = {
      id: 'manual-1', ...baseInput, expenseCategory: null, note: null, createdAt,
    };
    const tx = { manualTransaction: { create: vi.fn().mockResolvedValue(record) } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockResolvedValue(undefined) };
    const service = new ManualTransactionsService(prisma as never, periods as never);

    await expect(service.create(baseInput)).resolves.toMatchObject({ amount: '123.40', note: null });
    expect(periods.assertWritableForDate).toHaveBeenCalledWith(createdAt, tx);
    expect(tx.manualTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      amount: expect.any(Prisma.Decimal), incomeCategory: ManualIncomeCategory.BOOK_SALE,
      expenseCategory: null, createdById: 'owner-1',
    }) });
  });

  it('rejects zero or negative amounts, mismatched categories, and OTHER channel without a note', async () => {
    const tx = { manualTransaction: { create: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const service = new ManualTransactionsService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    await expect(service.create({ ...baseInput, amount: new Prisma.Decimal('0.00') })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ ...baseInput, amount: new Prisma.Decimal('-1.00') })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ ...baseInput, expenseCategory: ManualExpenseCategory.RENT_PROPERTY })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ ...baseInput, incomeCategory: undefined })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ ...baseInput, channel: 'OTHER' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.manualTransaction.create).not.toHaveBeenCalled();
  });

  it('does not write a transaction in a closed month', async () => {
    const tx = { manualTransaction: { create: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockRejectedValue(new ConflictException()) };
    const service = new ManualTransactionsService(prisma as never, periods as never);

    await expect(service.create(baseInput)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.manualTransaction.create).not.toHaveBeenCalled();
  });

  it('lists using an inclusive start and exclusive end date range', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ManualTransactionsService({ manualTransaction: { findMany } } as never, {} as never);
    const from = new Date('2026-10-01T00:00:00.000Z');
    const to = new Date('2026-11-01T00:00:00.000Z');

    await expect(service.list(from, to)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith({
      where: { occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
  });
});
