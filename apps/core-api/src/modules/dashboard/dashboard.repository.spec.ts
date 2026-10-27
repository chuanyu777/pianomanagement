import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { DashboardRepository } from './dashboard.repository.js';

describe('DashboardRepository', () => {
  it('counts distinct students with negative paid balances and returns recent decimal facts', async () => {
    const prisma = {
      studentCourseAccount: { findMany: vi.fn().mockResolvedValue([
        { studentId: 's1', openingPaidBalance: new Prisma.Decimal('10.00'), ledgerEntries: [{ paidDelta: new Prisma.Decimal('-20.00') }] },
        { studentId: 's1', openingPaidBalance: new Prisma.Decimal('-5.00'), ledgerEntries: [] },
        { studentId: 's2', openingPaidBalance: new Prisma.Decimal('5.00'), ledgerEntries: [] },
      ]) },
      ledgerEntry: { findMany: vi.fn().mockResolvedValue([{ id: 'entry', kind: 'PAYMENT', occurredAt: new Date('2026-10-26T00:00:00Z'), paidDelta: new Prisma.Decimal('12.30'), giftDelta: new Prisma.Decimal('0'), account: { student: { name: '小雨' }, course: { name: '钢琴' } } }]) },
    };
    const result = await new DashboardRepository(prisma as never).ownerFacts();
    expect(result).toEqual({ arrearsCount: 1, recentRecords: [{ id: 'entry', kind: 'PAYMENT', occurredAt: '2026-10-26T00:00:00.000Z', studentName: '小雨', courseName: '钢琴', paidDelta: '12.30', giftDelta: '0.00' }] });
    expect(prisma.studentCourseAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { student: { withdrawnAt: null } } }));
    expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });
});
