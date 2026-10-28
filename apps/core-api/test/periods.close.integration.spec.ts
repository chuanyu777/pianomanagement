import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { ManualTransactionsService } from '../src/modules/manual-transactions/manual-transactions.service.js';
import { PayrollService } from '../src/modules/payroll/payroll.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('PeriodsService reclose with PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const manualTransactions = new ManualTransactionsService(prisma, periods);
    const payroll = new PayrollService(prisma, periods);
    const actions = new AssistantActionsService(prisma, {} as never, {} as never, undefined, manualTransactions, payroll, periods);
    const ownerId = randomUUID();
    const previewIds: string[] = [];
    let periodStart: Date;
    let connected = false;

    const period = () => `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

    async function previewAndConfirm(actionType: 'period.close' | 'period.reopen', command: Record<string, unknown>) {
      const preview = await actions.createStructuredActionPreview({
        actorUserId: ownerId,
        runId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        actionType,
        command,
      });
      previewIds.push(preview.previewId);
      return actions.confirmPreview(preview.previewId, { id: ownerId, username: 'period-test-owner', role: UserRole.OWNER }, randomUUID());
    }

    beforeAll(async () => {
      await prisma.$connect();
      connected = true;
      await prisma.user.create({
        data: { id: ownerId, username: `period-test-owner-${ownerId}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });

      for (let offset = 0; offset < 240; offset += 1) {
        const candidate = new Date(Date.UTC(2300 + Math.floor(offset / 12), offset % 12, 1));
        const existing = await prisma.closedPeriod.findUnique({ where: { periodStart: candidate }, select: { id: true } });
        if (existing) continue;
        const readiness = await periods.preclose(candidate);
        if (readiness.blockers.length === 0) {
          periodStart = candidate;
          return;
        }
      }
      throw new Error('No unused, clear business month was available for the isolated period test');
    });

    afterAll(async () => {
      if (!connected) return;
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      if (periodStart) await prisma.closedPeriod.deleteMany({ where: { periodStart } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
      await prisma.$disconnect();
    });

    it('recloses the same period atomically, rejects a concurrent duplicate, and preserves confirmation audit', async () => {
      const initialClose = await previewAndConfirm('period.close', { period: period() });
      expect(initialClose).toMatchObject({ status: 'EXECUTED', receipt: { period: period() } });
      const firstRow = await prisma.closedPeriod.findUniqueOrThrow({ where: { periodStart } });
      const reopen = await previewAndConfirm('period.reopen', { period: period(), reason: '集成测试重新打开' });
      expect(reopen).toMatchObject({ status: 'EXECUTED', receipt: { period: period(), reason: '集成测试重新打开' } });
      expect(await prisma.closedPeriod.findUniqueOrThrow({ where: { periodStart } })).toMatchObject({
        id: firstRow.id,
        reopenedById: ownerId,
        reopenReason: '集成测试重新打开',
      });

      const closeCommands = await Promise.all([
        actions.createStructuredActionPreview({ actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), actionType: 'period.close', command: { period: period() } }),
        actions.createStructuredActionPreview({ actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(), actionType: 'period.close', command: { period: period() } }),
      ]);
      previewIds.push(...closeCommands.map((preview) => preview.previewId));
      const attempts = await Promise.allSettled(closeCommands.map((preview) => actions.confirmPreview(
        preview.previewId,
        { id: ownerId, username: 'period-test-owner', role: UserRole.OWNER },
        randomUUID(),
      )));

      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ status: 409 });

      const reclosed = await prisma.closedPeriod.findUniqueOrThrow({ where: { periodStart } });
      expect(reclosed.id).toBe(firstRow.id);
      expect(reclosed.closedAt.getTime()).toBeGreaterThan(firstRow.closedAt.getTime());
      expect(reclosed.closedById).toBe(ownerId);
      expect(reclosed.reopenedAt).toBeNull();
      expect(reclosed.reopenedById).toBeNull();
      expect(reclosed.reopenReason).toBeNull();
      expect(await prisma.closedPeriod.count({ where: { periodStart } })).toBe(1);

      const confirmations = await prisma.businessAuditEvent.findMany({
        where: { previewId: { in: previewIds }, eventType: 'assistant.preview.confirmed' },
        select: { previewId: true, detailJson: true },
      });
      expect(confirmations).toHaveLength(3);
      expect(confirmations.some((event) => {
        const detail = event.detailJson as Prisma.JsonObject;
        return detail['actionType'] === 'period.reopen' && detail['reason'] === '集成测试重新打开';
      })).toBe(true);
    });
  });
} else {
  describe.skip('PeriodsService reclose with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
