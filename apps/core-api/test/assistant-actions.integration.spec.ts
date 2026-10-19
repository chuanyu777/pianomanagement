import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AssistantActionsService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new AssistantActionsService(prisma, {} as never, {} as never);
    const idempotencyKeys: string[] = [];

    afterAll(async () => {
      if (idempotencyKeys.length > 0) {
        const previews = await prisma.actionPreview.findMany({
          where: { idempotencyKey: { in: idempotencyKeys } },
          select: { id: true },
        });
        await prisma.$transaction([
          prisma.businessAuditEvent.deleteMany({
            where: { previewId: { in: previews.map(({ id }) => id) } },
          }),
          prisma.actionPreview.deleteMany({
            where: { idempotencyKey: { in: idempotencyKeys } },
          }),
        ]);
      }
      await prisma.$disconnect();
    });

    it('persists only the technical preview and its audit event', async () => {
    await prisma.$connect();
    const idempotencyKey = `stage0-${randomUUID()}`;
    idempotencyKeys.push(idempotencyKey);

    const result = await service.createTechnicalSpikePreview({
      actorUserId: randomUUID(),
      runId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey,
    });

    const [storedPreview, auditEvents] = await Promise.all([
      prisma.actionPreview.findUnique({ where: { idempotencyKey } }),
      prisma.businessAuditEvent.findMany({ where: { previewId: result.preview.id } }),
    ]);

    expect(storedPreview).toMatchObject({
      id: result.preview.id,
      actionType: 'technical-spike.preview',
      riskLevel: 'L1',
      status: 'PENDING',
    });
    expect(storedPreview?.normalizedCommandJson).toMatchObject({
      kind: 'technical-spike',
      businessWrite: false,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      id: result.auditEventId,
      previewId: result.preview.id,
      eventType: 'assistant.preview.created',
    });
    expect(result).not.toHaveProperty('amount');
    });

    it('returns one original preview and one audit event for concurrent duplicate keys', async () => {
    const idempotencyKey = `stage0-concurrent-${randomUUID()}`;
    idempotencyKeys.push(idempotencyKey);
    const input = {
      actorUserId: randomUUID(),
      runId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.createTechnicalSpikePreview(input)),
    );
    const previewIds = new Set(results.map(({ preview }) => preview.id));
    const auditEvents = await prisma.businessAuditEvent.findMany({
      where: { previewId: results[0]!.preview.id },
    });

    expect(previewIds).toHaveLength(1);
    expect(auditEvents).toHaveLength(1);
    });
  });
} else {
  describe.skip('AssistantActionsService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
