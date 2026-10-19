import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentChannel, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('Assistant payment and gift Preview/Confirm with PostgreSQL', () => {
    const prisma = new PrismaService();
    const ledger = new CourseLedgerService(prisma, new PeriodsService(prisma));
    const actions = new AssistantActionsService(prisma, {} as never, ledger);
    const ownerId = randomUUID();
    const studentId = randomUUID();
    const courseId = randomUUID();
    const accountId = randomUUID();
    const previewIds: string[] = [];
    const commandKeys: string[] = [];
    const actor = { id: ownerId, username: 'l2-owner', role: UserRole.OWNER };

    beforeAll(async () => {
      await prisma.$connect();
      await prisma.user.create({ data: { id: ownerId, username: `l2-owner-${ownerId}`, passwordHash: 'test-hash', role: UserRole.OWNER } });
      await prisma.student.create({ data: { id: studentId, name: 'L2 测试学生' } });
      await prisma.course.create({ data: { id: courseId, name: `L2 测试课程-${courseId}`, defaultUnitPrice: new Prisma.Decimal('100.00'), defaultDurationMinutes: 45 } });
      await prisma.studentCourseAccount.create({ data: {
        id: accountId, studentId, courseId, currentUnitPrice: new Prisma.Decimal('100.00'),
        openingPaidBalance: new Prisma.Decimal('50.00'), openingGiftBalance: new Prisma.Decimal('5.00'),
      } });
    });

    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      await prisma.ledgerEntry.deleteMany({ where: { commandId: { in: commandKeys } } });
      await prisma.paymentRecord.deleteMany({ where: { accountId } });
      await prisma.giftRecord.deleteMany({ where: { accountId } });
      await prisma.studentCourseAccount.deleteMany({ where: { id: accountId } });
      await prisma.course.deleteMany({ where: { id: courseId } });
      await prisma.student.deleteMany({ where: { id: studentId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
      await prisma.$disconnect();
    });

    it('previews and confirms payment atomically, returning the same receipt on replay', async () => {
      const previewKey = randomUUID();
      const confirmKey = randomUUID();
      commandKeys.push(confirmKey);
      const preview = await actions.createPaymentPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: previewKey,
        accountId, amount: '25.50', channel: PaymentChannel.WECHAT,
        occurredAt: new Date('2026-10-17T02:00:00.000Z'), note: 'AI Native L2 测试',
      });
      previewIds.push(preview.previewId);
      expect(preview.display).toMatchObject({ beforeBalance: { paidBalance: '50.00', giftBalance: '5.00' }, afterBalance: { paidBalance: '75.50', giftBalance: '5.00' } });
      expect(preview.display).not.toHaveProperty('beforeBalance.version');
      expect(preview.display).not.toHaveProperty('afterBalance.version');
      expect((await prisma.actionPreview.findUniqueOrThrow({ where: { id: preview.previewId } })).riskLevel).toBe('L2');
      expect(await prisma.paymentRecord.count({ where: { accountId } })).toBe(0);

      const receipt = await actions.confirmMoneyPreview(preview.previewId, actor, confirmKey);
      const replay = await actions.confirmMoneyPreview(preview.previewId, actor, confirmKey);
      expect(receipt).toMatchObject({ status: 'EXECUTED', receipt: { balanceAfter: { paidBalance: '75.50', giftBalance: '5.00' } } });
      expect(replay).toEqual(receipt);
      expect(await prisma.paymentRecord.count({ where: { accountId } })).toBe(1);
      expect(await prisma.ledgerEntry.count({ where: { commandId: confirmKey } })).toBe(1);
      expect(await prisma.businessAuditEvent.count({ where: { previewId: preview.previewId, eventType: 'assistant.preview.confirmed' } })).toBe(1);
    });

    it('rejects a preview after the account version changes and confirms gift through the same ledger path', async () => {
      const staleKey = randomUUID();
      const stale = await actions.createGiftPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId, amount: '7.00', occurredAt: new Date('2026-10-17T02:10:00.000Z'),
      });
      previewIds.push(stale.previewId);
      commandKeys.push(staleKey);
      await ledger.recordGift({ accountId, amount: new Prisma.Decimal('1.00'), occurredAt: new Date(), createdById: ownerId, commandId: staleKey });
      await expect(actions.confirmMoneyPreview(stale.previewId, actor, randomUUID())).rejects.toMatchObject({ status: 409 });
      expect((await prisma.actionPreview.findUniqueOrThrow({ where: { id: stale.previewId } })).status).toBe('PENDING');

      const confirmKey = randomUUID();
      commandKeys.push(confirmKey);
      const gift = await actions.createGiftPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId, amount: '7.00', occurredAt: new Date('2026-10-17T02:15:00.000Z'),
      });
      previewIds.push(gift.previewId);
      const result = await actions.confirmMoneyPreview(gift.previewId, actor, confirmKey);
      expect(result).toMatchObject({ status: 'EXECUTED', receipt: { balanceAfter: { giftBalance: '13.00' } } });
      expect(await prisma.giftRecord.count({ where: { accountId } })).toBe(2);
    });

    it('rejects an expired Preview', async () => {
      const preview = await actions.createPaymentPreview({
        actorUserId: ownerId, runId: randomUUID(), requestId: randomUUID(), idempotencyKey: randomUUID(),
        accountId, amount: '1.00', channel: PaymentChannel.CASH, occurredAt: new Date(),
      });
      previewIds.push(preview.previewId);
      await prisma.actionPreview.update({ where: { id: preview.previewId }, data: { expiresAt: new Date(Date.now() - 1) } });
      await expect(actions.confirmMoneyPreview(preview.previewId, actor, randomUUID())).rejects.toMatchObject({ status: 409 });
      expect(await prisma.paymentRecord.count({ where: { accountId } })).toBe(1);
    });
  });
} else {
  describe.skip('Assistant payment and gift Preview/Confirm with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
