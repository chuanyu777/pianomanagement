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
    status: 'PENDING', expiresAt: new Date(Date.now() + 60_000),
    normalizedCommandJson: { ...command, startsAt: command.startsAt.toISOString(), endsAt: command.endsAt.toISOString() },
    resourceVersionsJson: { accountId: 'account-1', accountVersion: 3, teacherId: 'teacher-1', conflicts: [] },
  };
  const tx = {
    actionPreview: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...previewRow, ...data })),
      findUnique: vi.fn(async () => previewRow),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...previewRow, ...data, status: 'EXECUTED' })),
    },
    businessAuditEvent: { create: vi.fn(async () => ({ id: 'audit-1', detailJson: { lessonId: 'lesson-1' } })),
      findFirst: vi.fn(async () => ({ detailJson: { lessonId: 'lesson-1', auditEventId: 'audit-1' } })) },
    studentCourseAccount: { findUnique: vi.fn(async () => ({ version: 3 })) },
    teacher: { findUnique: vi.fn(async () => ({ id: 'teacher-1', isActive: true, updatedAt: new Date() })) },
    lesson: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'preview-1' }]),
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ ...owner, isActive: true, teacher: null })) },
    actionPreview: { findUnique: vi.fn(async () => previewRow) },
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
    rescheduleInTransaction: vi.fn(async () => ({ id: 'lesson-1' })),
  };
  return { service: new AssistantActionsService(prisma as never, lessons as never, {} as never), prisma, tx, lessons, previewRow, ...overrides };
}

describe('AssistantActionsService single lesson preview/confirm', () => {
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
