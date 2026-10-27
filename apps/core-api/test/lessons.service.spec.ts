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
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => makeLesson()),
    update: vi.fn(async () => makeLesson()),
    ...overrides,
  };
  const teacherRecord = { id: teacherId, updatedAt: new Date('2026-10-17T01:00:00.000Z') };
  const teacherModel = { findUnique: vi.fn(async () => teacherRecord) };
  const tx = { studentCourseAccount, lesson, teacher: teacherModel, $queryRaw: vi.fn(async (strings: TemplateStringsArray) => strings[0]?.includes('Teacher') ? [{ id: teacherId }] : [{ id: accountId }]) };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
  return {
    service: new LessonsService({ studentCourseAccount, lesson, transaction } as never),
    studentCourseAccount,
    lesson,
    transaction,
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
    expect(lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
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

    expect(lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        startsAt: { lt: new Date('2026-11-02T03:00:00.000Z') },
        endsAt: { gt: startsAt },
      }),
    }));
    expect(lesson.create).toHaveBeenCalledOnce();
  });

  it('rejects an overlapping active lesson for the same teacher', async () => {
    const { service, lesson } = makeService({
      findMany: vi.fn(async () => [makeLesson({ id: 'existing-lesson' })]),
    });

    await expect(service.createSingle({
      accountId,
      teacherId,
      startsAt: new Date('2026-11-02T01:30:00.000Z'),
    }, owner)).rejects.toMatchObject({ status: 409 });
    expect(lesson.create).not.toHaveBeenCalled();
  });

  it('allows a teacher to preview only their own lesson and lets the owner choose the teacher', async () => {
    const { service } = makeService();
    await expect(service.previewSingle({ accountId, teacherId, startsAt: new Date('2026-11-02T01:00:00.000Z') }, teacher))
      .resolves.toMatchObject({ normalizedCommand: { teacherId } });
    await expect(service.previewSingle({ accountId, teacherId, startsAt: new Date('2026-11-02T01:00:00.000Z') }, otherTeacher))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.previewSingle({ accountId, teacherId, startsAt: new Date('2026-11-02T01:00:00.000Z') }, owner))
      .resolves.toMatchObject({ resourceVersions: { teacherId } });
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

  it('applies an exclusive time range without removing the teacher restriction', async () => {
    const { service, lesson } = makeService();
    const range = { from: new Date('2026-10-25T16:00:00Z'), to: new Date('2026-11-01T16:00:00Z') };
    await service.listForActor(teacher, range);
    expect(lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { teacherId, startsAt: { gte: range.from, lt: range.to } },
    }));
  });

  it('filters the safe range read by teacher, names and status without selecting money fields', async () => {
    const { service, lesson } = makeService({
      findMany: vi.fn(async () => [{
        id: lessonId,
        accountId,
        teacherId,
        startsAt: new Date('2026-10-21T15:59:59.999Z'),
        endsAt: new Date('2026-10-21T16:45:00.000Z'),
        status: 'SCHEDULED',
        account: {
          student: { id: studentId, name: '小明' },
          course: { id: 'course-1', name: '主课' },
        },
        teacher: { id: teacherId, name: '王老师' },
      }]),
    });
    const startsAt = new Date('2026-10-20T16:00:00.000Z');
    const endsAt = new Date('2026-10-21T16:00:00.000Z');

    await expect(service.listForActorInRange(teacher, {
      startsAt,
      endsAt,
      studentName: '小明',
      courseName: '主课',
      teacherName: '王老师',
      status: 'SCHEDULED',
    })).resolves.toEqual([{
      id: lessonId, accountId, teacherId,
      startsAt: new Date('2026-10-21T15:59:59.999Z'),
      endsAt: new Date('2026-10-21T16:45:00.000Z'),
      status: 'SCHEDULED',
      student: { id: studentId, name: '小明' },
      course: { id: 'course-1', name: '主课' },
      teacher: { id: teacherId, name: '王老师' },
    }]);
    expect(lesson.findMany).toHaveBeenCalledWith({
      where: {
        teacherId,
        startsAt: { gte: startsAt, lt: endsAt },
        account: { student: { name: '小明' }, course: { name: '主课' } },
        teacher: { name: '王老师' },
        status: 'SCHEDULED',
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: expect.not.objectContaining({ unitPriceSnapshot: true }),
    });
  });

  it('prevents a teacher from cancelling another teacher’s lesson', async () => {
    const { service, lesson } = makeService({
      findUnique: vi.fn(async () => makeLesson()),
    });

    await expect(service.cancel(lessonId, { note: '请假' }, otherTeacher))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(lesson.update).not.toHaveBeenCalled();
  });

  it('creates the requested weekly lessons in one transaction using the course duration', async () => {
    const startsAt = new Date('2026-11-02T01:00:00.000Z');
    const { service, lesson, transaction } = makeService({
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => makeLesson(data)),
    });

    const created = await service.createBatch({
      accountId,
      teacherId,
      firstStartsAt: startsAt,
      weeks: 3,
      note: '每周主课',
    }, owner);

    expect(transaction).toHaveBeenCalledOnce();
    expect(created).toHaveLength(3);
    expect(lesson.create).toHaveBeenCalledTimes(3);
    expect(lesson.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        accountId,
        teacherId,
        startsAt,
        endsAt: new Date('2026-11-02T02:00:00.000Z'),
        status: 'SCHEDULED',
        note: '每周主课',
      }),
      select: expect.any(Object),
    }));
    expect(lesson.create).toHaveBeenNthCalledWith(3, expect.objectContaining({
      data: expect.objectContaining({
        startsAt: new Date('2026-11-16T01:00:00.000Z'),
        endsAt: new Date('2026-11-16T02:00:00.000Z'),
      }),
    }));
  });

  it('returns the exact conflicting scheduled time and creates none when an existing lesson overlaps', async () => {
    const startsAt = new Date('2026-11-02T01:00:00.000Z');
    const { service, lesson } = makeService({
      findMany: vi.fn(async () => [makeLesson({
        id: 'existing-lesson',
        startsAt: new Date('2026-11-09T01:30:00.000Z'),
        endsAt: new Date('2026-11-09T02:30:00.000Z'),
      })]),
    });

    let response: unknown;
    try {
      await service.createBatch({ accountId, teacherId, firstStartsAt: startsAt, weeks: 2 }, owner);
    } catch (error) {
      response = (error as { getResponse?: () => unknown }).getResponse?.();
    }

    expect(response).toMatchObject({
      message: '批量排课存在时间冲突，未创建任何排课',
      conflicts: [{
        startsAt: '2026-11-09T01:00:00.000Z',
        endsAt: '2026-11-09T02:00:00.000Z',
        conflictingLessonId: 'existing-lesson',
      }],
    });
    expect(lesson.create).not.toHaveBeenCalled();
  });

  it('rejects any overlap between generated weekly lessons before writing the batch', async () => {
    const { service, lesson, studentCourseAccount } = makeService({ findMany: vi.fn(async () => []) });
    studentCourseAccount.findUnique.mockResolvedValue({
      id: accountId,
      studentId,
      student: { id: studentId, name: '小明' },
      course: { id: 'course-1', name: '长课', defaultDurationMinutes: 8 * 24 * 60 },
    });

    await expect(service.createBatch({
      accountId,
      teacherId,
      firstStartsAt: new Date('2026-11-02T01:00:00.000Z'),
      weeks: 2,
    }, owner)).rejects.toMatchObject({ status: 409 });
    expect(lesson.create).not.toHaveBeenCalled();
  });

  it('does not allow teachers to use owner-only batch scheduling', async () => {
    const { service, lesson, transaction } = makeService();

    await expect(service.createBatch({
      accountId,
      teacherId,
      firstStartsAt: new Date('2026-11-02T01:00:00.000Z'),
      weeks: 2,
    }, teacher)).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
    expect(lesson.create).not.toHaveBeenCalled();
  });
});
