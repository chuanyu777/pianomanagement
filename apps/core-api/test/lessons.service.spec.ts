import { ForbiddenException } from '@nestjs/common';
import { LessonsService } from '../src/modules/lessons/lessons.service.js';
import { describe, expect, it, vi } from 'vitest';

const accountId = 'course-account-1';
const teacherId = 'teacher-1';
const otherTeacherId = 'teacher-2';
const lessonId = 'lesson-1';
const studentId = 'student-1';

const owner = { role: 'OWNER' as const, teacherId: null };
const teacher = { role: 'TEACHER' as const, teacherId };
const otherTeacher = { role: 'TEACHER' as const, teacherId: otherTeacherId };

function makeLesson(overrides: Record<string, unknown> = {}) {
  return {
    id: lessonId,
    accountId,
    teacherId,
    startsAt: new Date('2026-11-02T01:00:00.000Z'),
    endsAt: new Date('2026-11-02T02:00:00.000Z'),
    status: 'SCHEDULED',
    note: null,
    account: {
      studentId,
      student: { id: studentId, name: '小明' },
      course: { id: 'course-1', name: '主课', defaultDurationMinutes: 60 },
    },
    ...overrides,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const studentCourseAccount = {
    findUnique: vi.fn(async () => ({
      id: accountId,
      studentId,
      student: { id: studentId, name: '小明' },
      course: { id: 'course-1', name: '主课', defaultDurationMinutes: 60 },
    })),
  };
  const lesson = {
    create: vi.fn(async () => makeLesson()),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => makeLesson()),
    update: vi.fn(async () => makeLesson()),
    ...overrides,
  };
  return {
    service: new LessonsService({ studentCourseAccount, lesson } as never),
    studentCourseAccount,
    lesson,
  };
}

describe('LessonsService', () => {
  it('creates a scheduled lesson linked to the selected course account and teacher using the course duration', async () => {
    const { service, studentCourseAccount, lesson } = makeService();
    const startsAt = new Date('2026-11-02T01:00:00.000Z');

    await service.createSingle({ accountId, teacherId, startsAt }, owner);

    expect(studentCourseAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: accountId },
      include: expect.objectContaining({ course: true, student: true }),
    }));
    expect(lesson.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        teacherId,
        status: { not: 'CANCELLED' },
        startsAt: { lt: new Date('2026-11-02T02:00:00.000Z') },
        endsAt: { gt: startsAt },
      }),
    }));
    expect(lesson.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accountId,
        teacherId,
        startsAt,
        endsAt: new Date('2026-11-02T02:00:00.000Z'),
        status: 'SCHEDULED',
      }),
    }));
  });

  it('allows a lesson to start exactly when another lesson for the teacher ends', async () => {
    const { service, lesson } = makeService();
    const startsAt = new Date('2026-11-02T02:00:00.000Z');

    await service.createSingle({ accountId, teacherId, startsAt }, owner);

    expect(lesson.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        startsAt: { lt: new Date('2026-11-02T03:00:00.000Z') },
        endsAt: { gt: startsAt },
      }),
    }));
    expect(lesson.create).toHaveBeenCalledOnce();
  });

  it('rejects an overlapping active lesson for the same teacher', async () => {
    const { service, lesson } = makeService({
      findFirst: vi.fn(async () => makeLesson({ id: 'existing-lesson' })),
    });

    await expect(service.createSingle({
      accountId,
      teacherId,
      startsAt: new Date('2026-11-02T01:30:00.000Z'),
    }, owner)).rejects.toMatchObject({ status: 409 });
    expect(lesson.create).not.toHaveBeenCalled();
  });

  it('reschedules only a scheduled lesson and recalculates its end from the course default duration', async () => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson()),
    });
    const startsAt = new Date('2026-11-03T03:15:00.000Z');

    await service.reschedule(lessonId, { startsAt }, owner);

    expect(lesson.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { not: lessonId },
        teacherId,
        status: { not: 'CANCELLED' },
        startsAt: { lt: new Date('2026-11-03T04:15:00.000Z') },
        endsAt: { gt: startsAt },
      }),
    }));
    expect(lesson.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: lessonId },
      data: expect.objectContaining({ startsAt, endsAt: new Date('2026-11-03T04:15:00.000Z') }),
    }));
  });

  it('prevents a teacher from rescheduling another teacher’s lesson', async () => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson()),
    });

    await expect(service.reschedule(lessonId, {
      startsAt: new Date('2026-11-03T03:15:00.000Z'),
    }, otherTeacher)).rejects.toBeInstanceOf(ForbiddenException);
    expect(lesson.update).not.toHaveBeenCalled();
  });

  it('cancels a scheduled lesson without writing payment or consumption records', async () => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson()),
      update: vi.fn(async () => makeLesson({ status: 'CANCELLED', note: '学生请假' })),
    });

    await service.cancel(lessonId, { note: '学生请假' }, teacher);

    expect(lesson.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: lessonId },
      data: expect.objectContaining({ status: 'CANCELLED', note: '学生请假' }),
    }));
    expect(Object.keys(lesson)).toEqual(expect.arrayContaining(['update']));
    expect(lesson).not.toHaveProperty('paymentRecord');
    expect(lesson).not.toHaveProperty('ledgerEntry');
  });

  it.each(['COMPLETED', 'CANCELLED'])('does not allow %s lessons to be rescheduled or cancelled', async (status) => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson({ status })),
    });
    const startsAt = new Date('2026-11-03T03:15:00.000Z');

    await expect(service.reschedule(lessonId, { startsAt }, owner)).rejects.toMatchObject({ status: 409 });
    await expect(service.cancel(lessonId, { note: '请假' }, owner)).rejects.toMatchObject({ status: 409 });
    expect(lesson.update).not.toHaveBeenCalled();
  });

  it('limits a teacher’s schedule list to their own lessons while allowing the owner to list all lessons', async () => {
    const { service, lesson } = makeService();

    await service.listForActor(teacher);
    await service.listForActor(owner);

    expect(lesson.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { teacherId },
    }));
    expect(lesson.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {},
    }));
  });

  it('prevents a teacher from cancelling another teacher’s lesson', async () => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson()),
    });

    await expect(service.cancel(lessonId, { note: '请假' }, otherTeacher))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(lesson.update).not.toHaveBeenCalled();
  });
});
