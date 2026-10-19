import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualTransactionsService } from '../src/modules/manual-transactions/manual-transactions.service.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { PayrollService } from '../src/modules/payroll/payroll.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UserRole } from '../src/generated/prisma/client.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('structured business Preview/Confirm with PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const manual = new ManualTransactionsService(prisma, periods);
    const payroll = new PayrollService(prisma, periods);
    const actions = new AssistantActionsService(prisma, {} as never, {} as never, undefined, manual, payroll, periods);
    const ownerId = randomUUID();
    const teacherUserId = randomUUID();
    const teacherId = randomUUID();
    const previewIds: string[] = [];
    const periodStart = new Date('2099-07-01T00:00:00.000Z');
    const actor = { id: ownerId, username: 'structured-owner', role: UserRole.OWNER };

    beforeAll(async () => {
      await prisma.$connect();
      await prisma.user.create({ data: { id: ownerId, username: `structured-owner-${ownerId}`, passwordHash: 'test-hash', role: UserRole.OWNER } });
      await prisma.user.create({ data: { id: teacherUserId, username: `structured-teacher-${teacherUserId}`, passwordHash: 'test-hash', role: UserRole.TEACHER } });
      await prisma.teacher.create({ data: {
        id: teacherId, userId: teacherUserId, name: `结构化测试老师-${teacherId}`,
        defaultBaseSalary: '3000.00', defaultCommissionRate: '10.0000',
      } });
    });

    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      await prisma.closedPeriod.deleteMany({ where: { periodStart } });
      await prisma.payroll.deleteMany({ where: { teacherId } });
      await prisma.manualTransaction.deleteMany({ where: { createdById: ownerId } });
      await prisma.teacher.deleteMany({ where: { id: teacherId } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, teacherUserId] } } });
      await prisma.$disconnect();
    });

    it('keeps business writes, Preview state, audit and receipt in the confirm transaction', async () => {
      const manualPreview = await actions.createStructuredActionPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        actionType: 'manual-transaction.create',
        command: { kind: 'INCOME', incomeCategory: 'BOOK_SALE', amount: '123.40', channel: 'CASH', occurredAt: '2099-07-02T02:00:00.000Z' },
      });
      previewIds.push(manualPreview.previewId);
      expect(await prisma.manualTransaction.count({ where: { createdById: ownerId } })).toBe(0);
      const manualReceipt = await actions.confirmPreview(manualPreview.previewId, actor, randomUUID());
      expect(manualReceipt).toMatchObject({ status: 'EXECUTED', receipt: { manualTransactionId: expect.any(String), amount: '123.40' } });
      expect(await prisma.manualTransaction.count({ where: { createdById: ownerId } })).toBe(1);

      const generatePreview = await actions.createStructuredActionPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        actionType: 'payroll.generate', command: { teacherId, period: '2099-07' },
      });
      previewIds.push(generatePreview.previewId);
      const generateReceipt = await actions.confirmPreview(generatePreview.previewId, actor, randomUUID());
      const payrollId = (generateReceipt.receipt as { payrollId: string }).payrollId;
      expect(payrollId).toEqual(expect.any(String));
      expect(await prisma.payroll.count({ where: { id: payrollId } })).toBe(1);

      const payPreview = await actions.createStructuredActionPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        actionType: 'payroll.pay', command: { payrollId, paidAt: '2099-07-05T02:00:00.000Z', channel: 'WECHAT' },
      });
      previewIds.push(payPreview.previewId);
      await expect(actions.confirmPreview(payPreview.previewId, actor, randomUUID())).resolves.toMatchObject({ status: 'EXECUTED', receipt: { payrollId, status: 'PAID' } });

      const closePreview = await actions.createStructuredActionPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        actionType: 'period.close', command: { period: '2099-07' },
      });
      previewIds.push(closePreview.previewId);
      await expect(actions.confirmPreview(closePreview.previewId, actor, randomUUID())).resolves.toMatchObject({ status: 'EXECUTED', receipt: { period: '2099-07' } });
      expect(await prisma.closedPeriod.count({ where: { periodStart, reopenedAt: null } })).toBe(1);

      const reopenPreview = await actions.createStructuredActionPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        actionType: 'period.reopen', command: { period: '2099-07', reason: '结构化测试完成' },
      });
      previewIds.push(reopenPreview.previewId);
      const reopenReceipt = await actions.confirmPreview(reopenPreview.previewId, actor, randomUUID());
      expect(reopenReceipt).toMatchObject({ status: 'EXECUTED', receipt: { period: '2099-07', reason: '结构化测试完成' } });
      expect(await prisma.closedPeriod.count({ where: { periodStart, reopenedAt: { not: null } } })).toBe(1);

      const confirmedAudits = await prisma.businessAuditEvent.count({ where: { previewId: { in: previewIds }, eventType: 'assistant.preview.confirmed' } });
      expect(confirmedAudits).toBe(5);
    });
  });
} else {
  describe.skip('structured business Preview/Confirm with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
