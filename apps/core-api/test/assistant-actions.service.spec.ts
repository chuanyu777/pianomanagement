import { describe, expect, it, vi } from 'vitest';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const actorUserId = 'owner-1';
const runId = 'run-1';

function preview(id = 'preview-1') {
  const now = new Date('2026-10-16T00:00:00.000Z');
  return {
    id,
    actorUserId,
    actionType: 'technical-spike.preview',
    schemaVersion: 'stage0.v1',
    riskLevel: 'L1' as const,
    normalizedCommandJson: { kind: 'technical-spike', mode: 'preview-only', businessWrite: false },
    displayJson: {
      title: '阶段 0 技术预览',
      summary: '仅验证 Preview 持久化、审计和幂等，不会写入任何业务数据。',
      technicalSpike: true,
      businessWrite: false,
    },
    resourceVersionsJson: { kind: 'technical-spike', resources: [] },
    idempotencyKey: 'same-key',
    status: 'PENDING' as const,
    expiresAt: new Date(now.getTime() + 300_000),
    executedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function audit(id = 'audit-1', previewId = 'preview-1') {
  return {
    id,
    actorUserId,
    runId,
    previewId,
    eventType: 'assistant.preview.created',
    resourceType: null,
    resourceId: null,
    requestId: 'request-1',
    detailJson: { actionType: 'technical-spike.preview', technicalSpike: true, businessWrite: false },
    createdAt: new Date('2026-10-16T00:00:00.000Z'),
  };
}

function createService(prisma: object): AssistantActionsService {
  return new AssistantActionsService(prisma as PrismaService, {} as never, {} as never);
}

describe('AssistantActionsService', () => {
  it('creates an L1 technical preview and its audit event in one transaction', async () => {
    const createdPreview = preview();
    const createdAudit = audit();
    const tx = {
      actionPreview: { create: vi.fn(async () => createdPreview) },
      businessAuditEvent: { create: vi.fn(async () => createdAudit) },
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const service = createService({ $transaction: transaction });

    const result = await service.createTechnicalSpikePreview({
      actorUserId,
      runId,
      requestId: 'request-1',
      idempotencyKey: 'same-key',
      now: new Date('2026-10-16T00:00:00.000Z'),
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.actionPreview.create).toHaveBeenCalledTimes(1);
    expect(tx.businessAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ previewId: 'preview-1', runId }),
    });
    expect(result).toMatchObject({
      technicalSpike: true,
      businessWrite: false,
      auditEventId: 'audit-1',
      preview: {
        actionType: 'technical-spike.preview',
        riskLevel: 'L1',
        status: 'PENDING',
      },
    });
    expect(result).not.toHaveProperty('amount');
  });

  it('reads the original preview only after the unique idempotency conflict', async () => {
    const originalPreview = preview();
    const originalAudit = audit();
    const insertTx = {
      actionPreview: {
        create: vi.fn(async () => {
          throw { code: 'P2002' };
        }),
      },
      businessAuditEvent: { create: vi.fn() },
    };
    const recoveryTx = {
      actionPreview: {
        findUnique: vi.fn(async () => originalPreview),
      },
      businessAuditEvent: {
        findFirst: vi.fn(async () => originalAudit),
      },
    };
    let transactionCalls = 0;
    const transaction = vi.fn(async (callback: (client: typeof insertTx) => unknown) => {
      transactionCalls += 1;
      return callback(
        transactionCalls === 1
          ? insertTx
          : (recoveryTx as unknown as typeof insertTx),
      );
    });
    const service = createService({ $transaction: transaction });

    const result = await service.createTechnicalSpikePreview({
      actorUserId,
      runId,
      requestId: 'request-1',
      idempotencyKey: 'same-key',
    });

    expect(insertTx.actionPreview.create).toHaveBeenCalledTimes(1);
    expect(insertTx.businessAuditEvent.create).not.toHaveBeenCalled();
    expect(recoveryTx.actionPreview.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'same-key' },
    });
    expect(result.preview.id).toBe('preview-1');
    expect(result.auditEventId).toBe('audit-1');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty idempotency key before opening a transaction', async () => {
    const transaction = vi.fn();
    const service = createService({ $transaction: transaction });

    await expect(
      service.createTechnicalSpikePreview({
        actorUserId,
        runId,
        requestId: 'request-1',
        idempotencyKey: '  ',
      }),
    ).rejects.toThrow('idempotencyKey 不能为空');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not disclose a preview when another actor reuses its idempotency key', async () => {
    const insertTx = {
      actionPreview: {
        create: vi.fn(async () => {
          throw { code: 'P2002' };
        }),
      },
      businessAuditEvent: { create: vi.fn() },
    };
    const recoveryTx = {
      actionPreview: {
        findUnique: vi.fn(async () => ({ ...preview(), actorUserId: 'another-owner' })),
      },
      businessAuditEvent: { findFirst: vi.fn(async () => audit()) },
    };
    let calls = 0;
    const service = createService({
      $transaction: vi.fn(async (callback: (client: typeof insertTx) => unknown) => {
        calls += 1;
        return callback(calls === 1 ? insertTx : (recoveryTx as unknown as typeof insertTx));
      }),
    });

    await expect(
      service.createTechnicalSpikePreview({
        actorUserId,
        runId,
        requestId: 'request-1',
        idempotencyKey: 'same-key',
      }),
    ).rejects.toThrow('幂等键已被其他请求使用');
  });
});
