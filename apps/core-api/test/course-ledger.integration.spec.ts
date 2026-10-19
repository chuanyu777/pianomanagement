import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentChannel, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('CourseLedgerService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new CourseLedgerService(prisma, new PeriodsService(prisma));
    const userIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$transaction([
        prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.paymentRecord.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.giftRecord.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } }),
        prisma.course.deleteMany({ where: { id: { in: courseIds } } }),
        prisma.student.deleteMany({ where: { id: { in: studentIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
      await prisma.$disconnect();
    });

    it('persists payment, gift, balances and one reversal as immutable ledger entries', async () => {
      const actor = await prisma.user.create({
        data: { username: `ledger-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      userIds.push(actor.id);
      const student = await prisma.student.create({ data: { name: '金额测试学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({
        data: { name: `金额测试课程-${randomUUID()}`, defaultUnitPrice: new Prisma.Decimal('200.00'), defaultDurationMinutes: 60 },
      });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          currentUnitPrice: new Prisma.Decimal('200.00'),
          openingPaidBalance: new Prisma.Decimal('20.00'),
          openingGiftBalance: new Prisma.Decimal('10.00'),
        },
      });
      accountIds.push(account.id);
      const occurredAt = new Date('2026-10-16T09:00:00.000Z');

      const payment = await service.recordPayment({
        accountId: account.id,
        amount: new Prisma.Decimal('100.00'),
        channel: PaymentChannel.WECHAT,
        occurredAt,
        createdById: actor.id,
        commandId: randomUUID(),
      });
      const gift = await service.recordGift({
        accountId: account.id,
        amount: new Prisma.Decimal('30.00'),
        occurredAt,
        createdById: actor.id,
        commandId: randomUUID(),
      });
      expect(payment).toMatchObject({ paidBalance: '120.00', giftBalance: '10.00', totalBalance: '130.00' });
      expect(gift).toMatchObject({ paidBalance: '120.00', giftBalance: '40.00', totalBalance: '160.00' });

      const entries = await prisma.ledgerEntry.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);
      const paymentEntry = entries.find((entry) => entry.kind === 'PAYMENT');
      expect(paymentEntry).toBeDefined();
      const reversal = await service.reverseEntry({
        entryId: paymentEntry!.id,
        occurredAt,
        createdById: actor.id,
        commandId: randomUUID(),
      });
      expect(reversal).toMatchObject({ paidBalance: '20.00', giftBalance: '40.00', totalBalance: '60.00' });
      await expect(service.reverseEntry({
        entryId: paymentEntry!.id,
        occurredAt,
        createdById: actor.id,
        commandId: randomUUID(),
      })).rejects.toMatchObject({ status: 409 });

      const stored = await prisma.ledgerEntry.findMany({ where: { accountId: account.id } });
      expect(stored).toHaveLength(3);
      await expect(prisma.studentCourseAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .resolves.toMatchObject({ version: 3 });
    });
  });
} else {
  describe.skip('CourseLedgerService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
