import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentChannel, PayrollStatus, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { PayrollService } from '../src/modules/payroll/payroll.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('Payroll payment cancellation with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const payrollService = new PayrollService(prisma, periods);
    const ownerId = randomUUID();
    const teacherUserId = randomUUID();
    const teacherId = randomUUID();
    const payrollId = randomUUID();
    const periodStart = new Date('2099-08-01T00:00:00.000Z');
    const paidAt = new Date('2099-08-05T02:00:00.000Z');

    beforeAll(async () => {
      await prisma.$connect();
      await prisma.user.create({ data: {
        id: ownerId, username: `payroll-owner-${ownerId}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      await prisma.user.create({ data: {
        id: teacherUserId, username: `payroll-teacher-${teacherUserId}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      await prisma.teacher.create({ data: { id: teacherId, userId: teacherUserId, name: `支付撤销测试老师-${teacherId}` } });
      await prisma.payroll.create({ data: {
        id: payrollId, teacherId, periodStart, courseRevenue: new Prisma.Decimal('1000.00'),
        baseSalary: new Prisma.Decimal('2000.00'), commissionRate: new Prisma.Decimal('10.0000'),
        commissionAmount: new Prisma.Decimal('100.00'), bonusAmount: new Prisma.Decimal('0.00'),
        deductionAmount: new Prisma.Decimal('20.00'), deductionNote: '测试代扣',
        grossSalary: new Prisma.Decimal('2100.00'), netSalary: new Prisma.Decimal('2080.00'),
        generatedById: ownerId,
      } });
    });

    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { resourceType: 'payroll', resourceId: payrollId } });
      await prisma.payroll.deleteMany({ where: { id: payrollId } });
      await prisma.teacher.deleteMany({ where: { id: teacherId } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, teacherUserId] } } });
      await prisma.$disconnect();
    });

    it('changes current status while retaining payment and cancellation facts in an append-only audit event', async () => {
      const paid = await payrollService.pay(payrollId, {
        paidAt, channel: PaymentChannel.WECHAT, note: '八月工资', actorId: ownerId,
      });
      const cancelled = await payrollService.cancelPayment(payrollId, {
        actorId: ownerId, expectedVersion: paid.version, note: '重复点击支付',
      });

      expect(cancelled).toMatchObject({ status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, version: 2 });
      await expect(prisma.payroll.findUniqueOrThrow({ where: { id: payrollId } }))
        .resolves.toMatchObject({ status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, paidById: null });

      const auditEvents = await prisma.businessAuditEvent.findMany({
        where: { resourceType: 'payroll', resourceId: payrollId, eventType: 'payroll.payment.cancelled' },
        orderBy: { createdAt: 'asc' },
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        actorUserId: ownerId,
        detailJson: {
          payrollId, teacherId, periodStart: periodStart.toISOString(), cancelledById: ownerId,
          cancellationNote: '重复点击支付', fromVersion: 1, toVersion: 2, netSalary: '2080.00',
          payment: { paidAt: paidAt.toISOString(), channel: 'WECHAT', note: '八月工资', paidById: ownerId },
        },
      });

      await expect(payrollService.cancelPayment(payrollId, {
        actorId: ownerId, expectedVersion: cancelled.version,
      })).rejects.toMatchObject({ status: 409 });
      await expect(prisma.businessAuditEvent.count({
        where: { resourceType: 'payroll', resourceId: payrollId, eventType: 'payroll.payment.cancelled' },
      })).resolves.toBe(1);
    });

    it('persists the salary formula with bonus included in gross salary and deduction removed from net salary', async () => {
      const updated = await payrollService.update(payrollId, {
        baseSalary: new Prisma.Decimal('2000.00'),
        commissionRate: new Prisma.Decimal('10.0000'),
        bonusAmount: new Prisma.Decimal('100.00'),
        bonusNote: '招生奖励',
        deductionAmount: new Prisma.Decimal('50.00'),
        deductionNote: '个人代缴',
        actorId: ownerId,
      });

      expect(updated).toMatchObject({
        commissionAmount: '100.00', bonusAmount: '100.00', deductionAmount: '50.00',
        grossSalary: '2200.00', netSalary: '2150.00',
      });
      await expect(prisma.payroll.findUniqueOrThrow({ where: { id: payrollId } }))
        .resolves.toMatchObject({
          grossSalary: new Prisma.Decimal('2200.00'),
          netSalary: new Prisma.Decimal('2150.00'),
        });
    });
  });
} else {
  describe.skip('Payroll payment cancellation with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
