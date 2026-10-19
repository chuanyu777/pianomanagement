import { BadRequestException, ConflictException } from '@nestjs/common';
import { PayrollStatus, Prisma } from '../src/generated/prisma/client.js';
import { PayrollService } from '../src/modules/payroll/payroll.service.js';
import { describe, expect, it, vi } from 'vitest';

const periodStart = new Date('2026-10-01T00:00:00.000Z');
const paidAt = new Date('2026-11-02T03:00:00.000Z');

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payroll-1', teacherId: 'teacher-1', teacher: { name: '李老师' }, periodStart,
    courseRevenue: new Prisma.Decimal('50.00'), baseSalary: new Prisma.Decimal('100.00'),
    commissionRate: new Prisma.Decimal('10.0000'), commissionAmount: new Prisma.Decimal('5.00'),
    bonusAmount: new Prisma.Decimal('10.00'), bonusNote: '代课奖金',
    deductionAmount: new Prisma.Decimal('2.00'), deductionNote: '教材代扣',
    grossSalary: new Prisma.Decimal('115.00'), netSalary: new Prisma.Decimal('113.00'),
    status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, paymentNote: null, version: 1,
    ...overrides,
  };
}

describe('PayrollService', () => {
  it('generates from completed lesson price snapshots and copies default Decimal salary settings', async () => {
    const created = record({ bonusAmount: new Prisma.Decimal('0'), grossSalary: new Prisma.Decimal('105.00'), netSalary: new Prisma.Decimal('105.00') });
    const tx = {
      teacher: { findUnique: vi.fn().mockResolvedValue({ defaultBaseSalary: new Prisma.Decimal('100.00'), defaultCommissionRate: new Prisma.Decimal('10.0000') }) },
      lesson: { aggregate: vi.fn().mockResolvedValue({ _sum: { unitPriceSnapshot: new Prisma.Decimal('50.05') } }) },
      payroll: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...created, ...data })) },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockResolvedValue(undefined) };
    const service = new PayrollService(prisma as never, periods as never);

    await expect(service.generate({ teacherId: 'teacher-1', periodStart, actorId: 'owner-1' })).resolves.toMatchObject({
      courseRevenue: '50.05', commissionRate: '10.0000', commissionAmount: '5.01', baseSalary: '100.00',
    });
    expect(periods.assertWritableForDate).toHaveBeenCalledWith(periodStart);
    expect(tx.lesson.aggregate).toHaveBeenCalledWith({
      where: { teacherId: 'teacher-1', status: 'COMPLETED', completedAt: { gte: new Date('2026-09-30T16:00:00.000Z'), lt: new Date('2026-10-31T16:00:00.000Z') } },
      _sum: { unitPriceSnapshot: true },
    });
    expect(tx.payroll.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      courseRevenue: expect.any(Prisma.Decimal), commissionAmount: expect.any(Prisma.Decimal),
      grossSalary: expect.any(Prisma.Decimal), netSalary: expect.any(Prisma.Decimal),
    }), select: expect.any(Object) });
    const payrollData = tx.payroll.create.mock.calls[0]?.[0].data;
    expect(payrollData).toBeDefined();
    if (!payrollData) throw new Error('Expected payroll creation data');
    expect((payrollData.commissionAmount as Prisma.Decimal).eq('5.01')).toBe(true);
  });

  it('calculates gross salary with bonus and net salary after deduction using Decimal arithmetic', async () => {
    const update = vi.fn().mockResolvedValue(record());
    const tx = {
      payroll: {
        findUnique: vi.fn().mockResolvedValue({ periodStart, courseRevenue: new Prisma.Decimal('50.00'), status: PayrollStatus.UNPAID }),
        update,
      },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const service = new PayrollService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    await expect(service.update('payroll-1', {
      baseSalary: new Prisma.Decimal('100.00'), commissionRate: new Prisma.Decimal('10.0000'),
      bonusAmount: new Prisma.Decimal('10.00'), bonusNote: '  代课奖金  ',
      deductionAmount: new Prisma.Decimal('2.00'), deductionNote: '  教材代扣  ', actorId: 'owner-1',
    })).resolves.toMatchObject({ grossSalary: '115.00', netSalary: '113.00' });
    const data = update.mock.calls[0]?.[0].data;
    expect(data.grossSalary.eq('115.00')).toBe(true);
    expect(data.netSalary.eq('113.00')).toBe(true);
    expect(data.bonusNote).toBe('代课奖金');
    expect(data.deductionNote).toBe('教材代扣');
  });

  it('requires notes for positive bonus and deduction, prevents negative inputs and negative net salary', async () => {
    const tx = {
      payroll: {
        findUnique: vi.fn().mockResolvedValue({ periodStart, courseRevenue: new Prisma.Decimal('0.00'), status: PayrollStatus.UNPAID }),
        update: vi.fn(),
      },
    };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const service = new PayrollService(prisma as never, { assertWritableForDate: vi.fn() } as never);
    const input = {
      baseSalary: new Prisma.Decimal('100.00'), commissionRate: new Prisma.Decimal('0.0000'),
      bonusAmount: new Prisma.Decimal('1.00'), deductionAmount: new Prisma.Decimal('0.00'), actorId: 'owner-1',
    };

    await expect(service.update('payroll-1', input)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('payroll-1', { ...input, bonusNote: '奖金', deductionAmount: new Prisma.Decimal('1.00') }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('payroll-1', { ...input, bonusNote: '奖金', baseSalary: new Prisma.Decimal('-1.00') }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('payroll-1', { ...input, bonusNote: '奖金', deductionAmount: new Prisma.Decimal('102.00'), deductionNote: '扣款' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.payroll.update).not.toHaveBeenCalled();
  });

  it('records actual payment date and channel, then allows a single cancellation', async () => {
    let currentStatus = PayrollStatus.UNPAID;
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      currentStatus = data.status as typeof currentStatus;
      return record({ status: currentStatus, paidAt: data.paidAt ?? null, paymentChannel: data.paymentChannel ?? null });
    });
    const tx = { payroll: {
      findUnique: vi.fn(async () => ({ periodStart, status: currentStatus })), update,
    } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockResolvedValue(undefined) };
    const service = new PayrollService(prisma as never, periods as never);

    await expect(service.pay('payroll-1', { paidAt, channel: 'WECHAT', note: '月薪', actorId: 'owner-1' }))
      .resolves.toMatchObject({ status: PayrollStatus.PAID, paidAt, paymentChannel: 'WECHAT' });
    await expect(service.cancelPayment('payroll-1')).resolves.toMatchObject({ status: PayrollStatus.UNPAID, paidAt: null });
    expect(update.mock.calls[0]?.[0].data).toMatchObject({ paidAt, paymentChannel: 'WECHAT', paidById: 'owner-1' });
    expect(update.mock.calls[1]?.[0].data).toMatchObject({ paidAt: null, paymentChannel: null, paidById: null });
    expect(periods.assertWritableForDate).toHaveBeenCalledTimes(2);
  });

  it('does not pay with OTHER channel without a note or change a closed payroll period', async () => {
    const update = vi.fn();
    const tx = { payroll: {
      findUnique: vi.fn().mockResolvedValue({ periodStart, status: PayrollStatus.UNPAID }), update,
    } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockRejectedValue(new ConflictException()) };
    const service = new PayrollService(prisma as never, periods as never);

    await expect(service.pay('payroll-1', { paidAt, channel: 'OTHER', actorId: 'owner-1' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.pay('payroll-1', { paidAt, channel: 'CASH', actorId: 'owner-1' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});
