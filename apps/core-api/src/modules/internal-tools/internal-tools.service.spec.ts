import { ForbiddenException } from '@nestjs/common';
import { LessonStatus, Prisma, UserRole } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { InternalToolsService } from './internal-tools.service.js';

function mockPrisma() {
  return {
    user: { findUnique: vi.fn() },
    lesson: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    student: { findMany: vi.fn() },
    studentCourseAccount: { findMany: vi.fn(), findUnique: vi.fn() },
    teacher: { findMany: vi.fn() },
    payroll: { count: vi.fn(), findMany: vi.fn() },
    ledgerEntry: { findMany: vi.fn() },
    refundRecord: { findMany: vi.fn() },
    closedPeriod: { findUnique: vi.fn() },
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
    prisma.lesson.findMany.mockResolvedValue([
      { id: 'lesson-1', startsAt: new Date('2026-10-31T17:00:00.000Z'), endsAt: new Date('2026-10-31T17:45:00.000Z'), status: 'SCHEDULED', account: { student: { name: '小明' }, course: { name: '主课' } }, teacher: { name: '王老师' } },
    ]);
    prisma.student.findMany.mockResolvedValue([
      { withdrawnAt: null, courseAccounts: [{ createdAt: new Date('2026-09-01T00:00:00Z'), lessons: [] }] },
      { withdrawnAt: null, courseAccounts: [{ createdAt: new Date('2026-10-02T00:00:00Z'), lessons: [] }] },
      { withdrawnAt: null, courseAccounts: [] },
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
      todayEndedUnconfirmedCount: 1,
      todayLessonItems: [{ lessonId: 'lesson-1', startsAt: '2026-10-31T17:00:00.000Z', endsAt: '2026-10-31T17:45:00.000Z', startTime: '01:00', studentName: '小明', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' }],
      monthlyOperatingIncome: null,
      frozenStudentCount: 1, studentsWithNegativeBalanceCount: 1, unpaidPayrollCount: 4,
      highlights: [
        '今日课程 6 节（待上 3、已完成 2、已取消 1）',
        '已结束未确认课程 1 节',
        '冻结学生 1 人',
        '欠费学生 1 人（按课程实收负余额）',
        '2026-11 待支付工资 4 笔',
      ],
    });
    expect(prisma.lesson.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['status'],
      where: { startsAt: { gte: new Date('2026-10-31T16:00:00.000Z'), lt: new Date('2026-11-01T16:00:00.000Z') } },
    }));
    expect(prisma.lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { startsAt: { gte: new Date('2026-10-31T16:00:00.000Z'), lt: new Date('2026-11-01T16:00:00.000Z') } },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
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
    prisma.lesson.findMany.mockResolvedValue([{ id: 'own-lesson', startsAt: new Date('2026-10-17T03:00:00.000Z'), endsAt: new Date('2026-10-17T03:45:00.000Z'), status: 'SCHEDULED', account: { student: { name: '小红' }, course: { name: '陪练' } }, teacher: { name: '李老师' } }]);

    const summary = await service.dashboardSummary('teacher-user', new Date('2026-10-17T04:00:00.000Z'));

    expect(summary).toEqual({
      role: 'TEACHER', businessDate: '2026-10-17', todayScheduledCount: 2, futureScheduledCount: 5,
      todayLessonItems: [{ lessonId: 'own-lesson', startsAt: '2026-10-17T03:00:00.000Z', endsAt: '2026-10-17T03:45:00.000Z', startTime: '11:00', studentName: '小红', courseName: '陪练', teacherName: '李老师', statusLabel: '待上课' }],
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
    expect(prisma.lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { teacherId: 'teacher-1', status: 'SCHEDULED', startsAt: { gte: new Date('2026-10-16T16:00:00.000Z'), lt: new Date('2026-10-17T16:00:00.000Z') } },
    }));
  });

  it('includes monthly operating income when the reports service is available', async () => {
    const prisma = mockPrisma();
    const reports = { monthly: vi.fn().mockResolvedValue({ lessonIncome: '1200.00', refundFeeIncome: '30.00', manualIncome: '70.00' }) };
    const service = new InternalToolsService(prisma as never, reports as never);
    prisma.user.findUnique.mockResolvedValue({ id: 'owner-1', role: UserRole.OWNER, teacher: null, isActive: true });
    prisma.lesson.groupBy.mockResolvedValue([]);
    prisma.lesson.findMany.mockResolvedValue([]);
    prisma.student.findMany.mockResolvedValue([]);
    prisma.studentCourseAccount.findMany.mockResolvedValue([]);
    prisma.payroll.count.mockResolvedValue(0);

    const summary = await service.dashboardSummary('owner-1', new Date('2026-10-17T04:00:00.000Z'));

    expect(reports.monthly).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00.000Z'));
    expect(summary.highlights).toContain('2026-10 经营收入 1300.00 元');
    expect(summary).toMatchObject({ monthlyOperatingIncome: '1300.00', todayLessonItems: [] });
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

describe('InternalToolsService AI read tools', () => {
  it('returns a safe owner directory through the domain services', async () => {
    const prisma = mockPrisma();
    const students = { list: vi.fn().mockResolvedValue([{ id: 's1', name: '小明', enrollmentStatus: 'STUDYING', notes: 'private' }]) };
    const teachers = { list: vi.fn().mockResolvedValue([{ id: 't1', name: '王老师', isActive: true, defaultBaseSalary: '9000.00', defaultCommissionRate: '10.0000' }]) };
    const courses = { list: vi.fn().mockResolvedValue([{ id: 'c1', name: '钢琴', isActive: true, defaultUnitPrice: '200.00', defaultDurationMinutes: 45 }]) };
    const service = new InternalToolsService(prisma as never, undefined, undefined, undefined, students as never, teachers as never, courses as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });

    await expect(service.directory('owner-1')).resolves.toEqual({
      students: [{ studentId: 's1', name: '小明', enrollmentStatus: 'STUDYING' }],
      teachers: [{ teacherId: 't1', name: '王老师', isActive: true }],
      courses: [{ courseId: 'c1', name: '钢琴', defaultUnitPrice: '200.00', defaultDurationMinutes: 45, isActive: true }],
    });
    expect(students.list).toHaveBeenCalledOnce();
    expect(teachers.list).toHaveBeenCalledOnce();
    expect(courses.list).toHaveBeenCalledOnce();
  });

  it('rejects non-owner subjects before every owner-only read', async () => {
    const prisma = mockPrisma();
    const students = { list: vi.fn() };
    const teachers = { list: vi.fn() };
    const courses = { list: vi.fn() };
    const ledger = { getBalance: vi.fn() };
    const service = new InternalToolsService(prisma as never, undefined, undefined, ledger as never, students as never, teachers as never, courses as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });

    for (const operation of [
      () => service.directory('teacher-user'),
      () => service.arrearsAndFrozen('teacher-user'),
      () => service.monthlyConsumption('teacher-user', { period: '2026-10' }),
      () => service.periodPreclose('teacher-user', { period: '2026-10' }),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(students.list).not.toHaveBeenCalled();
    expect(teachers.list).not.toHaveBeenCalled();
    expect(courses.list).not.toHaveBeenCalled();
    expect(ledger.getBalance).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('lists course-specific paid arrears and domain-calculated frozen students, excluding withdrawn students', async () => {
    const prisma = mockPrisma();
    const students = { list: vi.fn().mockResolvedValue([
      { id: 'frozen', name: '冻结生', enrollmentStatus: 'FROZEN' },
      { id: 'withdrawn', name: '退学生', enrollmentStatus: 'WITHDRAWN' },
    ]) };
    const ledger = { getBalance: vi.fn().mockImplementation(async (accountId: string) => ({
      accountId, paidBalance: accountId === 'debt' ? '-10.00' : '500.00', giftBalance: '0.00', totalBalance: accountId === 'debt' ? '-10.00' : '500.00',
    })) };
    const service = new InternalToolsService(prisma as never, undefined, undefined, ledger as never, students as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findMany.mockResolvedValue([
      { id: 'debt', studentId: 's1', student: { id: 's1', name: '欠费生', withdrawnAt: null }, course: { id: 'c1', name: '主课' } },
      { id: 'credit', studentId: 's1', student: { id: 's1', name: '欠费生', withdrawnAt: null }, course: { id: 'c2', name: '陪练' } },
      { id: 'withdrawn-debt', studentId: 's2', student: { id: 's2', name: '退学生', withdrawnAt: new Date() }, course: { id: 'c1', name: '主课' } },
    ]);

    await expect(service.arrearsAndFrozen('owner-1')).resolves.toEqual({
      arrears: [{ studentId: 's1', studentName: '欠费生', courseId: 'c1', courseName: '主课', paidBalance: '-10.00' }],
      frozenStudents: [{ studentId: 'frozen', name: '冻结生', reason: '连续31天未完成课程' }],
    });
    expect(ledger.getBalance).toHaveBeenCalledTimes(2);
    expect(prisma.studentCourseAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { student: { withdrawnAt: null } },
      select: expect.objectContaining({ student: { select: { id: true, name: true, withdrawnAt: true } } }),
    }));
  });

  it('groups actual monthly consumption and reversal ledger deltas by course, teacher, and student', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.ledgerEntry.findMany.mockResolvedValue([
      { kind: 'LESSON_CONSUMPTION', paidDelta: new Prisma.Decimal('-200'), giftDelta: new Prisma.Decimal(0), account: { student: { id: 's1', name: '小明' }, course: { id: 'c1', name: '钢琴' } }, lesson: { teacher: { id: 't1', name: '王老师' } }, reversesEntry: null },
      { kind: 'LESSON_CONSUMPTION_REVERSAL', paidDelta: new Prisma.Decimal('50'), giftDelta: new Prisma.Decimal(0), account: { student: { id: 's1', name: '小明' }, course: { id: 'c1', name: '钢琴' } }, lesson: null, reversesEntry: { lesson: { teacher: { id: 't1', name: '王老师' } } } },
    ]);

    await expect(service.monthlyConsumption('owner-1', { period: '2026-10' })).resolves.toEqual({
      period: '2026-10',
      totalAmount: '150.00',
      courses: [{ id: 'c1', name: '钢琴', amount: '150.00' }],
      teachers: [{ id: 't1', name: '王老师', amount: '150.00' }],
      students: [{ id: 's1', name: '小明', amount: '150.00' }],
    });
    expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: { in: ['LESSON_CONSUMPTION', 'LESSON_CONSUMPTION_REVERSAL', 'LESSON_CONSUMPTION_CORRECTION'] }, occurredAt: { gte: new Date('2026-09-30T16:00:00.000Z'), lt: new Date('2026-10-31T16:00:00.000Z') } },
    }));
  });

  it('builds a period preclose checklist from pending lessons, refund facts, missing payroll, ledger links, and closed state', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.lesson.findMany
      .mockResolvedValueOnce([{ id: 'lesson-pending', endsAt: new Date('2026-10-20T02:00:00Z'), account: { student: { name: '小明' }, course: { name: '钢琴' } }, teacher: { name: '王老师' } }])
      .mockResolvedValueOnce([{ teacherId: 't1', teacher: { id: 't1', name: '王老师' } }]);
    prisma.payroll.findMany.mockResolvedValue([]);
    prisma.refundRecord.findMany.mockResolvedValue([{
      id: 'refund-1', totalPaidRefund: new Prisma.Decimal('100'), feeAmount: new Prisma.Decimal('5'), actualRefundAmount: new Prisma.Decimal('95'),
      student: { name: '小红' }, details: [{ paidRefundAmount: new Prisma.Decimal('90'), ledgerEntries: [{ kind: 'REFUND_PAID', paidDelta: new Prisma.Decimal('-90') }] }],
    }]);
    prisma.ledgerEntry.findMany.mockResolvedValue([{
      id: 'bad-reversal', kind: 'LESSON_CONSUMPTION_REVERSAL', paidDelta: new Prisma.Decimal('1'), giftDelta: new Prisma.Decimal('0'), lessonId: null, lesson: null, reversesEntry: null,
    }]);
    prisma.closedPeriod.findUnique.mockResolvedValue({ reopenedAt: null });

    await expect(service.periodPreclose('owner-1', { period: '2026-10' })).resolves.toMatchObject({
      period: '2026-10', closed: true,
      pendingLessons: [{ lessonId: 'lesson-pending', studentName: '小明', courseName: '钢琴', teacherName: '王老师' }],
      refundAnomalies: [
        { refundId: 'refund-1', studentName: '小红', issue: '退款明细实收合计与退款记录不一致' },
        { refundId: 'refund-1', studentName: '小红', issue: '退款实收流水合计与退款记录不一致' },
      ],
      missingPayrollTeachers: [{ teacherId: 't1', teacherName: '王老师' }],
      ledgerAnomalies: [{ entryId: 'bad-reversal', kind: 'LESSON_CONSUMPTION_REVERSAL', issue: '课消冲正未关联匹配原流水或金额不相反' }],
      reminders: [{ code: 'CLOSING_SEVERITY_UNSPECIFIED', requiresHumanJudgment: true }],
    });
    expect(prisma.lesson.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ status: LessonStatus.SCHEDULED, startsAt: { gte: new Date('2026-09-30T16:00:00.000Z'), lt: new Date('2026-10-31T16:00:00.000Z') } }),
    }));
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

  it('lists every course account for an exact student when courseName is omitted, without balances', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findMany.mockResolvedValue([
      { id: 'account-a', student: { name: '林同学' }, course: { name: '主课' } },
      { id: 'account-b', student: { name: '林同学' }, course: { name: '陪练' } },
    ]);

    await expect(service.courseAccountCandidates('owner-1', { studentName: '林同学' })).resolves.toEqual({
      candidates: [
        { accountId: 'account-a', studentName: '林同学', courseName: '主课' },
        { accountId: 'account-b', studentName: '林同学', courseName: '陪练' },
      ],
    });
    expect(prisma.studentCourseAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { student: { name: '林同学' } },
      select: expect.not.objectContaining({ currentUnitPrice: true }),
    }));
  });

  it('searches student names safely, prefers all exact names, and exposes no financial fields', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findMany.mockResolvedValue([
      { id: 'account-fuzzy', student: { name: '测试林同学' }, course: { name: '陪练' } },
      { id: 'account-exact-a', student: { name: '林同学' }, course: { name: '主课' } },
      { id: 'account-exact-b', student: { name: '林同学' }, course: { name: '陪练' } },
    ]);

    await expect(service.courseAccountCandidates('owner-1', {
      studentName: '林同学', courseName: undefined, match: 'search',
    })).resolves.toEqual({ candidates: [
      { accountId: 'account-exact-a', studentName: '林同学', courseName: '主课' },
      { accountId: 'account-exact-b', studentName: '林同学', courseName: '陪练' },
    ] });
    expect(prisma.studentCourseAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { student: { name: { contains: '林同学', mode: 'insensitive' } } },
      select: {
        id: true,
        student: { select: { name: true } },
        course: { select: { name: true } },
      },
    }));
    expect(prisma.studentCourseAccount.findMany.mock.calls[0]?.[0].select).not.toHaveProperty('balance');
    expect(prisma.studentCourseAccount.findMany.mock.calls[0]?.[0].select).not.toHaveProperty('currentUnitPrice');
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

  it('returns all fuzzy student candidates when no exact name exists', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.student.findMany.mockResolvedValue([
      { id: 'student-a', name: '测试小明' },
      { id: 'student-b', name: '小明家长' },
    ]);

    await expect(service.studentCandidates('owner-1', { studentName: '小明', match: 'search' })).resolves.toEqual({
      candidates: [{ studentId: 'student-a', name: '测试小明' }, { studentId: 'student-b', name: '小明家长' }],
    });
    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: { name: { contains: '小明', mode: 'insensitive' } },
      orderBy: { id: 'asc' }, select: { id: true, name: true },
    });
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

  it('searches lessons by student name while preserving teacher isolation and ambiguity', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-own', isActive: true } });
    prisma.lesson.findMany.mockResolvedValue([
      { id: 'lesson-own', startsAt: new Date('2026-10-18T02:00:00.000Z'), status: 'COMPLETED', account: { student: { name: '小明' }, course: { name: '主课' } }, teacher: { name: '王老师' } },
      { id: 'lesson-own-duplicate', startsAt: new Date('2026-10-18T03:00:00.000Z'), status: 'SCHEDULED', account: { student: { name: '小明' }, course: { name: '陪练' } }, teacher: { name: '王老师' } },
    ]);

    await expect(service.lessonCandidates('teacher-user', { studentName: '小明', date: '2026-10-18', match: 'search' })).resolves.toEqual({ candidates: [
      { lessonId: 'lesson-own', studentName: '小明', courseName: '主课', teacherName: '王老师', startsAt: new Date('2026-10-18T02:00:00.000Z'), status: 'COMPLETED' },
      { lessonId: 'lesson-own-duplicate', studentName: '小明', courseName: '陪练', teacherName: '王老师', startsAt: new Date('2026-10-18T03:00:00.000Z'), status: 'SCHEDULED' },
    ] });
    expect(prisma.lesson.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        account: { student: { name: { contains: '小明', mode: 'insensitive' } } },
        startsAt: { gte: new Date('2026-10-17T16:00:00.000Z'), lt: new Date('2026-10-18T16:00:00.000Z') },
        teacherId: 'teacher-own',
      },
    }));
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

  it('searches only the requesting teacher record for a teacher capability subject', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ id: 'teacher-user', role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-own', name: '测试王老师', isActive: true } });
    prisma.teacher.findMany.mockResolvedValue([{ id: 'teacher-own', name: '测试王老师' }]);

    await expect(service.teacherCandidates('teacher-user', { teacherName: '王老师', match: 'search' })).resolves.toEqual({
      candidates: [{ teacherId: 'teacher-own', name: '测试王老师' }],
    });
    expect(prisma.teacher.findMany).toHaveBeenCalledWith({
      where: { id: 'teacher-own', name: { contains: '王老师', mode: 'insensitive' }, isActive: true },
      orderBy: { id: 'asc' }, select: { id: true, name: true },
    });
  });
});

