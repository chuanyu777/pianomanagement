import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LessonStatus, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AI Native lesson mutation Preview/Confirm with PostgreSQL', () => {
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

    async function fixture() {
      const owner = await prisma.user.create({ data: {
        username: `lesson-action-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({ data: {
        username: `lesson-action-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: 'Preview 操作老师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: 'Preview 操作学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({ data: {
        name: `Preview 操作课程-${randomUUID()}`, defaultUnitPrice: '100.00', defaultDurationMinutes: 45,
      } });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: { studentId: student.id, courseId: course.id, currentUnitPrice: '100.00', openingPaidBalance: '200.00', openingGiftBalance: '25.00' },
      });
      accountIds.push(account.id);
      return { owner, teacher, student, course, account,
        actor: { id: owner.id, username: owner.username, role: UserRole.OWNER } as const };
    }

    async function scheduledLesson(accountId: string, teacherId: string, startsAt: Date) {
      const lesson = await prisma.lesson.create({ data: {
        accountId, teacherId, startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60_000), status: LessonStatus.SCHEDULED,
      } });
      lessonIds.push(lesson.id);
      return lesson;
    }

    it('previews and confirms reschedule and cancellation atomically with stable receipts', async () => {
      const data = await fixture();
      const rescheduled = await scheduledLesson(data.account.id, data.teacher.id, new Date(Date.now() + 2 * 86_400_000));
      const reschedulePreview = await actions.createReschedulePreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        lessonId: rescheduled.id, startsAt: new Date(Date.now() + 4 * 86_400_000),
      });
      previewIds.push(reschedulePreview.previewId);
      expect(await prisma.lesson.findUniqueOrThrow({ where: { id: rescheduled.id } })).toMatchObject({
        startsAt: rescheduled.startsAt, status: LessonStatus.SCHEDULED,
      });
      expect(reschedulePreview.resourceVersions).toMatchObject({ lessonVersion: 0, accountVersion: 0 });

      const rescheduleKey = randomUUID();
      const rescheduleReceipt = await actions.confirmPreview(reschedulePreview.previewId, data.actor, rescheduleKey);
      expect(rescheduleReceipt).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.reschedule', lessonId: rescheduled.id, idempotencyKey: rescheduleKey } });
      await expect(actions.confirmPreview(reschedulePreview.previewId, data.actor, rescheduleKey)).resolves.toEqual(rescheduleReceipt);
      await expect(actions.confirmPreview(reschedulePreview.previewId, data.actor, randomUUID())).rejects.toMatchObject({ status: 409 });

      const cancelled = await scheduledLesson(data.account.id, data.teacher.id, new Date(Date.now() + 6 * 86_400_000));
      const cancelPreview = await actions.createCancelPreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), lessonId: cancelled.id,
      });
      previewIds.push(cancelPreview.previewId);
      expect(await prisma.lesson.findUniqueOrThrow({ where: { id: cancelled.id } })).toMatchObject({ status: LessonStatus.SCHEDULED });
      const cancelReceipt = await actions.confirmPreview(cancelPreview.previewId, data.actor, randomUUID());
      expect(cancelReceipt).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.cancel', lessonId: cancelled.id, status: LessonStatus.CANCELLED } });
    });

    it('previews gift-first consumption and lets only the owner reverse completion', async () => {
      const data = await fixture();
      const endedAt = new Date(Date.now() - 2 * 86_400_000);
      const lesson = await scheduledLesson(data.account.id, data.teacher.id, endedAt);
      const preview = await actions.createCompletionPreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), lessonId: lesson.id,
      });
      previewIds.push(preview.previewId);
      expect(preview.display).toMatchObject({ paidConsumed: '75.00', giftConsumed: '25.00' });
      expect(await prisma.ledgerEntry.count({ where: { lessonId: lesson.id } })).toBe(0);
      const completeKey = randomUUID();
      const completeReceipt = await actions.confirmPreview(preview.previewId, data.actor, completeKey);
      expect(completeReceipt).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.complete', lessonId: lesson.id, status: LessonStatus.COMPLETED } });
      expect(await prisma.ledgerEntry.findUnique({ where: { lessonId: lesson.id } })).toMatchObject({ paidDelta: { toFixed: expect.any(Function) }, giftDelta: { toFixed: expect.any(Function) } });
      await expect(actions.confirmPreview(preview.previewId, data.actor, completeKey)).resolves.toEqual(completeReceipt);

      const reversalPreview = await actions.createCompletionReversalPreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), lessonId: lesson.id,
      });
      previewIds.push(reversalPreview.previewId);
      expect(reversalPreview.display).toMatchObject({ paidRestore: '75.00', giftRestore: '25.00' });
      const reversalReceipt = await actions.confirmPreview(reversalPreview.previewId, data.actor, randomUUID());
      expect(reversalReceipt).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.complete.reversal', lessonId: lesson.id, status: LessonStatus.SCHEDULED } });
      expect(await prisma.ledgerEntry.count({ where: { accountId: data.account.id } })).toBe(2);
    });
  });
} else {
  describe.skip('AI Native lesson mutation Preview/Confirm with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
