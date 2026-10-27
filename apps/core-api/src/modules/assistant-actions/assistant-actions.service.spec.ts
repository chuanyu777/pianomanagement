import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsService } from './assistant-actions.service.js';

const owner = { id: 'owner-1', username: 'owner', role: 'OWNER' as const };
const command = {
  accountId: 'account-1', teacherId: 'teacher-1',
  startsAt: new Date('2026-11-02T01:00:00.000Z'),
  endsAt: new Date('2026-11-02T02:00:00.000Z'),
};

function setup(overrides: Record<string, unknown> = {}) {
  const previewRow = {
    id: 'preview-1', actorUserId: owner.id, actionType: 'lesson.schedule.single',
    status: 'PENDING', riskLevel: 'L1', schemaVersion: 'lesson.schedule.single.v1', expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date('2026-10-20T00:00:00.000Z'), updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    normalizedCommandJson: { ...command, startsAt: command.startsAt.toISOString(), endsAt: command.endsAt.toISOString() },
    displayJson: { title: '单节排课', summary: '确认后创建一节排课记录。' },
    resourceVersionsJson: { accountId: 'account-1', accountVersion: 3, teacherId: 'teacher-1', conflicts: [] },
  };
  const tx = {
    actionPreview: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...previewRow, ...data })),
      findUnique: vi.fn(async () => previewRow),
      update: vi.fn(async ({ data }: { data: { status?: string } }) => ({ ...previewRow, ...data, status: data.status ?? previewRow.status })),
    },
    businessAuditEvent: { create: vi.fn(async () => ({ id: 'audit-1', detailJson: { lessonId: 'lesson-1' } })),
      findFirst: vi.fn(async () => ({ detailJson: { lessonId: 'lesson-1', auditEventId: 'audit-1' } })) },
    student: { findUnique: vi.fn(async () => ({ updatedAt: new Date('2026-10-20T00:00:00.000Z') })) },
    studentCourseAccount: {
      findUnique: vi.fn(async () => ({ version: 3 })),
      findMany: vi.fn(async () => [{ id:'account-1',version:3 }]),
    },
    teacher: { findUnique: vi.fn(async () => ({ id: 'teacher-1', isActive: true, updatedAt: new Date() })) },
    lesson: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ teacherId: 'teacher-1' })),
    },
    $queryRaw: vi.fn(async () => [{ id: 'preview-1' }]),
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ ...owner, isActive: true, teacher: null })) },
    actionPreview: { findUnique: vi.fn(async () => previewRow) },
    businessAuditEvent: tx.businessAuditEvent,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const lessons = {
    previewSingle: vi.fn(async () => ({ normalizedCommand: command, resourceVersions: {
      accountId: 'account-1', accountVersion: 3, teacherId: 'teacher-1', conflicts: [],
    } })),
    createSingleInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
    createBatch: vi.fn(async () => [{ id: 'lesson-1' }, { id: 'lesson-2' }]),
    createBatchInTransaction: vi.fn(async () => [{ id: 'lesson-1' }, { id: 'lesson-2' }]),
    previewReschedule: vi.fn(async () => ({ normalizedCommand: {}, display: {}, resourceVersions: {} })),
    previewCancel: vi.fn(async () => ({ normalizedCommand: {}, display: {}, resourceVersions: {} })),
    previewComplete: vi.fn(async () => ({ normalizedCommand: {}, display: {}, resourceVersions: {} })),
    previewReverseCompletion: vi.fn(async () => ({ normalizedCommand: {}, display: {}, resourceVersions: {} })),
    rescheduleInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
    cancelInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
    completeInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
    reverseCompletionInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
  };
  return { service: new AssistantActionsService(prisma as never, lessons as never, {} as never), prisma, tx, lessons, previewRow, ...overrides };
}