describe('InternalToolsService.listLessons', () => {
  it('uses inclusive Shanghai business-day boundaries and the deterministic lesson service', async () => {
    const prisma = mockPrisma();
    const lessons = { listForActorInRange: vi.fn().mockResolvedValue([{
      id: 'lesson-1', accountId: 'account-1', teacherId: 'teacher-1',
      startsAt: new Date('2026-10-21T15:59:59.999Z'), endsAt: new Date('2026-10-21T16:45:00.000Z'),
      status: LessonStatus.SCHEDULED,
      student: { id: 'student-1', name: '小明' }, course: { id: 'course-1', name: '主课' },
      teacher: { id: 'teacher-1', name: '王老师' },
    }]) };
    const service = new InternalToolsService(prisma as never, undefined, lessons as never);
    prisma.user.findUnique.mockResolvedValue({
      id: 'teacher-user', role: UserRole.TEACHER, isActive: true,
      teacher: { id: 'teacher-1', name: '王老师', isActive: true },
    });

    await expect(service.listLessons('teacher-user', {
      dateFrom: '2026-10-21', dateTo: '2026-10-21', studentName: '小明', courseName: '主课', statusText: '待上课',
    })).resolves.toEqual({ businessDate: '2026-10-21', dateFrom: '2026-10-21', dateTo: '2026-10-21', lessons: [{
      lessonId: 'lesson-1', accountId: 'account-1', teacherId: 'teacher-1',
      startsAt: '2026-10-21T15:59:59.999Z', endsAt: '2026-10-21T16:45:00.000Z',
      studentName: '小明', courseName: '主课', teacherName: '王老师', statusLabel: '待上课', status: LessonStatus.SCHEDULED,
    }] });
    expect(lessons.listForActorInRange).toHaveBeenCalledWith(
      { id: 'teacher-user', username: '', role: UserRole.TEACHER, teacherId: 'teacher-1' },
      {
        startsAt: new Date('2026-10-20T16:00:00.000Z'),
        endsAt: new Date('2026-10-21T16:00:00.000Z'),
        studentName: '小明', courseName: '主课', teacherName: undefined, status: LessonStatus.SCHEDULED,
      },
    );
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('does not allow an unlinked or inactive teacher capability to query lessons', async () => {
    const prisma = mockPrisma();
    const lessons = { listForActorInRange: vi.fn() };
    const service = new InternalToolsService(prisma as never, undefined, lessons as never);
    prisma.user.findUnique.mockResolvedValue({
      id: 'teacher-user', role: UserRole.TEACHER, isActive: true, teacher: null,
    });

    await expect(service.listLessons('teacher-user', {
      dateFrom: '2026-10-21', dateTo: '2026-10-21',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(lessons.listForActorInRange).not.toHaveBeenCalled();
  });
});

describe('InternalToolsService.courseAccount', () => {
  it('returns owner-only account metadata with balances delegated to CourseLedgerService', async () => {
    const prisma = mockPrisma();
    const ledger = { getBalance: vi.fn().mockResolvedValue({
      accountId: 'account-1', paidBalance: '300.00', giftBalance: '50.00', totalBalance: '350.00',
    }) };
    const service = new InternalToolsService(prisma as never, undefined, undefined, ledger as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findUnique.mockResolvedValue({
      id: 'account-1', currentUnitPrice: new Prisma.Decimal('200'),
      student: { name: '林同学' }, course: { name: '主课' },
    });

    await expect(service.courseAccount('owner-1', { accountId: 'account-1' })).resolves.toEqual({
      accountId: 'account-1', studentName: '林同学', courseName: '主课',
      currentUnitPrice: '200.00', paidBalance: '300.00', giftBalance: '50.00', totalBalance: '350.00',
    });
    expect(ledger.getBalance).toHaveBeenCalledWith('account-1');
  });

  it('rejects non-owner capability subjects before reading a course account', async () => {
    const prisma = mockPrisma();
    const ledger = { getBalance: vi.fn() };
    const service = new InternalToolsService(prisma as never, undefined, undefined, ledger as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });

    await expect(service.courseAccount('teacher-user', { accountId: 'account-1' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.studentCourseAccount.findUnique).not.toHaveBeenCalled();
    expect(ledger.getBalance).not.toHaveBeenCalled();
  });

});

describe('InternalToolsService first read tools', () => {
  it('delegates owner monthly report calculation to ReportsService.monthly', async () => {
    const prisma = mockPrisma();
    const reports = { monthly: vi.fn().mockResolvedValue({
      periodStart: new Date('2026-10-01T00:00:00.000Z'), lessonIncome:'10.00', refundFeeIncome:'2.00', manualIncome:'3.00', cashNet:'-4.00', payrollCost:'7.00',giftCost:'4.00',manualExpense:'3.00',operatingExpense:'14.00',operatingProfit: '1.00',
    }) };
    const service = new InternalToolsService(prisma as never, reports as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });

    await expect(service.monthlyReport('owner-1', { period: '2026-10' })).resolves.toEqual({
      period: '2026-10', report: { periodStart: new Date('2026-10-01T00:00:00.000Z'), lessonIncome:'10.00', refundFeeIncome:'2.00', manualIncome:'3.00', cashNet:'-4.00', payrollCost:'7.00',giftCost:'4.00',manualExpense:'3.00',operatingProfit: '1.00', operatingIncome:'15.00',operatingExpense:'14.00', cashOperatingGap:'5.00' },
    });
    expect(reports.monthly).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('filters the ledger by account and returns operator, time, kind, both deltas and note to owners only', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.studentCourseAccount.findUnique.mockResolvedValue({ id: 'account-1' });
    prisma.ledgerEntry.findMany.mockResolvedValue([{
      id: 'entry-1', occurredAt: new Date('2026-10-03T02:00:00.000Z'), kind: 'PAYMENT',
      paidDelta: new Prisma.Decimal('100.00'), giftDelta: new Prisma.Decimal('0.00'), note: '续费',
      createdBy: { username: 'owner' },
    }]);

    await expect(service.courseAccountLedger('owner-1', { accountId: 'account-1' })).resolves.toEqual({
      accountId: 'account-1', entries: [{
        entryId: 'entry-1', occurredAt: '2026-10-03T02:00:00.000Z', kind: 'PAYMENT',
        amount: '100.00', paidDelta: '100.00', giftDelta: '0.00', note: '续费', operator: 'owner',
      }],
    });
    expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: 'account-1' },
      select: expect.objectContaining({ createdBy: { select: { username: true } } }),
    }));

    prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });
    await expect(service.courseAccountLedger('teacher-1', { accountId: 'account-1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ledgerEntry.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns persisted monthly payroll facts for owners and only the linked teacher for teachers', async () => {
    const prisma = mockPrisma();
    const service = new InternalToolsService(prisma as never);
    const row = {
      id: 'payroll-1', teacherId: 'teacher-1', periodStart: new Date('2026-10-01T00:00:00.000Z'),
      courseRevenue: new Prisma.Decimal('1000'), baseSalary: new Prisma.Decimal('500'),
      commissionRate: new Prisma.Decimal('10'), commissionAmount: new Prisma.Decimal('100'),
      bonusAmount: new Prisma.Decimal('20'), bonusNote: '奖励', deductionAmount: new Prisma.Decimal('5'),
      deductionNote: '代扣', grossSalary: new Prisma.Decimal('620'), netSalary: new Prisma.Decimal('615'),
      status: 'UNPAID', teacher: { name: '王老师' },
    };
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
    prisma.payroll.findMany.mockResolvedValue([row]);

    await expect(service.monthlyPayroll('owner-1', { period: '2026-10' })).resolves.toMatchObject({
      period: '2026-10', payrolls: [{ payrollId: 'payroll-1', courseRevenue: '1000.00', baseSalary: '500.00',
        commissionRate: '10.0000', commissionAmount: '100.00', bonusAmount: '20.00', deductionAmount: '5.00',
        grossSalary: '620.00', netSalary: '615.00', bonusNote: '奖励', deductionNote: '代扣' }],
    });
    expect(prisma.payroll.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { periodStart: new Date('2026-10-01T00:00:00.000Z') } }));

    prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true, teacher: { id: 'teacher-1', isActive: true } });
    prisma.payroll.findMany.mockResolvedValue([row]);
    await service.monthlyPayroll('teacher-user', { period: '2026-10' });
    expect(prisma.payroll.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { periodStart: new Date('2026-10-01T00:00:00.000Z'), teacherId: 'teacher-1' },
    }));
  });
});
