import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsService } from './assistant-actions.service.js';
import { Prisma } from '../../generated/prisma/client.js';

const owner = { id: 'owner-1', username: 'owner', role: 'OWNER' as const };
const before = { accountId: 'account-1', paidBalance: '10.00', giftBalance: '2.00', totalBalance: '12.00' };
const after = { accountId: 'account-1', paidBalance: '20.00', giftBalance: '2.00', totalBalance: '22.00' };

function setup() {
  const preview = {
    id: 'preview-1', actorUserId: owner.id, actionType: 'course-account.payment',
    status: 'PENDING', expiresAt: new Date(Date.now() + 60_000),
    normalizedCommandJson: { accountId: 'account-1', amount: '10.00', channel: 'CASH', occurredAt: '2026-10-17T01:00:00.000Z', note: null },
    resourceVersionsJson: { accountId: 'account-1', accountVersion: 4 },
  };
  const tx = {
    actionPreview: {
      create: vi.fn(async (_input: { data: { displayJson: unknown } }) => preview), findUnique: vi.fn(async () => preview),
      update: vi.fn(async () => ({ ...preview, status: 'EXECUTED' })),
    },
    businessAuditEvent: {
      create: vi.fn(async () => ({ id: 'audit-1' })),
      findFirst: vi.fn(async () => null as { id: string } | null),
    },
    ledgerEntry: { findUnique: vi.fn(async () => ({ id: 'entry-1' })) },
    studentCourseAccount: { findUnique: vi.fn(async (query?: {where?: {studentId_courseId?: unknown}}) => query?.where?.studentId_courseId ? null : ({ id: 'account-1', currentUnitPrice:new Prisma.Decimal('200.00'),student:{name:'测试学生'},course:{name:'主课'} })) },
    student: { findUnique: vi.fn(async () => ({ id:'student-1', name:'测试学生', updatedAt:new Date('2026-10-16T00:00:00Z'), withdrawnAt:null })) },
    course: { findUnique: vi.fn(async () => ({ id:'course-1', name:'主课', updatedAt:new Date('2026-10-16T00:00:00Z'), defaultUnitPrice:'200.00', isActive:true })) },
    $queryRaw: vi.fn(async () => [{ id: preview.id }]),
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ ...owner, isActive: true, teacher: null })) },
    actionPreview: { findUnique: vi.fn(async () => preview) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const ledger = {
    getPreviewSnapshotInTransaction: vi.fn(async () => ({ ...before, version: 4 })),
    projectBalance: vi.fn((snapshot: typeof before & { version: number }) => ({ before: snapshot, after })),
    recordPaymentInTransaction: vi.fn(async () => after),
    recordGiftInTransaction: vi.fn(async () => after),
  };
  const periods = { assertWritableForDate: vi.fn(async () => undefined) };
  const accounts = {openInTransaction:vi.fn(),updatePriceInTransaction:vi.fn()};
  return { service: new AssistantActionsService(prisma as never, {} as never, ledger as never, undefined, undefined, undefined, periods as never, undefined, undefined, accounts as never), tx, prisma, ledger, periods, preview, accounts };
}

