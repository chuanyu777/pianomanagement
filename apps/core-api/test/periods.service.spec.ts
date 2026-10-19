import { ConflictException, NotFoundException } from '@nestjs/common';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { describe, expect, it, vi } from 'vitest';

const ownerId = 'owner-1';

describe('PeriodsService', () => {
  it('uses the Shanghai business month when checking whether a date is writable', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'closed-period' });
    const service = new PeriodsService({ closedPeriod: { findFirst } } as never);

    await expect(service.assertWritableForDate(new Date('2026-10-31T16:30:00.000Z')))
      .rejects.toBeInstanceOf(ConflictException);
    expect(findFirst).toHaveBeenCalledWith({
      where: { periodStart: new Date('2026-11-01T00:00:00.000Z'), reopenedAt: null },
      select: { id: true },
    });
  });

  it('reopens only the most recently closed period, even when periods were closed out of calendar order', async () => {
    const target = { id: 'october', reopenedAt: null };
    const tx = {
      closedPeriod: {
        findUnique: vi.fn().mockResolvedValue(target),
        findFirst: vi.fn().mockResolvedValue({ id: 'october' }),
        update: vi.fn().mockResolvedValue({
          periodStart: new Date('2026-10-01T00:00:00.000Z'),
          closedAt: new Date('2026-10-20T10:00:00.000Z'),
          reopenedAt: new Date('2026-10-21T10:00:00.000Z'),
          reopenReason: '  补录记录  ',
        }),
      },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const service = new PeriodsService(prisma as never);

    await expect(service.reopen(new Date('2026-10-01T00:00:00.000Z'), '  补录记录  ', ownerId))
      .resolves.toMatchObject({ reopenReason: '  补录记录  ' });
    expect(tx.closedPeriod.findFirst).toHaveBeenCalledWith({
      where: { reopenedAt: null },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });
    expect(tx.closedPeriod.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'october' },
      data: expect.objectContaining({ reopenedById: ownerId, reopenReason: '补录记录' }),
    }));
  });

  it('rejects reopening an older period and distinguishes missing or already reopened periods', async () => {
    const tx = {
      closedPeriod: {
        findUnique: vi.fn().mockResolvedValue({ id: 'september', reopenedAt: null }),
        findFirst: vi.fn().mockResolvedValue({ id: 'october' }),
        update: vi.fn(),
      },
    };
    const service = new PeriodsService({
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as never);

    await expect(service.reopen(new Date('2026-09-01T00:00:00.000Z'), '理由', ownerId))
      .rejects.toBeInstanceOf(ConflictException);
    tx.closedPeriod.findUnique.mockResolvedValueOnce(null);
    await expect(service.reopen(new Date('2026-09-01T00:00:00.000Z'), '理由', ownerId))
      .rejects.toBeInstanceOf(NotFoundException);
    tx.closedPeriod.findUnique.mockResolvedValueOnce({ id: 'september', reopenedAt: new Date() });
    await expect(service.reopen(new Date('2026-09-01T00:00:00.000Z'), '理由', ownerId))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.closedPeriod.update).not.toHaveBeenCalled();
  });

  it('allows reopening the previous still-closed month after the latest month has already been reopened', async () => {
    const tx = {
      closedPeriod: {
        findUnique: vi.fn().mockResolvedValue({ id: 'september', reopenedAt: null }),
        findFirst: vi.fn().mockResolvedValue({ id: 'september' }),
        update: vi.fn().mockResolvedValue({
          periodStart: new Date('2026-09-01T00:00:00.000Z'), closedAt: new Date('2026-09-15T00:00:00.000Z'),
          reopenedAt: new Date('2026-10-22T00:00:00.000Z'), reopenReason: '修正',
        }),
      },
    };
    const service = new PeriodsService({
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as never);

    await expect(service.reopen(new Date('2026-09-01T00:00:00.000Z'), '修正', ownerId))
      .resolves.toMatchObject({ reopenReason: '修正' });
    expect(tx.closedPeriod.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { reopenedAt: null } }));
  });
});
