import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { AssistantActionsService } from './assistant-actions.service.js';
import { StudentsService } from '../students/students.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { StudentCourseAccountsService } from '../student-course-accounts/student-course-accounts.service.js';

const owner = { id: 'owner-1', username: 'owner', role: 'OWNER' as const };

function setup(actionType: string, command: Record<string, unknown>) {
  const preview = {
    id: 'preview-1', actorUserId: owner.id, actionType, schemaVersion: `${actionType}.v1`, riskLevel: 'L2',
    normalizedCommandJson: command, displayJson: {}, resourceVersionsJson: {}, idempotencyKey: 'preview-key',
    status: 'PENDING', expiresAt: new Date(Date.now() + 300_000), executedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    actionPreview: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...preview, ...data })),
      findUnique: vi.fn().mockResolvedValue(preview),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...preview, ...data })),
    },
    businessAuditEvent: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ ...owner, isActive: true, teacher: null }) },
    actionPreview: { findUnique: vi.fn().mockResolvedValue({ actionType }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const students = {
    previewCreate: vi.fn().mockResolvedValue({ input: { name: '小雨', notes: null } }),
    previewUpdate: vi.fn().mockResolvedValue({ input: { name: '小雨2' }, resourceVersions: { studentId: 'student-1', updatedAt: '2026-10-20T00:00:00.000Z' }, display: { nameBefore: '小雨', nameAfter: '小雨2' } }),
    createInTransaction: vi.fn().mockResolvedValue({ id: 'student-1', name: '小雨', notes: null, enrollmentStatus: 'FROZEN' }),
    updateInTransaction: vi.fn().mockResolvedValue({ id: 'student-1', name: '小雨2', notes: null, enrollmentStatus: 'FROZEN' }),
  };
  const courses = {
    previewCreate: vi.fn().mockResolvedValue({ input: { name: '钢琴课', defaultUnitPrice: new Prisma.Decimal('200.00'), defaultDurationMinutes: 45 } }),
    previewUpdate: vi.fn().mockResolvedValue({ input: { name: '钢琴进阶' }, resourceVersions: { courseId: 'course-1', updatedAt: '2026-10-20T00:00:00.000Z' }, display: { nameBefore: '钢琴课', nameAfter: '钢琴进阶' } }),
    createInTransaction: vi.fn().mockResolvedValue({ id: 'course-1', name: '钢琴课', defaultUnitPrice: '200.00', defaultDurationMinutes: 45, isActive: true }),
    updateInTransaction: vi.fn().mockResolvedValue({ id: 'course-1', name: '钢琴进阶', defaultUnitPrice: '200.00', defaultDurationMinutes: 45, isActive: true }),
  };
  const accounts = {
    previewOpen: vi.fn().mockResolvedValue({
      input: { courseId: 'course-1', currentUnitPrice: '200.00' },
      resourceVersions: { studentId: 'student-1', studentUpdatedAt: '2026-10-20T00:00:00.000Z', courseId: 'course-1', courseUpdatedAt: '2026-10-20T00:00:00.000Z' },
      display: { studentName: '小雨', courseName: '钢琴课', currentUnitPrice: '200.00' },
    }),
    previewPrice: vi.fn().mockResolvedValue({
      input: { currentUnitPrice: '220.00' },
      resourceVersions: { accountId: 'account-1', version: 3 },
      display: { courseName: '钢琴课', priceBefore: '200.00', priceAfter: '220.00' },
    }),
    openInTransaction: vi.fn().mockResolvedValue({ id: 'account-1', studentId: 'student-1', courseId: 'course-1', currentUnitPrice: '200.00', version: 0 }),
    updatePriceInTransaction: vi.fn().mockResolvedValue({ id: 'account-1', currentUnitPrice: '220.00', version: 4 }),
  };
  const teachers = {
    previewCreateProfile: vi.fn(({ name, defaultBaseSalary, defaultCommissionRate }) => ({ name, defaultBaseSalary, defaultCommissionRate })),
    previewUpdateCompensation: vi.fn().mockResolvedValue({ teacher:{ id:'teacher-1',name:'赵老师',defaultBaseSalary:'2000.00',defaultCommissionRate:'10.0000' },updatedAt:new Date('2026-10-20T00:00:00.000Z'),nextBaseSalary:'2200.00',nextCommissionRate:'12.0000' }),
    createProfileInTransaction: vi.fn().mockResolvedValue({ id:'teacher-1',name:'赵老师',userId:null,username:null,defaultBaseSalary:'2000.00',defaultCommissionRate:'10.0000' }),
    updateCompensationInTransaction: vi.fn().mockResolvedValue({ id:'teacher-1',name:'赵老师',defaultBaseSalary:'2200.00',defaultCommissionRate:'12.0000' }),
  };
  const service = new AssistantActionsService(prisma as never, {} as never, {} as never, undefined, undefined, undefined, undefined,
    students as never, courses as never, accounts as never, teachers as never);
  return { service, prisma, tx, preview, students, courses, accounts, teachers };
}

const common = { actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'preview-key' };

describe('assistant basic data Preview/Confirm', () => {
  it('preserves a normalized phone through student creation preview and confirmation', async () => {
    const context = setup('student.create', { name: '小雨', phone: '13800138000' });
    context.students.previewCreate.mockResolvedValue({ input: { name: '小雨', phone: '13800138000', notes: null } } as never);
    await context.service.createStructuredActionPreview({ ...common, actionType: 'student.create', command: { name: '小雨', phone: '138 0013 8000' } });
    expect(context.students.previewCreate).toHaveBeenCalledWith(expect.objectContaining({ phone: '138 0013 8000' }));
    expect(context.tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ normalizedCommandJson: expect.objectContaining({ phone: '13800138000' }) }) }));
    context.preview.normalizedCommandJson = { name: '小雨', phone: '13800138000', notes: null };
    await context.service.confirmPreview('preview-1', owner, 'confirm-key');
    expect(context.students.createInTransaction).toHaveBeenCalledWith(context.tx, expect.objectContaining({ phone: '13800138000' }));
  });
  it.each([
    ['student.create', { name: '小雨' }],
    ['student.update', { studentId: 'student-1', name: '小雨2' }],
    ['teacher.create', { name:'赵老师',baseSalary:'2000.00',commissionRate:'10.0000' }],
    ['teacher.compensation.update', { teacherId:'teacher-1',baseSalary:'2200.00',commissionRate:'12.0000' }],
    ['course.create', { name: '钢琴课', defaultUnitPrice: '200.00', defaultDurationMinutes: 45 }],
    ['course.update', { courseId: 'course-1', name: '钢琴进阶' }],
    ['course-account.open', { studentId: 'student-1', courseId: 'course-1' }],
    ['course-account.price', { accountId: 'account-1', currentUnitPrice: '220.00' }],
  ] as const)('creates a read-only %s Preview through the domain service', async (actionType, command) => {
    const context = setup(actionType, command);
    const result = await context.service.createStructuredActionPreview({ ...common, actionType, command });
    expect(result).toMatchObject({ actionType, previewId: 'preview-1', riskLevel: 'L2' });
    expect(context.tx.actionPreview.create).toHaveBeenCalledOnce();
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledOnce();
    expect(context.students.createInTransaction).not.toHaveBeenCalled();
    expect(context.students.updateInTransaction).not.toHaveBeenCalled();
    expect(context.courses.createInTransaction).not.toHaveBeenCalled();
    expect(context.courses.updateInTransaction).not.toHaveBeenCalled();
    expect(context.accounts.openInTransaction).not.toHaveBeenCalled();
    expect(context.accounts.updatePriceInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['student.create', { name: '小雨' }, 'students', 'createInTransaction'],
    ['student.update', { studentId: 'student-1', name: '小雨2' }, 'students', 'updateInTransaction'],
    ['teacher.create', { name:'赵老师',baseSalary:'2000.00',commissionRate:'10.0000' }, 'teachers', 'createProfileInTransaction'],
    ['teacher.compensation.update', { teacherId:'teacher-1',baseSalary:'2200.00',commissionRate:'12.0000' }, 'teachers', 'updateCompensationInTransaction'],
    ['course.create', { name: '钢琴课', defaultUnitPrice: '200.00', defaultDurationMinutes: 45 }, 'courses', 'createInTransaction'],
    ['course.update', { courseId: 'course-1', name: '钢琴进阶' }, 'courses', 'updateInTransaction'],
    ['course-account.open', { studentId: 'student-1', courseId: 'course-1' }, 'accounts', 'openInTransaction'],
    ['course-account.price', { accountId: 'account-1', currentUnitPrice: '220.00' }, 'accounts', 'updatePriceInTransaction'],
  ] as const)('confirms %s through the domain helper inside the locked Preview transaction', async (actionType, command, domain, method) => {
    const context = setup(actionType, command);
    context.preview.normalizedCommandJson = {
      ...command,
      ...(actionType.endsWith('.update') ? { expectedUpdatedAt: '2026-10-20T00:00:00.000Z' } : {}),
      ...(actionType === 'course-account.open' ? { currentUnitPrice: '200.00', studentUpdatedAt: '2026-10-20T00:00:00.000Z', courseUpdatedAt: '2026-10-20T00:00:00.000Z' } : {}),
      ...(actionType === 'course-account.price' ? { expectedVersion: 3 } : {}),
    };
    context.preview.resourceVersionsJson = {};
    await context.service.confirmPreview('preview-1', owner, 'confirm-key');
    expect(context.prisma.$transaction).toHaveBeenCalledOnce();
    expect(context.tx.actionPreview.update).toHaveBeenCalledOnce();
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledOnce();
    const domainMocks = context as unknown as Record<string, Record<string, { mock: { calls: unknown[][] } }>>;
    const mock = domainMocks[domain]![method]!;
    expect(mock.mock.calls[0]?.[0]).toBe(context.tx);
  });

  it('rejects non-owner Preview requests before creating an ActionPreview', async () => {
    const context = setup('student.create', { name: '小雨' });
    context.prisma.user.findUnique.mockResolvedValue({ ...owner, role: 'TEACHER', isActive: true, teacher: { id: 'teacher-1', isActive: true } } as never);
    await expect(context.service.createStructuredActionPreview({ ...common, actionType: 'student.create', command: { name: '小雨' } })).rejects.toThrow('仅店主');
    expect(context.tx.actionPreview.create).not.toHaveBeenCalled();
  });

  it('replays the same Confirm receipt for the same idempotency key and rejects another key', async () => {
    const context = setup('student.create', { name: '小雨' });
    context.preview.status = 'EXECUTED';
    context.tx.businessAuditEvent.findFirst.mockResolvedValue({ detailJson: { actionType: 'student.create', studentId: 'student-1', idempotencyKey: 'confirm-key' }, id: 'confirm-audit' } as never);
    await expect(context.service.confirmPreview('preview-1', owner, 'confirm-key')).resolves.toMatchObject({
      status: 'EXECUTED', receipt: { studentId: 'student-1', auditEventId: 'confirm-audit' },
    });
    await expect(context.service.confirmPreview('preview-1', owner, 'other-key')).rejects.toThrow('其他确认请求');
    expect(context.students.createInTransaction).not.toHaveBeenCalled();
  });
});

