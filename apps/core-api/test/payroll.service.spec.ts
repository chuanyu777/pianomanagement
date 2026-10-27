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
    const update = vi.fn().mockResolvedValue(record({ grossSalary: new Prisma.Decimal('115.00'), netSalary: new Prisma.Decimal('113.00') }));
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

  it('includes bonus in gross salary for the frozen payroll acceptance example', async () => {
    const update = vi.fn().mockImplementation(async ({ data }: { data: Record<string, Prisma.Decimal> }) => record({
      courseRevenue: new Prisma.Decimal('1000.00'),
      baseSalary: data.baseSalary,
      commissionRate: data.commissionRate,
      commissionAmount: data.commissionAmount,
      bonusAmount: data.bonusAmount,
      deductionAmount: data.deductionAmount,
      grossSalary: data.grossSalary,
      netSalary: data.netSalary,
    }));
    const tx = {
      payroll: {
        findUnique: vi.fn().mockResolvedValue({ periodStart, courseRevenue: new Prisma.Decimal('1000.00'), status: PayrollStatus.UNPAID }),
        update,
      },
    };
    const service = new PayrollService({ $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) } as never, { assertWritableForDate: vi.fn() } as never);

    await expect(service.update('payroll-1', {
      baseSalary: new Prisma.Decimal('2000.00'), commissionRate: new Prisma.Decimal('10.0000'),
      bonusAmount: new Prisma.Decimal('100.00'), bonusNote: '月度奖励',
      deductionAmount: new Prisma.Decimal('50.00'), deductionNote: '代扣', actorId: 'owner-1',
    })).resolves.toMatchObject({
      commissionAmount: '100.00', grossSalary: '2200.00', netSalary: '2150.00',
    });
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

  it('previews a bonus adjustment with Decimal strings and applies it with the payroll version fence', async () => {
    const existing = record();
    const update = vi.fn().mockResolvedValue(record({ bonusAmount: new Prisma.Decimal('300.00'), bonusNote: '公开课奖励', grossSalary: new Prisma.Decimal('405.00'), netSalary: new Prisma.Decimal('403.00'), version: 2 }));
    const tx = { payroll: { findUnique: vi.fn().mockResolvedValue(existing), update } };
    const prisma = {
      payroll: { findUnique: vi.fn().mockResolvedValue(existing) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const periods = { assertWritableForDate: vi.fn().mockResolvedValue(undefined) };
    const service = new PayrollService(prisma as never, periods as never);

    await expect(service.previewAdjust({ payrollId: 'payroll-1', bonusAmount: new Prisma.Decimal('300.00'), bonusNote: ' 公开课奖励 ', actorId: 'owner-1' }))
      .resolves.toMatchObject({ beforeBonusAmount: '10.00', afterBonusAmount: '300.00', beforeDeductionAmount: '2.00', afterDeductionAmount: '2.00', payroll: { grossSalary: '405.00', netSalary: '403.00', version: 2 } });
    expect(update).not.toHaveBeenCalled();

    await expect(service.adjustInTransaction(tx as never, 'payroll-1', { bonusAmount: new Prisma.Decimal('300.00'), bonusNote: '公开课奖励', actorId: 'owner-1' }, 1))
      .resolves.toMatchObject({ bonusAmount: new Prisma.Decimal('300.00') });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bonusAmount: new Prisma.Decimal('300.00'), bonusNote: '公开课奖励', version: { increment: 1 } }),
    }));
  });

  it('partially adjusts base salary, commission rate, bonus and deduction together and recalculates all salary totals', async () => {
    const existing = record();
    const nextRecord = record({
      baseSalary: new Prisma.Decimal('250.00'),
      commissionRate: new Prisma.Decimal('12.5000'),
      commissionAmount: new Prisma.Decimal('6.25'),
      bonusAmount: new Prisma.Decimal('20.00'),
      bonusNote: '季度奖励',
      deductionAmount: new Prisma.Decimal('5.00'),
      deductionNote: '教材代扣',
      grossSalary: new Prisma.Decimal('276.25'),
      netSalary: new Prisma.Decimal('271.25'),
      version: 2,
    });
    const update = vi.fn().mockResolvedValue(nextRecord);
    const tx = { payroll: { findUnique: vi.fn().mockResolvedValue(existing), update } };
    const prisma = {
      payroll: { findUnique: vi.fn().mockResolvedValue(existing) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const service = new PayrollService(prisma as never, { assertWritableForDate: vi.fn().mockResolvedValue(undefined) } as never);
    const input = {
      baseSalary: new Prisma.Decimal('250.00'),
      commissionRate: new Prisma.Decimal('12.5000'),
      bonusAmount: new Prisma.Decimal('20.00'), bonusNote: ' 季度奖励 ',
      deductionAmount: new Prisma.Decimal('5.00'), deductionNote: ' 教材代扣 ',
      actorId: 'owner-1',
    };

    await expect(service.previewAdjust({ payrollId: 'payroll-1', ...input })).resolves.toMatchObject({
      payrollVersion: 1,
      payroll: {
        baseSalary: '250.00', commissionRate: '12.5000', commissionAmount: '6.25',
        bonusAmount: '20.00', deductionAmount: '5.00', grossSalary: '276.25', netSalary: '271.25', version: 2,
      },
    });
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', input, 1)).resolves.toMatchObject({
      baseSalary: new Prisma.Decimal('250.00'), commissionRate: new Prisma.Decimal('12.5000'),
      commissionAmount: new Prisma.Decimal('6.25'), grossSalary: new Prisma.Decimal('276.25'), netSalary: new Prisma.Decimal('271.25'),
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        baseSalary: new Prisma.Decimal('250.00'), commissionRate: new Prisma.Decimal('12.5000'),
        commissionAmount: new Prisma.Decimal('6.25'), bonusAmount: new Prisma.Decimal('20.00'), bonusNote: '季度奖励',
        deductionAmount: new Prisma.Decimal('5.00'), deductionNote: '教材代扣',
        version: { increment: 1 },
      }),
    }));
  });

  it('rejects invalid partial salary inputs without updating the payroll', async () => {
    const existing = record();
    const tx = { payroll: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn() } };
    const service = new PayrollService({
      payroll: { findUnique: vi.fn().mockResolvedValue(existing) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as never, { assertWritableForDate: vi.fn().mockResolvedValue(undefined) } as never);

    await expect(service.adjustInTransaction(tx as never, 'payroll-1', {
      baseSalary: new Prisma.Decimal('-0.01'), actorId: 'owner-1',
    }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', {
      commissionRate: new Prisma.Decimal('-0.0001'), actorId: 'owner-1',
    }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', {
      commissionRate: new Prisma.Decimal('1000.0000'), actorId: 'owner-1',
    }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', {
      baseSalary: new Prisma.Decimal('250.001'), actorId: 'owner-1',
    }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', {
      commissionRate: new Prisma.Decimal('12.50001'), actorId: 'owner-1',
    }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', { actorId: 'owner-1' }, 1))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.payroll.update).not.toHaveBeenCalled();
  });

  it('rejects a positive deduction adjustment without a note or with a stale version', async () => {
    const existing = record();
    const tx = { payroll: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn() } };
    const service = new PayrollService({ $transaction: vi.fn() } as never, { assertWritableForDate: vi.fn().mockResolvedValue(undefined) } as never);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', { deductionAmount: new Prisma.Decimal('30.00'), actorId: 'owner-1' }, 1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.adjustInTransaction(tx as never, 'payroll-1', { deductionAmount: new Prisma.Decimal('30.00'), deductionNote: '教材', actorId: 'owner-1' }, 2)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.payroll.update).not.toHaveBeenCalled();
  });

  it('cancels a paid payroll with a version fence and appends the original payment facts to audit history', async () => {
    let current = record();
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      current = record({
        ...current,
        ...data,
        paidAt: data.paidAt ?? null,
        paymentChannel: data.paymentChannel ?? null,
        paymentNote: data.paymentNote ?? null,
        paidById: data.paidById ?? null,
        version: current.version + 1,
      });
      return current;
    });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const tx = { payroll: {
      findUnique: vi.fn(async () => current), update,
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = record({ ...current, ...data, status: PayrollStatus.UNPAID, paidAt: null,
          paymentChannel: null, paymentNote: null, paidById: null, version: current.version + 1 });
        return { count: 1 };
      }),
    }, businessAuditEvent: { create: auditCreate } };
    const prisma = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) };
    const periods = { assertWritableForDate: vi.fn().mockResolvedValue(undefined) };
    const service = new PayrollService(prisma as never, periods as never);

    await expect(service.pay('payroll-1', { paidAt, channel: 'WECHAT', note: '月薪', actorId: 'owner-1' }))
      .resolves.toMatchObject({ status: PayrollStatus.PAID, paidAt, paymentChannel: 'WECHAT' });
    await expect(service.cancelPayment('payroll-1', {
      actorId: 'owner-2', expectedVersion: current.version, note: '误操作撤销',
    })).resolves.toMatchObject({ status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, version: 3 });
    expect(update.mock.calls[0]?.[0].data).toMatchObject({ paidAt, paymentChannel: 'WECHAT', paidById: 'owner-1' });
    expect(tx.payroll.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'payroll-1', status: PayrollStatus.PAID, version: 2 },
      data: expect.objectContaining({ status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, paidById: null }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      actorUserId: 'owner-2', eventType: 'payroll.payment.cancelled', resourceType: 'payroll', resourceId: 'payroll-1',
      detailJson: expect.objectContaining({
        cancelledById: 'owner-2', cancellationNote: '误操作撤销', payment: {
          paidAt: paidAt.toISOString(), channel: 'WECHAT', note: '月薪', paidById: 'owner-1',
        },
      }),
    }) }));
    expect(periods.assertWritableForDate).toHaveBeenCalledTimes(2);
  });

  it('rejects stale or unpaid payroll payment cancellations without changing history', async () => {
    const current = record({ status: PayrollStatus.PAID, paidAt, paymentChannel: 'CASH', paidById: 'owner-1' });
    const update = vi.fn();
    const auditCreate = vi.fn();
    const tx = {
      payroll: { findUnique: vi.fn().mockResolvedValue(current), update, updateMany: vi.fn() },
      businessAuditEvent: { create: auditCreate },
    };
    const service = new PayrollService(
      { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as never,
      { assertWritableForDate: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.cancelPayment('payroll-1', { actorId: 'owner-2', expectedVersion: 0 }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(tx.payroll.updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();

    tx.payroll.findUnique.mockResolvedValue(record({ status: PayrollStatus.UNPAID }));
    await expect(service.cancelPayment('payroll-1', { actorId: 'owner-2', expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(tx.payroll.updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
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