describe('AssistantActionsService money Preview/Confirm', () => {
  it('确认资金前先锁定账期，再锁定账户，避免与其他资金操作互相等待', async () => {
    const context = setup();
    await context.service.confirmMoneyPreview('preview-1', owner, 'confirm-key');
    expect(context.periods.assertWritableForDate).toHaveBeenCalledWith(new Date('2026-10-17T01:00:00.000Z'), context.tx);
    expect(context.periods.assertWritableForDate.mock.invocationCallOrder[0]).toBeLessThan(context.ledger.getPreviewSnapshotInTransaction.mock.invocationCallOrder[0]!);
  });
  it('可为尚无课程账户的学生预览一次缴费，不提前开户或入账', async () => {
    const context = setup();
    const create = context.service.createPaymentPreview.bind(context.service) as (input: unknown) => Promise<unknown>;
    await expect(create({ actorUserId: owner.id, runId: 'run-new', requestId: 'request-new', idempotencyKey: 'preview-new', studentId: 'student-1', courseId: 'course-1', amount: '10.00', currentUnitPrice: '200.00', channel: 'CASH', occurredAt: new Date('2026-10-17T01:00:00.000Z') })).resolves.toMatchObject({ actionType: 'course-account.payment' });
    expect(context.tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ normalizedCommandJson: expect.objectContaining({studentId:'student-1',courseId:'course-1',currentUnitPrice:'200.00'}) }) }));
    expect(context.ledger.recordPaymentInTransaction).not.toHaveBeenCalled();
  });
  it('确认时在同一事务内开户并入账', async () => {
    const context=setup();
    context.tx.actionPreview.findUnique.mockResolvedValueOnce({...context.preview,normalizedCommandJson:{studentId:'student-1',courseId:'course-1',currentUnitPrice:'200.00',priceExplicit:true,amount:'10.00',channel:'CASH',occurredAt:'2026-10-17T01:00:00.000Z',note:null},resourceVersionsJson:{accountId:null,accountVersion:null,studentUpdatedAt:'2026-10-16T00:00:00.000Z',courseUpdatedAt:'2026-10-16T00:00:00.000Z'}} as never);
    context.accounts.openInTransaction.mockResolvedValueOnce({id:'account-1'} as never);
    context.tx.ledgerEntry.findUnique.mockResolvedValueOnce(null as never);
    await expect(context.service.confirmMoneyPreview('preview-1',owner,'confirm-key')).resolves.toMatchObject({status:'EXECUTED'});
    expect(context.accounts.openInTransaction).toHaveBeenCalledOnce();
    expect(context.ledger.recordPaymentInTransaction).toHaveBeenCalledOnce();
    expect(context.prisma.$transaction).toHaveBeenCalledOnce();
  });
  it('拒绝另一笔流水已使用的确认键，不能先开户或改价', async () => {
    const context=setup();
    context.tx.actionPreview.findUnique.mockResolvedValueOnce({...context.preview,normalizedCommandJson:{studentId:'student-1',courseId:'course-1',currentUnitPrice:'200.00',priceExplicit:true,amount:'10.00',channel:'CASH',occurredAt:'2026-10-17T01:00:00.000Z',note:null},resourceVersionsJson:{accountId:null,accountVersion:null,studentUpdatedAt:'2026-10-16T00:00:00.000Z',courseUpdatedAt:'2026-10-16T00:00:00.000Z'}} as never);
    context.accounts.openInTransaction.mockResolvedValueOnce({id:'account-1'} as never);
    await expect(context.service.confirmMoneyPreview('preview-1',owner,'existing-key')).rejects.toMatchObject({status:409});
    expect(context.accounts.openInTransaction).not.toHaveBeenCalled();
    expect(context.ledger.recordPaymentInTransaction).not.toHaveBeenCalled();
  });
  it('stores a two-decimal L2 payment Preview and audit without writing a ledger entry', async () => {
    const { service, tx, ledger, periods } = setup();
    const result = await service.createPaymentPreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'preview-key',
      accountId: 'account-1', amount: '10.00', channel: 'CASH', occurredAt: new Date('2026-10-17T01:00:00.000Z'),
    });
    expect(result).toMatchObject({ previewId: 'preview-1', actionType: 'course-account.payment' });
    expect(tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      riskLevel: 'L2', normalizedCommandJson: expect.objectContaining({ amount: '10.00', channel: 'CASH' }),
      resourceVersionsJson: { accountId: 'account-1', accountVersion: 4 }, status: 'PENDING',
    }) }));
    const createInput = tx.actionPreview.create.mock.calls[0]?.[0];
    const displayJson = createInput?.data.displayJson as Record<string, unknown> | undefined;
    expect(displayJson).toEqual(expect.objectContaining({
      beforeBalance: before,
      afterBalance: after,
    }));
    expect(displayJson).not.toHaveProperty('beforeBalance.version');
    expect(ledger.projectBalance).toHaveBeenCalledOnce();
    expect(periods.assertWritableForDate).toHaveBeenCalledWith(new Date('2026-10-17T01:00:00.000Z'));
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
  });
  it('已有课程账户缴费预览应展示当前单节价格', async () => {
    const context=setup();
    context.tx.studentCourseAccount.findUnique.mockResolvedValueOnce({id:'account-1',currentUnitPrice:new Prisma.Decimal('180.00'),student:{name:'测试学生'},course:{name:'主课'}} as never);
    await context.service.createPaymentPreview({actorUserId:owner.id,runId:'run-price',requestId:'request-price',idempotencyKey:'preview-price',accountId:'account-1',amount:'10.00',channel:'WECHAT',occurredAt:new Date('2026-10-17T01:00:00.000Z')});
    expect(context.tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({displayJson:expect.objectContaining({currentUnitPrice:'180.00',studentName:'测试学生',courseName:'主课'})})}));
  });

  it('rejects a money Preview in a closed business month before storing it', async () => {
    const context=setup();
    context.periods.assertWritableForDate.mockRejectedValueOnce(Object.assign(new Error('该业务月份已关账'),{status:409}));
    await expect(context.service.createPaymentPreview({
      actorUserId:owner.id,runId:'run-closed',requestId:'request-closed',idempotencyKey:'preview-closed',
      accountId:'account-1',amount:'10.00',channel:'WECHAT',occurredAt:new Date('2026-09-20T00:00:00+08:00'),
    })).rejects.toMatchObject({status:409});
    expect(context.tx.actionPreview.create).not.toHaveBeenCalled();
  });

  it('replays the original preview after a same-command idempotency conflict', async () => {
    const { service, tx } = setup();
    tx.actionPreview.create.mockRejectedValueOnce({ code: 'P2002' });
    tx.businessAuditEvent.findFirst.mockResolvedValueOnce({ id: 'audit-1' });

    await expect(service.createPaymentPreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'preview-key',
      accountId: 'account-1', amount: '10.00', channel: 'CASH', occurredAt: new Date('2026-10-17T01:00:00.000Z'),
    })).resolves.toMatchObject({ previewId: 'preview-1', auditEventId: 'audit-1' });
  });

  it('executes through the ledger service only when the account version is unchanged', async () => {
    const context = setup();
    await expect(context.service.confirmMoneyPreview('preview-1', owner, 'confirm-key'))
      .resolves.toMatchObject({ status: 'EXECUTED', receipt: { ledgerEntryId: 'entry-1', balanceAfter: after } });
    expect(context.ledger.recordPaymentInTransaction).toHaveBeenCalledOnce();
    expect(context.tx.actionPreview.update).toHaveBeenCalledOnce();
    expect(context.tx.businessAuditEvent.create).toHaveBeenCalledOnce();

    context.ledger.getPreviewSnapshotInTransaction.mockResolvedValue({ ...before, version: 5 });
    const stale = setup();
    stale.ledger.getPreviewSnapshotInTransaction.mockResolvedValue({ ...before, version: 5 });
    await expect(stale.service.confirmMoneyPreview('preview-1', owner, 'confirm-key')).rejects.toMatchObject({ status: 409 });
    expect(stale.ledger.recordPaymentInTransaction).not.toHaveBeenCalled();
  });
});
