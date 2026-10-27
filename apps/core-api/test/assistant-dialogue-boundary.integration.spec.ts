import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LessonStatus, PaymentChannel, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

const MONEY_FIELDS = [
  'amount',
  'unitPrice',
  'paidBalanceBefore',
  'giftBalanceBefore',
  'paidConsumed',
  'giftConsumed',
  'paidBalanceAfter',
  'giftBalanceAfter',
  'paidRestore',
  'giftRestore',
  'beforeBalance',
  'afterBalance',
] as const;

function expectNoMoneyFields(value: unknown) {
  for (const field of MONEY_FIELDS) expect(value).not.toHaveProperty(field);
}

if (hasDatabase) {
  describe('AI dialogue authorization and Preview lifecycle with PostgreSQL', () => {
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
        username: `dialogue-boundary-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      userIds.push(owner.id);

      const teacherUser = await prisma.user.create({ data: {
        username: `dialogue-boundary-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: '对话边界老师 A' } });
      teacherIds.push(teacher.id);

      const otherTeacherUser = await prisma.user.create({ data: {
        username: `dialogue-boundary-other-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(otherTeacherUser.id);
      const otherTeacher = await prisma.teacher.create({ data: { userId: otherTeacherUser.id, name: '对话边界老师 B' } });
      teacherIds.push(otherTeacher.id);

      const student = await prisma.student.create({ data: { name: '对话边界学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({ data: {
        name: `对话边界课程-${randomUUID()}`, defaultUnitPrice: '100.00', defaultDurationMinutes: 45,
      } });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: { studentId: student.id, courseId: course.id, currentUnitPrice: '100.00', openingPaidBalance: '200.00', openingGiftBalance: '25.00' },
      });
      accountIds.push(account.id);

      return { owner, teacherUser, teacher, otherTeacherUser, otherTeacher, student, course, account,
        ownerActor: { id: owner.id, username: owner.username, role: UserRole.OWNER } as const };
    }

    async function scheduledLesson(accountId: string, teacherId: string) {
      const startsAt = new Date(Date.now() - 2 * 86_400_000);
      const lesson = await prisma.lesson.create({ data: {
        accountId, teacherId, startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60_000), status: LessonStatus.SCHEDULED,
      } });
      lessonIds.push(lesson.id);
      return lesson;
    }

    it('invalidates an owner payment Preview and prevents the original confirm without ledger changes', async () => {
      const data = await fixture();
      const preview = await actions.createPaymentPreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId: data.account.id, amount: '30.00', channel: PaymentChannel.WECHAT,
        occurredAt: new Date('2026-10-21T02:00:00.000Z'), note: '边界测试交费',
      });
      previewIds.push(preview.previewId);
      const ledgerCountBefore = await prisma.ledgerEntry.count({ where: { accountId: data.account.id } });
      const paymentCountBefore = await prisma.paymentRecord.count({ where: { accountId: data.account.id } });

      await expect(actions.invalidatePreview(preview.previewId, data.owner.id, '用户改了交费金额', randomUUID()))
        .resolves.toMatchObject({ previewId: preview.previewId, status: 'CANCELLED' });
      await expect(actions.confirmPreview(preview.previewId, data.ownerActor, randomUUID()))
        .rejects.toMatchObject({ status: 409 });

      expect(await prisma.actionPreview.findUniqueOrThrow({ where: { id: preview.previewId } })).toMatchObject({ status: 'CANCELLED' });
      expect(await prisma.ledgerEntry.count({ where: { accountId: data.account.id } })).toBe(ledgerCountBefore);
      expect(await prisma.paymentRecord.count({ where: { accountId: data.account.id } })).toBe(paymentCountBefore);
    });

    it('gives a teacher-owned completed lesson an L2 Preview without money fields', async () => {
      const data = await fixture();
      const lesson = await scheduledLesson(data.account.id, data.teacher.id);
      const preview = await actions.createCompletionPreview({
        actorUserId: data.teacherUser.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), lessonId: lesson.id,
      });
      previewIds.push(preview.previewId);

      expect(preview).toMatchObject({ actionType: 'lesson.complete', riskLevel: 'L2' });
      expectNoMoneyFields(preview.command);
      expectNoMoneyFields(preview.display);
      expectNoMoneyFields(preview.resourceVersions);

      const readBack = await actions.getPreviewForUser(preview.previewId, data.teacherUser.id);
      expect(readBack).toMatchObject({ actionType: 'lesson.complete', riskLevel: 'L2', status: 'PENDING' });
      expectNoMoneyFields(readBack.command);
      expectNoMoneyFields(readBack.display);
      expectNoMoneyFields(readBack.resourceVersions);
    });

    it.each(['course-account.payment', 'course-account.read', 'lesson.complete.reversal'])
    ('returns 403 for a teacher DB actor on %s access', async (actionType) => {
      const data = await fixture();
      await expect(actions.checkActionAccess(data.teacherUser.id, actionType))
        .rejects.toMatchObject({ status: 403 });
    });

    it('rejects an unknown action rather than inventing a Preview capability', async () => {
      const data = await fixture();
      await expect(actions.checkActionAccess(data.owner.id, 'course-account.reversal'))
        .rejects.toMatchObject({ status: 400 });
    });

    it('does not let a user who is now a teacher read their old financial Preview', async () => {
      const data = await fixture();
      const preview = await actions.createPaymentPreview({
        actorUserId: data.owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId: data.account.id, amount: '20.00', channel: PaymentChannel.CASH,
        occurredAt: new Date('2026-10-21T02:10:00.000Z'),
      });
      previewIds.push(preview.previewId);
      const ownerTeacher = await prisma.teacher.create({ data: { userId: data.owner.id, name: '原店主现教师' } });
      teacherIds.push(ownerTeacher.id);
      await prisma.user.update({ where: { id: data.owner.id }, data: { role: UserRole.TEACHER } });

      await expect(actions.getPreviewForUser(preview.previewId, data.owner.id))
        .rejects.toMatchObject({ status: 403 });
    });

    it('does not let a teacher read another teacher\'s lesson Preview', async () => {
      const data = await fixture();
      const lesson = await scheduledLesson(data.account.id, data.teacher.id);
      const preview = await actions.createCompletionPreview({
        actorUserId: data.teacherUser.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), lessonId: lesson.id,
      });
      previewIds.push(preview.previewId);

      await expect(actions.getPreviewForUser(preview.previewId, data.otherTeacherUser.id))
        .rejects.toMatchObject({ status: 403 });
    });
  });
} else {
  describe.skip('AI dialogue authorization and Preview lifecycle with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
