import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsService } from './assistant-actions.service.js';

const owner = { id: 'owner-1', username: 'owner', role: 'OWNER' as const };
const studentId = 'student-1';

function setup() {
  const preview = {
    id: 'preview-refund-1',
    actorUserId: owner.id,
    actionType: 'student.final-refund',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    normalizedCommandJson: {
      studentId,
      feeAmount: '10.00',
      channel: 'CASH',
      occurredAt: '2026-10-19T01:00:00.000Z',
      note: null,
    },
    resourceVersionsJson: { studentId, studentUpdatedAt: '2026-10-01T00:00:00.000Z', accountVersions: [{ accountId: 'account-1', version: 4 }] },
    displayJson: {
      feeAmount: '10.00', feePercentage: '10.00', actualRefundAmount: '90.00',
      courses: [{ paidBalanceBefore: '100.00', giftBalanceBefore: '20.00', paidRefundAmount: '100.00', giftClearingAmount: '20.00' }],
    },
  };
  const tx = {
    student: {
      findUnique: vi.fn(async () => ({ id: studentId, name: '小明', withdrawnAt: null })),
    },
    studentCourseAccount: {
      findMany: vi.fn(async () => [{
        id: 'account-1',
        version: 4,
        openingPaidBalance: '100.00',
        openingGiftBalance: '20.00',
        course: { name: '主课' },
      }]),
    },
    ledgerEntry: {
      findMany: vi.fn(async () => [{ accountId: 'account-1', paidDelta: '0.00', giftDelta: '0.00' }]),
    },
    refundRecord: { findUnique: vi.fn(async () => null) },
    actionPreview: {
      create: vi.fn(async () => preview),
      findUnique: vi.fn(async () => preview),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...preview, ...data, status: 'EXECUTED' })),
    },
    businessAuditEvent: {
      create: vi.fn(async () => ({ id: 'audit-refund-1', detailJson: {} })),
      findFirst: vi.fn(async () => ({ id: 'audit-refund-1', detailJson: { idempotencyKey: 'confirm-1' } })),
    },
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: 'preview-refund-1' }])
      .mockResolvedValueOnce([{ id: studentId, updatedAt: new Date('2026-10-01T00:00:00.000Z') }])
      .mockResolvedValueOnce([{ id: 'account-1', version: 4 }]),
  };
    const prisma = {
    user: { findUnique: vi.fn(async () => ({ ...owner, isActive: true, teacher: null })) },
      student: { findUnique: vi.fn(async () => ({ id: studentId, name: '小明', withdrawnAt: null, updatedAt: new Date('2026-10-01T00:00:00.000Z') })) },
      refundRecord: { findUnique: vi.fn(async () => null) },
      studentCourseAccount: { findMany: vi.fn(async () => [{ id: 'account-1', version: 4, openingPaidBalance: '100.00', openingGiftBalance: '20.00', course: { name: '主课' } }]) },
      ledgerEntry: { findMany: vi.fn(async () => [{ accountId: 'account-1', paidDelta: '0.00', giftDelta: '0.00' }]) },
    actionPreview: { findUnique: vi.fn(async () => preview) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const refunds = {
    refundInTransaction: vi.fn(async () => ({
      id: 'refund-1', studentId, totalPaidRefund: '100.00', feeAmount: '10.00',
      feePercentage: '10.00', actualRefundAmount: '90.00', channel: 'BANK_TRANSFER',
      occurredAt: new Date('2026-10-19T01:00:00.000Z'), note: null,
      details: [{ id: 'detail-1', accountId: 'account-1', paidBalanceBefore: '100.00', giftBalanceBefore: '20.00', paidRefundAmount: '100.00', giftClearingAmount: '20.00' }],
    })),
  };
  return { service: new AssistantActionsService(prisma as never, {} as never, {} as never, refunds as never), prisma, tx, refunds, preview };
}

describe('AssistantActionsService final refund L2 preview/confirm', () => {
  it('creates a read-only preview with per-course refund and fee breakdown', async () => {
    const { service, tx, refunds } = setup();

    const result = await service.previewFinalRefund({
      actorUserId: owner.id,
      runId: 'run-refund-1',
      requestId: 'request-refund-1',
      idempotencyKey: 'preview-key-1',
      studentId,
      feeAmount: '10.00',
      channel: 'CASH',
      occurredAt: new Date('2026-10-19T01:00:00.000Z'),
    });

    expect(result).toMatchObject({ previewId: 'preview-refund-1', actionType: 'student.final-refund' });
    expect(result.display).toMatchObject({
      feeAmount: '10.00', feePercentage: '10.00', actualRefundAmount: '90.00',
      courses: [{ paidBalanceBefore: '100.00', giftBalanceBefore: '20.00', paidRefundAmount: '100.00', giftClearingAmount: '20.00' }],
    });
    expect(tx.actionPreview.create).toHaveBeenCalledOnce();
    expect(tx.businessAuditEvent.create).toHaveBeenCalledOnce();
    expect(refunds.refundInTransaction).not.toHaveBeenCalled();
  });

  it('confirms the action type through RefundsService and records the receipt', async () => {
    const { service, refunds, tx } = setup();

    await expect(service.confirmPreview('preview-refund-1', owner, 'confirm-1'))
      .resolves.toMatchObject({ status: 'EXECUTED', receipt: { refundId: 'refund-1', actualRefundAmount: '90.00' } });
    expect(refunds.refundInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({
      studentId, feeAmount: '10.00', commandId: 'confirm-1',
    }), owner);
    expect(tx.actionPreview.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'EXECUTED' }),
    }));
  });

  it('rejects confirmation when the student snapshot changed after preview', async () => {
    const { service, refunds, tx } = setup();
    tx.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: 'preview-refund-1' }])
      .mockResolvedValueOnce([{ id: studentId, updatedAt: new Date('2026-10-19T01:00:00.000Z') }]);

    await expect(service.confirmPreview('preview-refund-1', owner, 'confirm-stale'))
      .rejects.toThrow('学生资料已变化，请重新预览');
    expect(refunds.refundInTransaction).not.toHaveBeenCalled();
    expect(tx.actionPreview.update).not.toHaveBeenCalled();
  });

  it('rejects a refund Preview for a closed business month', async () => {
    const context = setup();
    const periods = { assertWritableForDate: vi.fn().mockRejectedValue(new ConflictException('该业务月份已关账')) };
    const service = new (AssistantActionsService as unknown as new (...args: unknown[]) => AssistantActionsService)(
      context.prisma, {}, {}, context.refunds, undefined, undefined, periods,
    );

    await expect(service.previewFinalRefund({
      actorUserId: owner.id,
      runId: 'run-refund-closed',
      requestId: 'request-refund-closed',
      idempotencyKey: 'preview-key-closed',
      studentId,
      feeAmount: '10.00',
      channel: 'CASH',
      occurredAt: new Date('2026-10-19T01:00:00.000Z'),
    })).rejects.toThrow('该业务月份已关账');
    expect(periods.assertWritableForDate).toHaveBeenCalledOnce();
    expect(context.tx.actionPreview.create).not.toHaveBeenCalled();
  });
});
