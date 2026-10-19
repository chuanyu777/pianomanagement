import { ForbiddenException } from '@nestjs/common';
import { Prisma, UserRole } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { InternalToolsService } from './internal-tools.service.js';

function mockPrisma() {
  return {
    user: { findUnique: vi.fn() },
    lesson: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    student: { findMany: vi.fn() },
    studentCourseAccount: { findMany: vi.fn() },
    teacher: { findMany: vi.fn() },
    payroll: { count: vi.fn() },
  };
}

describe('InternalToolsService.dashboardSummary', () => {
  it('returns owner-only operating counts with Shanghai day and month boundaries', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    const now = new Date('2026-10-31T18:30:00.000Z');
    prisma.user.findUnique.mockResolvedValue({ id: 'owner-1', role: UserRole.OWNER, teacher: null, isActive: true });
    prisma.lesson.groupBy.mockResolvedValue([
      { status: 'SCHEDULED', _count: { _all: 3 } },
      { status: 'COMPLETED', _count: { _all: 2 } },
      { status: 'CANCELLED', _count: { _all: 1 } },
    ]);
    prisma.student.findMany.mockResolvedValue([
      { withdrawnAt: null, courseAccounts: [{ createdAt: new Date('2026-09-01T00:00:00Z'), lessons: [] }] },
      { withdrawnAt: null, courseAccounts: [{ createdAt: new Date('2026-10-02T00:00:00Z'), lessons: [] }] },
    ]);
    prisma.studentCourseAccount.findMany.mockResolvedValue([
      { studentId: 'student-1', openingPaidBalance: new Prisma.Decimal('10'), ledgerEntries: [{ paidDelta: new Prisma.Decimal('-12') }] },
      { studentId: 'student-1', openingPaidBalance: new Prisma.Decimal('0'), ledgerEntries: [] },
      { studentId: 'student-2', openingPaidBalance: new Prisma.Decimal('0'), ledgerEntries: [] },
    ]);
    prisma.payroll.count.mockResolvedValue(4);

    const summary = await service.dashboardSummary('owner-1', now);

    expect(summary).toEqual({
      role: 'OWNER', businessDate: '2026-11-01', period: '2026-11',
      todayLessons: { total: 6, scheduled: 3, completed: 2, cancelled: 1 },
      frozenStudentCount: 1, studentsWithNegativeBalanceCount: 1, unpaidPayrollCount: 4,
      highlights: [
        '今日课程 6 节（待上 3、已完成 2、已取消 1）',
        '冻结学生 1 人',
        '课程账户负余额学生 1 人',
        '2026-11 待发工资 4 笔',
      ],
    });
    expect(prisma.lesson.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['status'],
      where: { startsAt: { gte: new Date('2026-10-31T16:00:00.000Z'), lt: new Date('2026-11-01T16:00:00.000Z') } },
    }));
    expect(prisma.payroll.count).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'UNPAID', periodStart: new Date('2026-10-31T16:00:00.000Z') },
    }));
  });

  it('limits teacher output to own today and future scheduled lesson counts', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ id: 'teacher-user', role: UserRole.TEACHER, teacher: { id: 'teacher-1' }, isActive: true });
    prisma.lesson.count.mockResolvedValueOnce(2).mockResolvedValueOnce(5);

    const summary = await service.dashboardSummary('teacher-user', new Date('2026-10-17T04:00:00.000Z'));

    expect(summary).toEqual({
      role: 'TEACHER', businessDate: '2026-10-17', todayScheduledCount: 2, futureScheduledCount: 5,
      highlights: ['今日排课 2 节', '后续排课 5 节'],
    });
    expect(prisma.lesson.count).toHaveBeenNthCalledWith(1, {
      where: { teacherId: 'teacher-1', status: 'SCHEDULED', startsAt: { gte: new Date('2026-10-16T16:00:00.000Z'), lt: new Date('2026-10-17T16:00:00.000Z') } },
    });
    expect(prisma.lesson.count).toHaveBeenNthCalledWith(2, {
      where: { teacherId: 'teacher-1', status: 'SCHEDULED', startsAt: { gte: new Date('2026-10-17T16:00:00.000Z') } },
    });
    expect(prisma.student.findMany).not.toHaveBeenCalled();
    expect(prisma.payroll.count).not.toHaveBeenCalled();
  });

  it('rejects unknown, inactive and unlinked capability subjects', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'inactive', isActive: false }).mockResolvedValueOnce({ id: 'unlinked', isActive: true, role: UserRole.TEACHER, teacher: null });

    await expect(service.dashboardSummary('missing')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.dashboardSummary('inactive')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.dashboardSummary('unlinked')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('InternalToolsService.courseAccountCandidates', () => {
  it('returns all exact account matches with only the required candidate fields', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findMany.mockResolvedValue([
      { id: 'account-a', student: { name: '林同学' }, course: { name: '钢琴' } },
      { id: 'account-b', student: { name: '林同学' }, course: { name: '钢琴' } },
    ]);

    await expect(service.courseAccountCandidates('owner-1', {
      studentName: '林同学', courseName: '钢琴',
    })).resolves.toEqual({ candidates: [
      { accountId: 'account-a', studentName: '林同学', courseName: '钢琴' },
      { accountId: 'account-b', studentName: '林同学', courseName: '钢琴' },
    ] });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner-1' }, select: { role: true, isActive: true },
    });
    expect(prisma.studentCourseAccount.findMany).toHaveBeenCalledWith({
      where: { student: { name: '林同学' }, course: { name: '钢琴' } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        student: { select: { name: true } },
        course: { select: { name: true } },
      },
    });
  });

  it('rejects missing, inactive and non-owner capability subjects before querying accounts', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ role: UserRole.OWNER, isActive: false })
      .mockResolvedValueOnce({ role: UserRole.TEACHER, isActive: true });
    const input = { studentName: '林同学', courseName: '钢琴' };

    await expect(service.courseAccountCandidates('missing', input)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.courseAccountCandidates('inactive', input)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.courseAccountCandidates('teacher', input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.studentCourseAccount.findMany).not.toHaveBeenCalled();
  });
});