describe('basic data domain transaction helpers', () => {
  it('rejects student and course updates when the previewed updatedAt no longer matches', async () => {
    const tx = {
      student: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ id: 'student-1' }) },
      course: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue({ id: 'course-1' }) },
    };
    const students = new StudentsService({} as never);
    const courses = new CoursesService({} as never);
    const expectedUpdatedAt = new Date('2026-10-20T00:00:00.000Z');
    await expect(students.updateInTransaction(tx as never, 'student-1', { name: '新名字' }, expectedUpdatedAt)).rejects.toThrow('已变化');
    await expect(courses.updateInTransaction(tx as never, 'course-1', { name: '新课程' }, expectedUpdatedAt)).rejects.toThrow('已变化');
    expect(tx.student.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'student-1', updatedAt: expectedUpdatedAt } }));
    expect(tx.course.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'course-1', updatedAt: expectedUpdatedAt } }));
  });

  it('rejects price changes when the account version has advanced', async () => {
    const tx = { studentCourseAccount: { findUnique: vi.fn().mockResolvedValue({ version: 4 }), updateMany: vi.fn() } };
    const accounts = new StudentCourseAccountsService({} as never);
    await expect(accounts.updatePriceInTransaction(tx as never, 'account-1', { currentUnitPrice: new Prisma.Decimal('220.00') }, 3)).rejects.toThrow('已变化');
    expect(tx.studentCourseAccount.updateMany).not.toHaveBeenCalled();
  });

  it('locks and rechecks student/course versions before opening an account', async () => {
    const expectedAt = new Date('2026-10-20T00:00:00.000Z');
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      student: { findUnique: vi.fn().mockResolvedValue({ updatedAt: new Date('2026-10-21T00:00:00.000Z') }) },
      course: { findUnique: vi.fn().mockResolvedValue({ defaultUnitPrice: new Prisma.Decimal('200.00'), updatedAt: expectedAt }) },
      studentCourseAccount: { create: vi.fn() },
    };
    const accounts = new StudentCourseAccountsService({} as never);
    await expect(accounts.openInTransaction(tx as never, 'student-1', { courseId: 'course-1' }, { studentUpdatedAt: expectedAt, courseUpdatedAt: expectedAt })).rejects.toThrow('已变化');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.studentCourseAccount.create).not.toHaveBeenCalled();
  });
});
