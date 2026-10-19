import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
import { LessonsRepository } from '../src/modules/lessons/lessons.repository.js';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('LessonsService batch scheduling with real PostgreSQL', () => {
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
        prisma.lesson.deleteMany({ where: { id: { in: lessonIds } } }),
        prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } }),
        prisma.course.deleteMany({ where: { id: { in: courseIds } } }),
        prisma.student.deleteMany({ where: { id: { in: studentIds } } }),
        prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } }),
        prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      ]);
      await prisma.$disconnect();
    });

    it('persists a whole weekly batch and rolls back the whole batch on an existing teacher conflict', async () => {
      const owner = await prisma.user.create({
        data: { username: `lesson-batch-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      userIds.push(owner.id);
      const teacherUser = await prisma.user.create({
        data: { username: `lesson-batch-teacher-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.TEACHER },
      });
      userIds.push(teacherUser.id);
      const teacher = await prisma.teacher.create({ data: { userId: teacherUser.id, name: '批量排课测试教师' } });
      teacherIds.push(teacher.id);
      const student = await prisma.student.create({ data: { name: '批量排课测试学生' } });
      studentIds.push(student.id);
      const course = await prisma.course.create({
        data: { name: `批量排课测试课程-${randomUUID()}`, defaultUnitPrice: '100.00', defaultDurationMinutes: 45 },
      });
      courseIds.push(course.id);
      const account = await prisma.studentCourseAccount.create({
        data: { studentId: student.id, courseId: course.id, currentUnitPrice: '100.00' },
      });
      accountIds.push(account.id);
      const actor = { id: owner.id, username: owner.username, role: UserRole.OWNER };
      const firstStartsAt = new Date('2026-11-02T01:00:00.000Z');

      const created = await service.createBatch({
        accountId: account.id,
        teacherId: teacher.id,
        firstStartsAt,
        weeks: 3,
      }, actor);
      lessonIds.push(...created.map((lesson) => lesson.id));

      expect(created.map(({ startsAt, endsAt }) => [startsAt.toISOString(), endsAt.toISOString()])).toEqual([
        ['2026-11-02T01:00:00.000Z', '2026-11-02T01:45:00.000Z'],
        ['2026-11-09T01:00:00.000Z', '2026-11-09T01:45:00.000Z'],
        ['2026-11-16T01:00:00.000Z', '2026-11-16T01:45:00.000Z'],
      ]);

      const beforeConflict = await prisma.lesson.count({ where: { teacherId: teacher.id } });
      const conflictingLesson = await prisma.lesson.create({
        data: {
          accountId: account.id,
          teacherId: teacher.id,
          startsAt: new Date('2026-12-07T01:15:00.000Z'),
          endsAt: new Date('2026-12-07T02:00:00.000Z'),
        },
      });
      lessonIds.push(conflictingLesson.id);

      let response: unknown;
      try {
        await service.createBatch({
          accountId: account.id,
          teacherId: teacher.id,
          firstStartsAt: new Date('2026-11-30T01:00:00.000Z'),
          weeks: 2,
        }, actor);
      } catch (error) {
        response = (error as { getResponse?: () => unknown }).getResponse?.();
      }

      expect(response).toMatchObject({
        message: '批量排课存在时间冲突，未创建任何排课',
        conflicts: [{
          startsAt: '2026-12-07T01:00:00.000Z',
          endsAt: '2026-12-07T01:45:00.000Z',
          conflictingLessonId: conflictingLesson.id,
        }],
      });
      await expect(prisma.lesson.count({ where: { teacherId: teacher.id } })).resolves.toBe(beforeConflict + 1);
    });
  });
} else {
  describe.skip('LessonsService batch scheduling with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
