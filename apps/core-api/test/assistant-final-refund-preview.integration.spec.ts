import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentChannel, UserRole } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';
import { PeriodsService } from '../src/modules/periods/periods.service.js';
import { RefundsRepository } from '../src/modules/refunds/refunds.repository.js';
import { RefundsService } from '../src/modules/refunds/refunds.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AI Native final refund Preview/Confirm with PostgreSQL', () => {
    const prisma = new PrismaService();
    const periods = new PeriodsService(prisma);
    const refunds = new RefundsService(new RefundsRepository(prisma), periods);
    const actions = new AssistantActionsService(prisma, {} as never, {} as never, refunds, undefined, undefined, periods);
    const userIds: string[] = [];
    const studentIds: string[] = [];
    const courseIds: string[] = [];
    const accountIds: string[] = [];
    const previewIds: string[] = [];
    const refundIds: string[] = [];

    beforeAll(async () => { await prisma.$connect(); });

    afterAll(async () => {
      await prisma.businessAuditEvent.deleteMany({ where: { previewId: { in: previewIds } } });
      await prisma.actionPreview.deleteMany({ where: { id: { in: previewIds } } });
      await prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.refundDetail.deleteMany({ where: { refundId: { in: refundIds } } });
      await prisma.refundRecord.deleteMany({ where: { id: { in: refundIds } } });
      await prisma.studentCourseAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });

    it('commits all refund effects atomically and replays the same confirmation', async () => {
      const owner = await prisma.user.create({
        data: { username: `refund-preview-owner-${randomUUID()}`, passwordHash: 'test-hash', role: UserRole.OWNER },
      });
      userIds.push(owner.id);
      const student = await prisma.student.create({ data: { name: `AI 退学退款学生-${randomUUID()}` } });
      studentIds.push(student.id);
      const courses = await Promise.all([
        prisma.course.create({ data: { name: `主课-${randomUUID()}`, defaultUnitPrice: '100.00', defaultDurationMinutes: 60 } }),
        prisma.course.create({ data: { name: `陪练-${randomUUID()}`, defaultUnitPrice: '80.00', defaultDurationMinutes: 30 } }),
      ]);
      courseIds.push(...courses.map(({ id }) => id));
      const accounts = await Promise.all([
        prisma.studentCourseAccount.create({ data: { studentId: student.id, courseId: courses[0]!.id, currentUnitPrice: '100.00', openingPaidBalance: '120.00', openingGiftBalance: '30.00' } }),
        prisma.studentCourseAccount.create({ data: { studentId: student.id, courseId: courses[1]!.id, currentUnitPrice: '80.00', openingPaidBalance: '50.00', openingGiftBalance: '10.00' } }),
      ]);
      accountIds.push(...accounts.map(({ id }) => id));
      const actor = { id: owner.id, username: owner.username, role: UserRole.OWNER } as const;
      const preview = await actions.previewFinalRefund({
        actorUserId: owner.id,
        runId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        studentId: student.id,
        feeAmount: '17.00',
        channel: PaymentChannel.WECHAT,
        occurredAt: new Date('2050-01-15T04:00:00.000Z'),
      });
      previewIds.push(preview.previewId);
      expect(preview.display).toMatchObject({ totalPaidRefund: '170.00', feeAmount: '17.00', feePercentage: '10.00', actualRefundAmount: '153.00' });
      const previewCourses = (preview.display as { courses: Array<{ paidRefundAmount: string; giftClearingAmount: string }> }).courses
        .map(({ paidRefundAmount, giftClearingAmount }) => ({ paidRefundAmount, giftClearingAmount }));
      expect(previewCourses).toHaveLength(2);
      expect(previewCourses).toContainEqual({ paidRefundAmount: '50.00', giftClearingAmount: '10.00' });
      expect(previewCourses).toContainEqual({ paidRefundAmount: '120.00', giftClearingAmount: '30.00' });
      expect(await prisma.refundRecord.count({ where: { studentId: student.id } })).toBe(0);

      const confirmKey = randomUUID();
      const confirmed = await actions.confirmPreview(preview.previewId, actor, confirmKey);
      const refundId = (confirmed.receipt as { refundId: string }).refundId;
      refundIds.push(refundId);
      expect(confirmed).toMatchObject({
        status: 'EXECUTED',
        receipt: { actionType: 'student.final-refund', totalPaidRefund: '170.00', feePercentage: '10.00', actualRefundAmount: '153.00', idempotencyKey: confirmKey },
      });
      await expect(actions.confirmPreview(preview.previewId, actor, confirmKey)).resolves.toEqual(confirmed);
      await expect(actions.confirmPreview(preview.previewId, actor, randomUUID())).rejects.toMatchObject({ status: 409 });

      await expect(prisma.refundRecord.findUniqueOrThrow({ where: { id: refundId } })).resolves.toMatchObject({
        studentId: student.id, totalPaidRefund: { toFixed: expect.any(Function) }, feeAmount: { toFixed: expect.any(Function) },
      });
      const details = await prisma.refundDetail.findMany({ where: { refundId }, orderBy: { accountId: 'asc' } });
      const detailAmounts = details.map((detail) => ({ paid: detail.paidRefundAmount.toFixed(2), gift: detail.giftClearingAmount.toFixed(2) }));
      expect(detailAmounts).toHaveLength(2);
      expect(detailAmounts).toContainEqual({ paid: '50.00', gift: '10.00' });
      expect(detailAmounts).toContainEqual({ paid: '120.00', gift: '30.00' });
      const ledger = await prisma.ledgerEntry.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: 'asc' }, { kind: 'asc' }] });
      const ledgerAmounts = ledger.map((entry) => ({ kind: entry.kind, paid: entry.paidDelta.toFixed(2), gift: entry.giftDelta.toFixed(2) }));
      expect(ledgerAmounts).toHaveLength(4);
      expect(ledgerAmounts).toContainEqual({ kind: 'REFUND_PAID', paid: '-120.00', gift: '0.00' });
      expect(ledgerAmounts).toContainEqual({ kind: 'REFUND_GIFT_CLEARING', paid: '0.00', gift: '-30.00' });
      expect(ledgerAmounts).toContainEqual({ kind: 'REFUND_PAID', paid: '-50.00', gift: '0.00' });
      expect(ledgerAmounts).toContainEqual({ kind: 'REFUND_GIFT_CLEARING', paid: '0.00', gift: '-10.00' });
      await expect(prisma.student.findUniqueOrThrow({ where: { id: student.id } })).resolves.toMatchObject({ withdrawnAt: new Date('2050-01-15T04:00:00.000Z') });
      await expect(prisma.actionPreview.findUniqueOrThrow({ where: { id: preview.previewId } })).resolves.toMatchObject({ status: 'EXECUTED' });
    });
  });
} else {
  describe.skip('AI Native final refund Preview/Confirm with PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
