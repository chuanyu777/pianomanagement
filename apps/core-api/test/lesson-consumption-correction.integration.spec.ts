import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('历史课消金额纠错 with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const lessons = new LessonsService(new LessonsRepository(prisma), periods);
    const actions = new AssistantActionsService(prisma, lessons, new CourseLedgerService(prisma, periods));
    const userIds: string[] = [];
    const teacherIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];
    const lessonIds: string[] = [];
    const previewIds: string[] = [];

    beforeAll(async () => { await prisma.$connect(); });

    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      await prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.lesson.deleteMany({ where: { id: { in: lessonIds } } });
      await prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });

    it('previews and confirms an opposite original consumption plus a corrected consumption in the open month', async () => {
      const owner = await prisma.user.create({ data: {
        username: `correction-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({ data: {
        username: `correction-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: '纠错测试老师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: '林悦' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({ data: {
        name: `主课-${randomUUID()}`, defaultUnitPrice: '200.00', defaultDurationMinutes: 60,
      } });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({ data: {
        studentId: student.id, courseId: course.id, currentUnitPrice: '220.00',
        openingPaidBalance: '1000.00', openingGiftBalance: '0.00',
      } });
      accountIds.push(account.id);
      const lesson = await prisma.lesson.create({ data: {
        accountId: account.id, teacherId: teacher.id,
        startsAt: new Date('2026-09-10T01:00:00.000Z'), endsAt: new Date('2026-09-10T02:00:00.000Z'),
        status: 'COMPLETED', unitPriceSnapshot: '200.00', completedAt: new Date('2026-09-10T02:00:00.000Z'),
        completedById: owner.id,
      } });
      lessonIds.push(lesson.id);
      const original = await prisma.ledgerEntry.create({ data: {
        accountId: account.id, lessonId: lesson.id, kind: 'LESSON_CONSUMPTION',
        paidDelta: '-200.00', giftDelta: '0.00', occurredAt: new Date('2026-09-10T02:00:00.000Z'),
        createdById: owner.id, commandId: randomUUID(),
      } });

      const actor = { id: owner.id, username: owner.username, role: UserRole.OWNER } as const;
      await expect(actions.createCompletionCorrectionPreview({
        actorUserId: teacherUser.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        lessonId: lesson.id, correctedUnitPrice: new Prisma.Decimal('220.00'),
      })).rejects.toThrow('只有店主');
      const preview = await actions.createCompletionCorrectionPreview({
        actorUserId: owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        lessonId: lesson.id, correctedUnitPrice: new Prisma.Decimal('220.00'),
      });
      previewIds.push(preview.previewId);
      expect(preview).toMatchObject({
        actionType: 'lesson.complete.correction', riskLevel: 'L2',
        display: {
          originalAmount: '200.00', correctedAmount: '220.00',
          reversalPaid: '200.00', correctedPaid: '220.00', statusAfter: 'COMPLETED',
        },
      });

      const confirmationKey = randomUUID();
      const receipt = await actions.confirmPreview(preview.previewId, actor, confirmationKey);
      expect(receipt).toMatchObject({ status: 'EXECUTED', receipt: {
        actionType: 'lesson.complete.correction', lessonId: lesson.id, correctedUnitPrice: '220.00',
      } });
      const replayReceipt = await actions.confirmPreview(preview.previewId, actor, confirmationKey);
      expect(replayReceipt).toEqual(receipt);

      const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] });
      expect(entries).toHaveLength(3);
      const reversal = entries.find((entry) => entry.kind === 'LESSON_CONSUMPTION_REVERSAL');
      const correction = entries.find((entry) => entry.kind === 'LESSON_CONSUMPTION_CORRECTION');
      expect(entries.find((entry) => entry.id === original.id)).toMatchObject({ kind: 'LESSON_CONSUMPTION', paidDelta: new Prisma.Decimal('-200.00') });
      expect(reversal).toMatchObject({ paidDelta: new Prisma.Decimal('200.00'), reversesEntryId: original.id });
      expect(correction).toMatchObject({ paidDelta: new Prisma.Decimal('-220.00'), correctsEntryId: original.id });
      expect(await prisma.paymentRecord.count({ where: { accountId: account.id } })).toBe(0);
      await expect(prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).resolves.toMatchObject({
        status: 'COMPLETED', unitPriceSnapshot: new Prisma.Decimal('220.00'),
      });
      await expect(actions.createCompletionCorrectionPreview({
        actorUserId: owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        lessonId: lesson.id, correctedUnitPrice: new Prisma.Decimal('220.00'),
      })).rejects.toThrow('已处理');
      await expect(new ReportsService(prisma).monthly(new Date('2026-10-01T00:00:00.000Z')))
        .resolves.toMatchObject({ lessonIncome: '20.00' });
    });
  });
} else {
  describe.skip('历史课消金额纠错 with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