describe('AssistantActionsService single lesson preview/confirm', () => {
  it('checks coarse action eligibility against the current database actor before collecting parameters', async () => {
    const { service, prisma } = setup();
    await expect(service.checkActionAccess(owner.id, 'course-account.payment')).resolves.toEqual({ allowed: true });
    prisma.user.findUnique.mockResolvedValue({ ...owner, role: 'TEACHER', isActive: true, teacher: { id:'teacher-1', isActive: true } } as never);
    await expect(service.checkActionAccess(owner.id, 'course-account.payment')).rejects.toThrow('无权');
    await expect(service.checkActionAccess(owner.id, 'course-account.read')).rejects.toThrow('无权');
    await expect(service.checkActionAccess(owner.id, 'lesson.complete.reversal')).rejects.toThrow('无权');
    await expect(service.checkActionAccess(owner.id, 'lesson.complete')).resolves.toEqual({ allowed: true });
    await expect(service.checkActionAccess(owner.id, 'made.up.action')).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('persists a normalized preview and audit while deferring lesson creation', async () => {
    const { service, tx, lessons } = setup();
    const result = await service.createSingleLessonPreview({
      ...command, actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'key-1',
    });
    expect(result).toMatchObject({ previewId: 'preview-1', actionType: 'lesson.schedule.single' });
    expect(tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      normalizedCommandJson: expect.objectContaining({ startsAt: command.startsAt.toISOString(), endsAt: command.endsAt.toISOString() }),
      resourceVersionsJson: expect.objectContaining({ accountVersion: 3 }),
      status: 'PENDING',
    }) }));
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
    expect(lessons.createSingleInTransaction).not.toHaveBeenCalled();
  });

  it('confirms through LessonsService and stores the receipt in the same transaction', async () => {
    const { service, lessons, tx } = setup();
    await expect(service.confirmSingleLessonPreview('preview-1', owner, 'confirm-key'))
      .resolves.toMatchObject({ status: 'EXECUTED', receipt: { lessonId: 'lesson-1', auditEventId: 'audit-1' } });
    expect(lessons.createSingleInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({
      accountId: 'account-1', teacherId: 'teacher-1', endsAt: command.endsAt,
    }), owner, expect.objectContaining({ accountVersion: 3, conflicts: [] }));
    expect(tx.actionPreview.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'EXECUTED' }) }));
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
  });

  it('rejects changed account versions before creating a lesson', async () => {
    const context = setup();
    context.lessons.createSingleInTransaction.mockRejectedValue(Object.assign(new Error('stale'), { status: 409 }));
    await expect(context.service.confirmSingleLessonPreview('preview-1', owner, 'key'))
      .rejects.toMatchObject({ status: 409 });
    expect(context.lessons.createSingleInTransaction).toHaveBeenCalledWith(expect.anything(), expect.anything(), owner,
      expect.objectContaining({ accountVersion: 3 }));
  });

  it('rejects a newly conflicting lesson before creating a lesson', async () => {
    const context = setup();
    context.lessons.createSingleInTransaction.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    await expect(context.service.confirmSingleLessonPreview('preview-1', owner, 'key'))
      .rejects.toMatchObject({ status: 409 });
    expect(context.lessons.createSingleInTransaction).toHaveBeenCalledOnce();
  });

  it('does not execute an expired preview', async () => {
    const context = setup();
    context.previewRow.expiresAt = new Date(Date.now() - 1_000);
    await expect(context.service.confirmSingleLessonPreview('preview-1', owner, 'key'))
      .rejects.toMatchObject({ status: 409 });
    expect(context.lessons.createSingleInTransaction).not.toHaveBeenCalled();
  });

  it('creates a reschedule Preview with domain display and version snapshot, without executing a mutation', async () => {
    const context = setup();
    Object.assign(context.lessons, {
      previewReschedule: vi.fn(async () => ({
        normalizedCommand: { lessonId: 'lesson-1', startsAt: new Date('2026-11-03T01:00:00.000Z'), endsAt: new Date('2026-11-03T01:45:00.000Z') },
        display: { previousStartsAt: new Date('2026-11-02T01:00:00.000Z'), startsAt: new Date('2026-11-03T01:00:00.000Z') },
        resourceVersions: { lessonId: 'lesson-1', lessonVersion: 4, accountId: 'account-1', accountVersion: 3, courseDurationMinutes: 45 },
      })),
    });
    const result = await context.service.createReschedulePreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'preview-key',
      lessonId: 'lesson-1', startsAt: new Date('2026-11-03T01:00:00.000Z'),
    });
    expect(result).toMatchObject({ actionType: 'lesson.reschedule', command: {
      lessonId: 'lesson-1', startsAt: '2026-11-03T01:00:00.000Z', endsAt: '2026-11-03T01:45:00.000Z',
    }, resourceVersions: { lessonVersion: 4, accountVersion: 3, courseDurationMinutes: 45 } });
    expect(context.lessons.previewReschedule).toHaveBeenCalledOnce();
    expect(context.lessons.rescheduleInTransaction).not.toHaveBeenCalled();
  });

  it('confirms a reschedule using the saved versions and returns a replayable receipt', async () => {
    const context = setup();
    Object.assign(context.previewRow, {
      actionType: 'lesson.reschedule',
      normalizedCommandJson: { lessonId: 'lesson-1', startsAt: '2026-11-03T01:00:00.000Z', endsAt: '2026-11-03T01:45:00.000Z', note: null },
      resourceVersionsJson: { lessonId: 'lesson-1', lessonVersion: 4, accountId: 'account-1', accountVersion: 3, courseDurationMinutes: 45 },
    });
    Object.assign(context.lessons, {
      rescheduleInTransaction: vi.fn(async () => ({ id: 'lesson-1', status: 'SCHEDULED',
        startsAt: new Date('2026-11-03T01:00:00.000Z'), endsAt: new Date('2026-11-03T01:45:00.000Z') })),
    });
    const result = await context.service.confirmPreview('preview-1', owner, 'confirm-key');
    expect(result).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.reschedule', lessonId: 'lesson-1', idempotencyKey: 'confirm-key' } });
    expect(context.lessons.rescheduleInTransaction).toHaveBeenCalledWith(context.tx, 'lesson-1',
      { startsAt: new Date('2026-11-03T01:00:00.000Z') }, owner,
      { lessonVersion: 4, accountVersion: 3, courseDurationMinutes: 45, endsAt: new Date('2026-11-03T01:45:00.000Z') });
    expect(context.tx.actionPreview.update).toHaveBeenCalledOnce();
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledOnce();
  });
});