describe('InternalToolsService.studentCandidates', () => {
  it('returns exact student candidates for an active owner', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.student.findMany.mockResolvedValue([
      { id: 'student-a', name: '小明' },
      { id: 'student-b', name: '小明' },
    ]);

    await expect(service.studentCandidates('owner-1', { studentName: '小明' })).resolves.toEqual({
      candidates: [{ studentId: 'student-a', name: '小明' }, { studentId: 'student-b', name: '小明' }],
    });
    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: { name: '小明' }, orderBy: { id: 'asc' }, select: { id: true, name: true },
    });
  });

  it('rejects inactive and non-owner subjects before querying students', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ role: UserRole.OWNER, isActive: false })
      .mockResolvedValueOnce({ role: UserRole.TEACHER, isActive: true });

    for (const subject of ['missing', 'inactive', 'teacher']) {
      await expect(service.studentCandidates(subject, { studentName: '小明' })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(prisma.student.findMany).not.toHaveBeenCalled();
  });
});

describe('InternalToolsService.lessonCandidates', () => {
  it('queries lessons through the account student relation and supports a Shanghai business date', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true, teacher: null });
    prisma.lesson.findMany.mockResolvedValue([
      { id: 'lesson-1', startsAt: new Date('2026-10-18T02:00:00.000Z'), status: 'COMPLETED', account: { student: { name: '小明' }, course: { name: '主课' } }, teacher: { name: '王老师' } },
    ]);

    await expect(service.lessonCandidates('owner-1', { studentName: '小明', date: '2026-10-18' })).resolves.toEqual({ candidates: [
      { lessonId: 'lesson-1', studentName: '小明', courseName: '主课', teacherName: '王老师', startsAt: new Date('2026-10-18T02:00:00.000Z'), status: 'COMPLETED' },
    ] });
    expect(prisma.lesson.findMany).toHaveBeenCalledWith({
      where: {
        account: { student: { name: '小明' } },
        startsAt: { gte: new Date('2026-10-17T16:00:00.000Z'), lt: new Date('2026-10-18T16:00:00.000Z') },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, startsAt: true, status: true,
        account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } },
        teacher: { select: { name: true } },
      },
    });
  });
});

describe('InternalToolsService.teacherCandidates', () => {
  it('lets an owner retrieve all exact matches for enabled teachers only', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ id: 'owner-1', role: UserRole.OWNER, isActive: true });
    prisma.teacher.findMany.mockResolvedValue([
      { id: 'teacher-a', name: '王老师' },
      { id: 'teacher-b', name: '王老师' },
    ]);

    await expect(service.teacherCandidates('owner-1', { teacherName: '王老师' })).resolves.toEqual({
      candidates: [
        { teacherId: 'teacher-a', name: '王老师' },
        { teacherId: 'teacher-b', name: '王老师' },
      ],
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner-1' }, select: { id: true, role: true, isActive: true, teacher: { select: { id: true, name: true, isActive: true } } },
    });
    expect(prisma.teacher.findMany).toHaveBeenCalledWith({
      where: { name: '王老师', isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
  });

  it('returns only the enabled teacher linked to a teacher capability subject on exact name match', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 'teacher-user', role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-1', name: '王老师', isActive: true } })
      .mockResolvedValueOnce({ id: 'teacher-user', role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-1', name: '王老师', isActive: true } });

    await expect(service.teacherCandidates('teacher-user', { teacherName: '王老师' })).resolves.toEqual({
      candidates: [{ teacherId: 'teacher-1', name: '王老师' }],
    });
    await expect(service.teacherCandidates('teacher-user', { teacherName: '王老师 ' })).resolves.toEqual({ candidates: [] });
    expect(prisma.teacher.findMany).not.toHaveBeenCalled();
  });

  it('rejects missing/inactive users and teachers, and never queries candidates for non-owners', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ role: UserRole.OWNER, isActive: false, teacher: null })
      .mockResolvedValueOnce({ role: UserRole.TEACHER, isActive: true, teacher: null })
      .mockResolvedValueOnce({ role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-1', name: '王老师', isActive: false } });

    for (const subject of ['missing', 'inactive-owner', 'unlinked-teacher', 'inactive-teacher']) {
      await expect(service.teacherCandidates(subject, { teacherName: '王老师' })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(prisma.teacher.findMany).not.toHaveBeenCalled();
  });
});
