import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AI Native single lesson Preview/Confirm with PostgreSQL', () => {
    const prisma = new PrismaService();
    const lessons = new LessonsService(new LessonsRepository(prisma), new PeriodsService(prisma));
    const actions = new AssistantActionsService(prisma, lessons, new CourseLedgerService(prisma, new PeriodsService(prisma)));
    const userIds: string[] = [];
    const teacherIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];
    const previewIds: string[] = [];
    const lessonIds: string[] = [];

    beforeAll(async () => { await prisma.$connect(); });
    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      await prisma.lesson.deleteMany({ where: { id: { in: lessonIds } } });
      await prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });

    it('stores Preview without Lesson, confirms atomically and replays the same receipt', async () => {
      const owner = await prisma.user.create({ data: {
        username: `preview-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({ data: {
        username: `preview-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: 'Preview 测试老师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: 'Preview 测试学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({ data: {
        name: `Preview 测试课程-${randomUUID()}`, defaultUnitPrice: '120.00', defaultDurationMinutes: 45,
      } });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: { studentId: student.id, courseId: course.id, currentUnitPrice: '120.00' },
      });
      accountIds.push(account.id);
      const actor = { id: owner.id, username: owner.username, role: UserRole.OWNER };
      const startsAt = new Date('2026-11-02T01:00:00.000Z');
      const preview = await actions.createSingleLessonPreview({
        actorUserId: owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId: account.id, teacherId: teacher.id, startsAt, note: 'AI 预览排课',
      });
      previewIds.push(preview.previewId);
      expect(await prisma.lesson.count({ where: { accountId: account.id } })).toBe(0);
      expect(preview.command).toMatchObject({ endsAt: '2026-11-02T01:45:00.000Z' });

      const confirmKey = randomUUID();
      const receipt = await actions.confirmSingleLessonPreview(preview.previewId, actor, confirmKey);
      expect(receipt).toMatchObject({ status: 'EXECUTED', receipt: { lessonId: expect.any(String), auditEventId: expect.any(String) } });
      const lessonId = (receipt.receipt as { lessonId: string }).lessonId;
      lessonIds.push(lessonId);
      expect(await prisma.lesson.count({ where: { accountId: account.id } })).toBe(1);
      expect(await prisma.businessAuditEvent.count({ where: { previewId: preview.previewId, eventType: 'assistant.preview.confirmed' } })).toBe(1);

      const replay = await actions.confirmSingleLessonPreview(preview.previewId, actor, confirmKey);
      expect(replay).toEqual(receipt);
      expect(await prisma.lesson.count({ where: { accountId: account.id } })).toBe(1);
      await expect(actions.confirmSingleLessonPreview(preview.previewId, actor, randomUUID())).rejects.toMatchObject({ status: 409 });
    });

    it('rejects a preview after account version changes and leaves no lesson', async () => {
      const owner = await prisma.user.create({ data: {
        username: `preview-stale-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER,
      } });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({ data: {
        username: `preview-stale-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER,
      } });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: 'Preview 过期老师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: 'Preview 过期学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({ data: {
        name: `Preview 过期课程-${randomUUID()}`, defaultUnitPrice: '100.00', defaultDurationMinutes: 30,
      } });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({ data: { studentId: student.id, courseId: course.id, currentUnitPrice: '100.00' } });
      accountIds.push(account.id);
      const preview = await actions.createSingleLessonPreview({
        actorUserId: owner.id, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId: account.id, teacherId: teacher.id, startsAt: new Date('2026-11-03T01:00:00.000Z'),
      });
      previewIds.push(preview.previewId);
      await prisma.studentCourseAccount.update({ where: { id: account.id }, data: { version: { increment: 1 } } });
      await expect(actions.confirmSingleLessonPreview(preview.previewId,
        { id: owner.id, username: owner.username, role: UserRole.OWNER }, randomUUID())).rejects.toMatchObject({ status: 409 });
      expect(await prisma.lesson.count({ where: { accountId: account.id } })).toBe(0);
    });
  });
} else {
  describe.skip('AI Native single lesson Preview/Confirm with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