describe('AssistantActionsService weekly batch lesson preview/confirm', () => {
  it('persists the normalized weekly schedule, every lesson time and conflicts without creating lessons', async () => {
    const account = { id: 'account-1', version: 7, course: { defaultDurationMinutes: 45 }, student: { name: '小明' } };
    const teacher = { id: 'teacher-1', isActive: true, updatedAt: new Date('2026-10-01T00:00:00.000Z') };
    const conflicting = { id: 'lesson-existing', startsAt: new Date('2026-11-09T01:10:00.000Z'), endsAt: new Date('2026-11-09T01:50:00.000Z'), version: 2 };
    const preview = { id: 'batch-preview-1', actionType: 'lesson.schedule.weekly-batch', normalizedCommandJson: {},
      displayJson: {}, expiresAt: new Date('2026-11-01T00:05:00.000Z') };
    const tx = {
      studentCourseAccount: { findUnique: vi.fn(async () => account) },
      teacher: { findUnique: vi.fn(async () => teacher) },
      lesson: { findMany: vi.fn(async () => [conflicting]) },
      actionPreview: { create: vi.fn(async () => preview) },
      businessAuditEvent: { create: vi.fn(async () => ({ id: 'audit-batch-1' })) },
    };
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ ...owner, isActive: true, teacher: null })) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const lessons = {
      previewBatch: vi.fn(async () => ({
        normalizedCommand: { accountId: 'account-1', teacherId: 'teacher-1', firstStartsAt: new Date('2026-11-02T01:00:00.000Z'), weeks: 2 },
        lessons: [
          { startsAt: new Date('2026-11-02T01:00:00.000Z'), endsAt: new Date('2026-11-02T01:45:00.000Z') },
          { startsAt: new Date('2026-11-09T01:00:00.000Z'), endsAt: new Date('2026-11-09T01:45:00.000Z') },
        ],
        conflicts: [{ startsAt: '2026-11-09T01:00:00.000Z', endsAt: '2026-11-09T01:45:00.000Z', conflictingLessonId: 'lesson-existing', conflictingStartsAt: conflicting.startsAt.toISOString(), conflictingEndsAt: conflicting.endsAt.toISOString() }],
        resourceVersions: { accountId: 'account-1', accountVersion: 7, teacherId: 'teacher-1', teacherUpdatedAt: teacher.updatedAt },
      })),
      createBatch: vi.fn(async () => []),
    };
    const service = new AssistantActionsService(prisma as never, lessons as never, {} as never);
    const result = await service.createBatchLessonPreview({
      actorUserId: owner.id, runId: 'run-batch', requestId: 'request-batch', idempotencyKey: 'key-batch',
      accountId: 'account-1', teacherId: 'teacher-1', firstStartsAt: new Date('2026-11-02T01:00:00.000Z'), weeks: 2,
    });

    expect(result).toMatchObject({ previewId: 'batch-preview-1', actionType: 'lesson.schedule.weekly-batch' });
    expect(tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      normalizedCommandJson: expect.objectContaining({ weeks: 2, firstStartsAt: '2026-11-02T01:00:00.000Z' }),
      displayJson: expect.objectContaining({ lessons: [
        { week: 1, startsAt: '2026-11-02T01:00:00.000Z', endsAt: '2026-11-02T01:45:00.000Z' },
        { week: 2, startsAt: '2026-11-09T01:00:00.000Z', endsAt: '2026-11-09T01:45:00.000Z' },
      ], conflicts: [expect.objectContaining({ conflictingLessonId: 'lesson-existing', conflictingStartsAt: conflicting.startsAt.toISOString() })] }),
      resourceVersionsJson: expect.objectContaining({ accountVersion: 7, teacherUpdatedAt: teacher.updatedAt.toISOString() }),
      status: 'PENDING',
    }) }));
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
    expect(lessons.createBatch).not.toHaveBeenCalled();
  });

  it('confirms through the transaction-scoped domain batch service and returns a receipt', async () => {
    const context = setup();
    const { service, tx, lessons } = context;
    Object.assign(context.previewRow, {
      actionType: 'lesson.schedule.weekly-batch',
      normalizedCommandJson: { accountId: 'account-1', teacherId: 'teacher-1', firstStartsAt: '2026-11-02T01:00:00.000Z', weeks: 2, note: null },
      resourceVersionsJson: { accountId: 'account-1', accountVersion: 3, teacherId: 'teacher-1', teacherUpdatedAt: new Date().toISOString() },
    });
    await expect(service.confirmPreview('preview-1', owner, 'confirm-batch'))
      .resolves.toMatchObject({ status: 'EXECUTED', receipt: { lessonIds: ['lesson-1', 'lesson-2'] } });
    expect(lessons.createBatchInTransaction).toHaveBeenCalledWith(tx,
      expect.objectContaining({ weeks: 2, firstStartsAt: new Date('2026-11-02T01:00:00.000Z') }), owner,
      expect.objectContaining({ accountVersion: 3 }));
  });
});

