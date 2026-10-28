import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LedgerEntryKind,
  ManualExpenseCategory,
  ManualIncomeCategory,
  ManualTransactionKind,
  PaymentChannel,
  PayrollStatus,
  Prisma,
  UserRole,
} from '../src/generated/prisma/client.js';
import { PayrollService } from '../src/modules/payroll/payroll.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { ReportsController } from '../src/modules/reports/reports.controller.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('Reports cash flow with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const reports = new ReportsService(prisma);
    const controller = new ReportsController(reports);
    const payrollService = new PayrollService(prisma, periods);

    const ownerId = randomUUID();
    const studentId = randomUUID();
    const courseId = randomUUID();
    const accountId = randomUUID();
    const paidTeacherId = randomUUID();
    const cancelledTeacherId = randomUUID();
    const paidPayrollId = randomUUID();
    const cancelledPayrollId = randomUUID();
    const refundId = randomUUID();
    const paymentIds = [randomUUID(), randomUUID(), randomUUID()];
    const paymentEntryIds = [randomUUID(), randomUUID(), randomUUID()];
    const reversalEntryIds = [randomUUID(), randomUUID(), randomUUID()];
    const giftId = randomUUID();
    const giftEntryId = randomUUID();
    const manualIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    const periodMonthIndex = Math.floor(Math.random() * 12);
    const periodYear = 2200 + Math.floor(Math.random() * 100);
    const periodStart = new Date(Date.UTC(periodYear, periodMonthIndex, 1));
    const period = `${periodYear}-${String(periodMonthIndex + 1).padStart(2, '0')}`;
    const monthStart = new Date(Date.UTC(periodYear, periodMonthIndex, 1) - 8 * 60 * 60 * 1000);
    const monthEnd = new Date(Date.UTC(periodYear, periodMonthIndex + 1, 1) - 8 * 60 * 60 * 1000);
    const dayEnd = new Date(monthStart.getTime() + 24 * 60 * 60 * 1000);
    const dayEndOfMonth = new Date(monthEnd.getTime() - 1);

    beforeAll(async () => {
      await prisma.$connect();
      await prisma.user.create({
        data: { id: ownerId, username: `cash-flow-owner-${ownerId}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      await prisma.student.create({ data: { id: studentId, name: `现金流测试学生-${studentId}` } });
      await prisma.course.create({
        data: { id: courseId, name: `现金流测试课程-${courseId}`, defaultUnitPrice: new Prisma.Decimal('100.00'), defaultDurationMinutes: 60 },
      });
      await prisma.studentCourseAccount.create({
        data: { id: accountId, studentId, courseId, currentUnitPrice: new Prisma.Decimal('100.00') },
      });
      await prisma.teacher.createMany({ data: [
        { id: paidTeacherId, name: `已支付工资老师-${paidTeacherId}` },
        { id: cancelledTeacherId, name: `已撤销工资老师-${cancelledTeacherId}` },
      ] });

      const paymentFixtures = [
        { id: paymentIds[0]!, entryId: paymentEntryIds[0]!, reversalId: reversalEntryIds[0]!, amount: '101.00', occurredAt: monthStart, reversedAt: dayEnd },
        { id: paymentIds[1]!, entryId: paymentEntryIds[1]!, reversalId: reversalEntryIds[1]!, amount: '13.00', occurredAt: new Date(dayEnd.getTime() - 1), reversedAt: monthEnd },
        { id: paymentIds[2]!, entryId: paymentEntryIds[2]!, reversalId: reversalEntryIds[2]!, amount: '23.00', occurredAt: dayEndOfMonth, reversedAt: monthEnd },
      ];
      for (const payment of paymentFixtures) {
        await prisma.paymentRecord.create({
          data: {
            id: payment.id, accountId, amount: new Prisma.Decimal(payment.amount), occurredAt: payment.occurredAt,
            channel: PaymentChannel.CASH, note: '集成测试交费', createdById: ownerId,
          },
        });
        await prisma.ledgerEntry.create({
          data: {
            id: payment.entryId, accountId, kind: LedgerEntryKind.PAYMENT,
            paidDelta: new Prisma.Decimal(payment.amount), occurredAt: payment.occurredAt,
            createdById: ownerId, commandId: randomUUID(), paymentId: payment.id,
          },
        });
        await prisma.ledgerEntry.create({
          data: {
            id: payment.reversalId, accountId, kind: LedgerEntryKind.PAYMENT_REVERSAL,
            paidDelta: new Prisma.Decimal(payment.amount).negated(), occurredAt: payment.reversedAt,
            createdById: ownerId, commandId: randomUUID(), reversesEntryId: payment.entryId,
          },
        });
      }

      await prisma.giftRecord.create({
        data: { id: giftId, accountId, amount: new Prisma.Decimal('500.00'), occurredAt: monthStart, note: '赠送不属于现金收款', createdById: ownerId },
      });
      await prisma.ledgerEntry.create({
        data: {
          id: giftEntryId, accountId, kind: LedgerEntryKind.GIFT, giftDelta: new Prisma.Decimal('500.00'),
          occurredAt: monthStart, createdById: ownerId, commandId: randomUUID(), giftId,
        },
      });

      await prisma.refundRecord.create({
        data: {
          id: refundId, studentId, totalPaidRefund: new Prisma.Decimal('35.00'), feeAmount: new Prisma.Decimal('3.75'),
          feePercentage: new Prisma.Decimal('10.71'), actualRefundAmount: new Prisma.Decimal('31.25'),
          channel: PaymentChannel.BANK_CARD, occurredAt: new Date(monthStart.getTime() + 2 * 60 * 60 * 1000),
          note: '集成测试退款', createdById: ownerId,
        },
      });

      const payrollDefaults = {
        periodStart,
        courseRevenue: new Prisma.Decimal('0.00'),
        commissionRate: new Prisma.Decimal('0.0000'),
        commissionAmount: new Prisma.Decimal('0.00'),
        bonusAmount: new Prisma.Decimal('0.00'),
        deductionAmount: new Prisma.Decimal('0.00'),
        generatedById: ownerId,
      };
      await prisma.payroll.create({
        data: {
          ...payrollDefaults, id: paidPayrollId, teacherId: paidTeacherId,
          baseSalary: new Prisma.Decimal('70.25'), grossSalary: new Prisma.Decimal('70.25'), netSalary: new Prisma.Decimal('70.25'),
        },
      });
      await prisma.payroll.create({
        data: {
          ...payrollDefaults, id: cancelledPayrollId, teacherId: cancelledTeacherId,
          baseSalary: new Prisma.Decimal('45.50'), grossSalary: new Prisma.Decimal('45.50'), netSalary: new Prisma.Decimal('45.50'),
        },
      });
      await payrollService.pay(paidPayrollId, {
        paidAt: new Date(monthStart.getTime() + 3 * 60 * 60 * 1000), channel: PaymentChannel.WECHAT, note: '实际工资支付', actorId: ownerId,
      });
      const cancelledPayment = await payrollService.pay(cancelledPayrollId, {
        paidAt: new Date(monthStart.getTime() + 4 * 60 * 60 * 1000), channel: PaymentChannel.BANK_CARD, note: '随后撤销的工资支付', actorId: ownerId,
      });
      await payrollService.cancelPayment(cancelledPayrollId, {
        actorId: ownerId, expectedVersion: cancelledPayment.version, note: '测试撤销支付，不作为现金支出',
      });

      const manualFixtures = [
        { id: manualIds[0]!, kind: ManualTransactionKind.INCOME, incomeCategory: ManualIncomeCategory.BOOK_SALE, expenseCategory: null, amount: '17.15', occurredAt: dayEnd, channel: PaymentChannel.CASH, note: '次日业务日收入' },
        { id: manualIds[1]!, kind: ManualTransactionKind.EXPENSE, incomeCategory: null, expenseCategory: ManualExpenseCategory.RENT_PROPERTY, amount: '19.75', occurredAt: dayEndOfMonth, channel: PaymentChannel.BANK_CARD, note: '月末租金' },
        { id: manualIds[2]!, kind: ManualTransactionKind.INCOME, incomeCategory: ManualIncomeCategory.OTHER_INCOME, expenseCategory: null, amount: '997.00', occurredAt: new Date(monthStart.getTime() - 1), channel: PaymentChannel.CASH, note: '上月边界，应排除' },
        { id: manualIds[3]!, kind: ManualTransactionKind.EXPENSE, incomeCategory: null, expenseCategory: ManualExpenseCategory.OTHER_EXPENSE, amount: '991.00', occurredAt: monthEnd, channel: PaymentChannel.CASH, note: '下月边界，应排除' },
      ];
      await prisma.manualTransaction.createMany({
        data: manualFixtures.map((item) => ({ ...item, amount: new Prisma.Decimal(item.amount), createdById: ownerId })),
      });
    });

    afterAll(async () => {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.businessAuditEvent.deleteMany({ where: { resourceType: 'payroll', resourceId: { in: [paidPayrollId, cancelledPayrollId] } } });
          await tx.ledgerEntry.deleteMany({ where: { id: { in: [...paymentEntryIds, ...reversalEntryIds, giftEntryId] } } });
          await tx.refundRecord.deleteMany({ where: { id: refundId } });
          await tx.paymentRecord.deleteMany({ where: { id: { in: paymentIds } } });
          await tx.giftRecord.deleteMany({ where: { id: giftId } });
          await tx.manualTransaction.deleteMany({ where: { id: { in: manualIds } } });
          await tx.payroll.deleteMany({ where: { id: { in: [paidPayrollId, cancelledPayrollId] } } });
          await tx.studentCourseAccount.deleteMany({ where: { id: accountId } });
          await tx.teacher.deleteMany({ where: { id: { in: [paidTeacherId, cancelledTeacherId] } } });
          await tx.course.deleteMany({ where: { id: courseId } });
          await tx.student.deleteMany({ where: { id: studentId } });
          await tx.user.deleteMany({ where: { id: ownerId } });
        });
      } finally {
        await prisma.$disconnect();
      }
    });

    it('uses Shanghai day/month half-open ranges and reconciles source totals with the monthly cash summary', async () => {
      const secondBusinessDate = `${period}-02`;
      const firstBusinessDay = await controller.cashFlow(`${period}-01`);
      const secondBusinessDay = await controller.cashFlow(secondBusinessDate);
      const monthlyCashFlow = await controller.cashFlow(undefined, period);
      const monthly = await reports.monthly(periodStart);

      expect(firstBusinessDay).toMatchObject({
        periodType: 'DAY', period: `${period}-01`, rangeStart: monthStart, rangeEnd: dayEnd,
        cashIncome: '114.00', cashExpense: '101.50', cashNet: '12.50',
      });
      expect(firstBusinessDay.items.map((item) => item.type)).toEqual(expect.arrayContaining(['PAYMENT', 'REFUND', 'PAYROLL']));
      expect(firstBusinessDay.items.find((item) => item.id === paymentIds[0])).toMatchObject({
        type: 'PAYMENT', amount: '101.00', reversal: { ledgerEntryId: reversalEntryIds[0], occurredAt: dayEnd },
      });
      expect(firstBusinessDay.items.find((item) => item.id === paymentIds[1])).toMatchObject({
        type: 'PAYMENT', amount: '13.00', reversal: { ledgerEntryId: reversalEntryIds[1], occurredAt: monthEnd },
      });
      expect(firstBusinessDay.items.find((item) => item.id === refundId)).toMatchObject({
        type: 'REFUND', direction: 'EXPENSE', amount: '31.25', totalPaidRefund: '35.00', feeAmount: '3.75',
      });
      expect(firstBusinessDay.items.find((item) => item.id === paidPayrollId)).toMatchObject({
        type: 'PAYROLL', direction: 'EXPENSE', amount: '70.25',
      });
      expect(firstBusinessDay.items.some((item) => item.id === giftId || item.id === cancelledPayrollId)).toBe(false);
      expect(secondBusinessDay).toMatchObject({
        periodType: 'DAY', period: secondBusinessDate,
        cashIncome: '17.15', cashExpense: '0.00', cashNet: '17.15',
      });
      expect(secondBusinessDay.items.some((item) => item.id === paymentIds[0] || item.id === reversalEntryIds[0])).toBe(false);

      expect(monthlyCashFlow).toMatchObject({
        periodType: 'MONTH', period, rangeStart: monthStart, rangeEnd: monthEnd,
        cashIncome: '154.15', cashExpense: '121.25', cashNet: '32.90',
      });
      expect(monthlyCashFlow.items.map((item) => item.id)).toEqual(expect.arrayContaining([
        ...paymentIds, refundId, paidPayrollId, manualIds[0]!, manualIds[1]!,
      ]));
      expect(monthlyCashFlow.items.map((item) => item.id)).not.toEqual(expect.arrayContaining([
        cancelledPayrollId, giftId, manualIds[2]!, manualIds[3]!,
      ]));
      expect(monthlyCashFlow.cashIncome).toBe(monthly.cashIncome);
      expect(monthlyCashFlow.cashExpense).toBe(monthly.cashExpense);
      expect(monthlyCashFlow.cashNet).toBe(monthly.cashNet);
      expect(monthly).toMatchObject({
        cashIncome: '154.15', cashExpense: '121.25', cashNet: '32.90', payrollCost: '115.75',
      });
      await expect(prisma.payroll.findUniqueOrThrow({ where: { id: cancelledPayrollId } })).resolves.toMatchObject({
        status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null,
      });
      await expect(prisma.businessAuditEvent.count({
        where: { resourceType: 'payroll', resourceId: cancelledPayrollId, eventType: 'payroll.payment.cancelled' },
      })).resolves.toBe(1);
    });
  });
} else {
  describe.skip('Reports cash flow with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
