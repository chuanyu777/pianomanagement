import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerEntryKind, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('LessonsService completion with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new LessonsService(new LessonsRepository(prisma), new PeriodsService(prisma));
    const userIds: string[] = [];
    const teacherIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];
    const lessonIds: string[] = [];

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$transaction([
        prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } }),
        prisma.lesson.deleteMany({ where: { id: { in: lessonIds } } }),
        prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } }),
        prisma.course.deleteMany({ where: { id: { in: courseIds } } }),
        prisma.student.deleteMany({ where: { id: { in: studentIds } } }),
        prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
      await prisma.$disconnect();
    });

    it('consumes gifts before paid balance, is idempotent, and reverses a completion through ledger entries', async () => {
      const owner = await prisma.user.create({
        data: { username: `lesson-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({
        data: { username: `lesson-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER },
      });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: '测试老师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: '课消测试学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({
        data: { name: `课消测试课程-${randomUUID()}`, defaultUnitPrice: new Prisma.Decimal('100.00'), defaultDurationMinutes: 60 },
      });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          currentUnitPrice: new Prisma.Decimal('100.00'),
          openingPaidBalance: new Prisma.Decimal('50.00'),
          openingGiftBalance: new Prisma.Decimal('80.00'),
        },
      });
      accountIds.push(account.id);
      const lesson = await prisma.lesson.create({
        data: {
          accountId: account.id,
          teacherId: teacher.id,
          startsAt: new Date('2025-01-01T01:00:00.000Z'),
          endsAt: new Date('2025-01-01T02:00:00.000Z'),
        },
      });
      lessonIds.push(lesson.id);
      const ownerActor = { id: owner.id, username: owner.username, role: UserRole.OWNER };
      const completeCommandId = randomUUID();

      const completed = await service.complete(lesson.id, { commandId: completeCommandId }, ownerActor);
      expect(completed).toMatchObject({
        id: lesson.id,
        status: 'COMPLETED',
        unitPriceSnapshot: '100.00',
      });
      await expect(service.complete(lesson.id, { commandId: completeCommandId }, ownerActor))
        .resolves.toMatchObject({ id: lesson.id, status: 'COMPLETED' });

      const consumption = await prisma.ledgerEntry.findUniqueOrThrow({ where: { lessonId: lesson.id } });
      expect(consumption).toMatchObject({
        kind: LedgerEntryKind.LESSON_CONSUMPTION,
        paidDelta: new Prisma.Decimal('-20.00'),
        giftDelta: new Prisma.Decimal('-80.00'),
        commandId: completeCommandId,
      });
      await expect(prisma.studentCourseAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .resolves.toMatchObject({ version: 1 });

      const reverted = await service.reverseCompletion(lesson.id, { commandId: randomUUID() }, ownerActor);
      expect(reverted).toMatchObject({ id: lesson.id, status: 'SCHEDULED', unitPriceSnapshot: null });
      const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        kind: LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL,
        paidDelta: new Prisma.Decimal('20.00'),
        giftDelta: new Prisma.Decimal('80.00'),
        reversesEntryId: consumption.id,
      });
      await expect(prisma.studentCourseAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .resolves.toMatchObject({ version: 2 });
    });
  });
} else {
  describe.skip('LessonsService completion with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