describe('AssistantActionsService security boundaries', () => {
  const teacher = { id: 'teacher-user-1', username: 'teacher', role: 'TEACHER' as const, teacherId: 'teacher-1' };

  it('projects completion preview for a teacher and returns the authoritative L2 risk', async () => {
    const context = setup();
    context.prisma.user.findUnique.mockResolvedValue({
      ...teacher, isActive: true, teacher: { id: 'teacher-1', isActive: true },
    } as never);
    context.lessons.previewComplete.mockResolvedValue({
      normalizedCommand: { lessonId: 'lesson-1', note: null },
      display: {
        title: '确认上课', summary: '确认后扣费', lessonId: 'lesson-1', studentName: '小明', courseName: '主课',
        unitPrice: '200.00', paidBalanceBefore: '500.00', giftBalanceBefore: '80.00',
        paidConsumed: '120.00', giftConsumed: '80.00', paidBalanceAfter: '380.00', giftBalanceAfter: '0.00',
        futureMoney: { amount: '999.00' },
      },
      resourceVersions: {
        lessonId: 'lesson-1', lessonVersion: 2, accountId: 'account-1', accountVersion: 3,
        unitPrice: '200.00', futureMoney: { amount: '999.00' },
      },
    } as never);

    const result = await context.service.createCompletionPreview({
      actorUserId: teacher.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'key-complete', lessonId: 'lesson-1',
    });

    expect(result).toMatchObject({ actionType: 'lesson.complete', riskLevel: 'L2' });
    expect(result.display).not.toHaveProperty('paidBalanceBefore');
    expect(result.display).not.toHaveProperty('giftBalanceBefore');
    expect(result.display).not.toHaveProperty('paidConsumed');
    expect(result.display).not.toHaveProperty('giftConsumed');
    expect(result.display).not.toHaveProperty('unitPrice');
    expect(result.display).not.toHaveProperty('summary');
    expect(result.display).not.toHaveProperty('futureMoney');
    expect(result.resourceVersions).not.toHaveProperty('unitPrice');
    expect(result.resourceVersions).not.toHaveProperty('futureMoney');
    expect(context.tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      riskLevel: 'L2',
      displayJson: expect.objectContaining({ paidBalanceBefore: '500.00' }),
    }) }));
  });

  it('keeps reversal at L2 and does not expose restored money to a teacher', async () => {
    const context = setup();
    context.prisma.user.findUnique.mockResolvedValue({
      ...teacher, isActive: true, teacher: { id: 'teacher-1', isActive: true },
    } as never);
    context.lessons.previewReverseCompletion.mockResolvedValue({
      normalizedCommand: { lessonId: 'lesson-1', note: null },
      display: { title: '撤销上课确认', summary: '恢复课程状态', lessonId: 'lesson-1', paidRestore: '120.00', giftRestore: '80.00', statusBefore: 'COMPLETED', statusAfter: 'SCHEDULED' },
      resourceVersions: { lessonId: 'lesson-1', lessonVersion: 3, accountId: 'account-1', accountVersion: 4, consumptionEntryId: 'entry-1' },
    } as never);

    const result = await context.service.createCompletionReversalPreview({
      actorUserId: teacher.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'key-reversal', lessonId: 'lesson-1',
    });

    expect(result).toMatchObject({ actionType: 'lesson.complete.reversal', riskLevel: 'L2' });
    expect(result.display).not.toHaveProperty('paidRestore');
    expect(result.display).not.toHaveProperty('giftRestore');
    expect(context.tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ riskLevel: 'L2' }) }));
  });

  it('projects historical completion receipts for the current teacher role', async () => {
    const context = setup();
    const historical = {
      ...context.previewRow,
      actorUserId: teacher.id,
      actionType: 'lesson.complete',
      normalizedCommandJson: { lessonId: 'lesson-1', note: null },
      riskLevel: 'L1',
      displayJson: {
        title: '确认上课', summary: '确认后扣费 ¥200.00', paidConsumed: '120.00', giftConsumed: '80.00',
        futureMoney: { amount: '999.00' },
      },
      resourceVersionsJson: {
        lessonId: 'lesson-1', accountVersion: 3, unitPrice: '200.00', futureMoney: { amount: '999.00' },
      },
      status: 'EXECUTED',
    };
    context.prisma.user.findUnique.mockResolvedValue({
      ...teacher, isActive: true, teacher: { id: 'teacher-1', isActive: true },
    } as never);
    context.prisma.actionPreview.findUnique.mockResolvedValue(historical as never);
    context.tx.actionPreview.findUnique.mockResolvedValue(historical as never);
    context.tx.businessAuditEvent.findFirst.mockResolvedValue({
      id: 'receipt-audit', detailJson: {
        actionType: 'lesson.complete', unitPriceSnapshot: '200.00', paidConsumed: '120.00', giftConsumed: '80.00',
        futureMoney: { amount: '999.00' }, idempotencyKey: 'confirm-key',
      },
    } as never);

    const result = await context.service.getPreview('preview-1', teacher);

    expect(result.riskLevel).toBe('L2');
    expect(result.display).not.toHaveProperty('paidConsumed');
    expect(result.display).not.toHaveProperty('unitPrice');
    expect(result.display).not.toHaveProperty('summary');
    expect(result.display).not.toHaveProperty('futureMoney');
    expect(result.resourceVersions).not.toHaveProperty('unitPrice');
    expect(result.resourceVersions).not.toHaveProperty('futureMoney');
    expect(result.receipt).not.toHaveProperty('unitPriceSnapshot');
    expect(result.receipt).not.toHaveProperty('paidConsumed');
    expect(result.receipt).not.toHaveProperty('giftConsumed');
    expect(result.receipt).not.toHaveProperty('futureMoney');
  });

  it.each(['course-account.payment', 'student.final-refund', 'payroll.generate'] as const)(
    'does not expose an old %s preview after the same actor is downgraded to teacher',
    async (actionType) => {
      const context = setup();
      Object.assign(context.previewRow, {
        actorUserId: owner.id,
        actionType,
        displayJson: { title: '收款', summary: '收款 ¥999.00', amount: '999.00' },
      });
      context.prisma.user.findUnique.mockResolvedValue({
        id: owner.id, username: owner.username, role: 'TEACHER', isActive: true,
        teacher: { id: 'teacher-1', isActive: true },
      } as never);

      await expect(context.service.getPreview('preview-1', owner)).rejects.toThrow('无权查看该业务预览');
    },
  );

  it('marks a pending final-refund preview stale when an account version changed', async () => {
    const context=setup();
    Object.assign(context.previewRow,{
      actionType:'student.final-refund',
      status:'PENDING',
      resourceVersionsJson:{studentId:'student-1',studentUpdatedAt:'2026-10-20T00:00:00.000Z',accountVersions:[{accountId:'account-1',version:2}]},
    });
    context.tx.studentCourseAccount.findMany.mockResolvedValue([{id:'account-1',version:3}]);
    const result=await context.service.getPreview('preview-1',owner);
    expect(result.status).toBe('STALE');
    expect(context.tx.actionPreview.update).toHaveBeenCalledWith({where:{id:'preview-1'},data:{status:'STALE'}});
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledWith({data:expect.objectContaining({eventType:'assistant.preview.stale'})});
  });

  it('revalidates the current lesson teacher before returning a teacher lesson preview', async () => {
    const context = setup();
    Object.assign(context.previewRow, {
      actorUserId: teacher.id,
      actionType: 'lesson.complete',
      riskLevel: 'L2',
      normalizedCommandJson: { lessonId: 'lesson-1', note: null },
    });
    context.prisma.user.findUnique.mockResolvedValue({
      ...teacher, isActive: true, teacher: { id: 'teacher-1', isActive: true },
    } as never);
    context.tx.lesson.findUnique.mockResolvedValue({ teacherId: 'teacher-2' });

    await expect(context.service.getPreview('preview-1', teacher)).rejects.toThrow('无权查看其他教师的课程预览');
  });

  it('projects the live completion confirmation receipt before returning it to a teacher', async () => {
    const context = setup();
    context.prisma.user.findUnique.mockResolvedValue({
      ...teacher, isActive: true, teacher: { id: 'teacher-1', isActive: true },
    } as never);
    Object.assign(context.previewRow, {
      actorUserId: teacher.id,
      actionType: 'lesson.complete',
      riskLevel: 'L2',
      normalizedCommandJson: { lessonId: 'lesson-1', note: null },
      resourceVersionsJson: { lessonId: 'lesson-1', lessonVersion: 2, accountId: 'account-1', accountVersion: 3, unitPrice: '200.00' },
    });
    context.lessons.completeInTransaction.mockResolvedValue({
      id: 'lesson-1', status: 'COMPLETED', startsAt: new Date('2026-10-20T01:00:00.000Z'),
      endsAt: new Date('2026-10-20T02:00:00.000Z'), completedAt: new Date('2026-10-20T02:00:00.000Z'),
      unitPriceSnapshot: '200.00',
    } as never);

    const result = await context.service.confirmPreview('preview-1', teacher, 'confirm-key');

    expect(result).toMatchObject({ status: 'EXECUTED', receipt: { actionType: 'lesson.complete', lessonId: 'lesson-1' } });
    expect(result.receipt).not.toHaveProperty('unitPriceSnapshot');
  });

  it('invalidates only the actor-owned pending preview and refuses to invalidate an executed one', async () => {
    const context = setup();
    await expect(context.service.invalidatePreview('preview-1', owner.id, '用户修改了时间', 'request-invalidate'))
      .resolves.toMatchObject({ previewId: 'preview-1', status: 'CANCELLED' });
    expect(context.tx.actionPreview.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }));
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'assistant.preview.invalidated' }) }));

    context.previewRow.status = 'EXECUTED';
    await expect(context.service.invalidatePreview('preview-1', owner.id, '过期预览', 'request-invalidate-2'))
      .rejects.toThrow('已执行的预览不能失效');
  });

  it.each(['STALE', 'CANCELLED'] as const)('refuses confirmation of a %s preview', async (status) => {
    const context = setup();
    context.previewRow.actionType = 'lesson.complete';
    context.previewRow.status = status;
    await expect(context.service.confirmPreview('preview-1', owner, 'confirm-key'))
      .rejects.toThrow('课程操作预览已不能确认');
    expect(context.lessons.completeInTransaction).not.toHaveBeenCalled();
  });

  it.each(['lesson.complete', 'lesson.complete.reversal'] as const)(
    'refuses confirmation of a pending legacy %s preview saved with L1 risk',
    async (actionType) => {
      const context = setup();
      context.previewRow.actionType = actionType;
      context.previewRow.riskLevel = 'L1';
      context.previewRow.normalizedCommandJson = { lessonId: 'lesson-1', note: null } as never;

      await expect(context.service.confirmPreview('preview-1', owner, 'confirm-key'))
        .rejects.toThrow('请重新预览');
      expect(context.lessons.completeInTransaction).not.toHaveBeenCalled();
      expect(context.lessons.reverseCompletionInTransaction).not.toHaveBeenCalled();
    },
  );
});
