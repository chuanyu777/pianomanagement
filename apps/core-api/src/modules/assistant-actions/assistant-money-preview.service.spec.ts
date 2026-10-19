import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsService } from './assistant-actions.service.js';

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
    studentCourseAccount: { findUnique: vi.fn(async () => ({ id: 'account-1' })) },
    $queryRaw: vi.fn(async () => [{ id: preview.id }]),
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
  return { service: new AssistantActionsService(prisma as never, {} as never, ledger as never), tx, prisma, ledger, preview };
}

describe('AssistantActionsService money Preview/Confirm', () => {
  it('stores a two-decimal L2 payment Preview and audit without writing a ledger entry', async () => {
    const { service, tx, ledger } = setup();
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
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
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
