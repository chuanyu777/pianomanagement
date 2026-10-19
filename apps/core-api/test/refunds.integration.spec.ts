import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentChannel, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { RefundsRepository } from '../src/modules/refunds/refunds.repository.js';
import { RefundsService } from '../src/modules/refunds/refunds.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('RefundsService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new RefundsService(new RefundsRepository(prisma), new PeriodsService(prisma));
    const userIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];
    const refundIds: string[] = [];
    const actor = { id: '', username: '', role: UserRole.OWNER };

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$transaction([
        prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.refundDetail.deleteMany({ where: { refundId: { in: refundIds } } }),
        prisma.refundRecord.deleteMany({ where: { id: { in: refundIds } } }),
        prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } }),
        prisma.course.deleteMany({ where: { id: { in: courseIds } } }),
        prisma.student.deleteMany({ where: { id: { in: studentIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
      await prisma.$disconnect();
    });

    it('commits refund records, details, ledger clearing, account versions and withdrawal once under concurrent retries', async () => {
      const owner = await prisma.user.create({
        data: { username: `refund-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      userIds.push(owner.id);
      Object.assign(actor, { id: owner.id, username: owner.username });
      const student = await prisma.student.create({ data: { name: '退费集成测试学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({
        data: { name: `退费集成测试课程-${randomUUID()}`, defaultUnitPrice: new Prisma.Decimal('100.00'), defaultDurationMinutes: 60 },
      });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          currentUnitPrice: new Prisma.Decimal('100.00'),
          openingPaidBalance: new Prisma.Decimal('120.00'),
          openingGiftBalance: new Prisma.Decimal('30.00'),
        },
      });
      accountIds.push(account.id);
      const commandId = randomUUID();
      refundIds.push(commandId);
      const input = {
        studentId: student.id,
        feeAmount: new Prisma.Decimal('6.00'),
        channel: PaymentChannel.CASH,
        occurredAt: new Date('2050-01-15T04:00:00.000Z'),
        commandId,
      };

      const [first, replay] = await Promise.all([
        service.refund(input, actor),
        service.refund(input, actor),
      ]);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        id: commandId,
        totalPaidRefund: '120.00',
        feeAmount: '6.00',
        feePercentage: '5.00',
        actualRefundAmount: '114.00',
      });
      expect(first.details).toHaveLength(1);
      await expect(prisma.refundRecord.count({ where: { studentId: student.id } })).resolves.toBe(1);
      await expect(prisma.refundDetail.count({ where: { refundId: commandId } })).resolves.toBe(1);
      const refundEntries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: { kind: 'asc' } });
      expect(refundEntries.map((entry) => ({
        kind: entry.kind, paidDelta: entry.paidDelta.toFixed(2), giftDelta: entry.giftDelta.toFixed(2),
      }))).toEqual([
        { kind: 'REFUND_PAID', paidDelta: '-120.00', giftDelta: '0.00' },
        { kind: 'REFUND_GIFT_CLEARING', paidDelta: '0.00', giftDelta: '-30.00' },
      ]);
      await expect(prisma.studentCourseAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .resolves.toMatchObject({ version: 1 });
      await expect(prisma.student.findUniqueOrThrow({ where: { id: student.id } }))
        .resolves.toMatchObject({ withdrawnAt: input.occurredAt });
    });
  });
} else {
  describe.skip('RefundsService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
