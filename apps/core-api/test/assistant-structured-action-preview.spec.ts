import { describe, expect, it, vi } from 'vitest';
import { Prisma, PreviewStatus } from '../src/generated/prisma/client.js';
import { AssistantActionsService } from '../src/modules/assistant-actions/assistant-actions.service.js';

const owner = { id: 'owner-1', username: 'owner', role: 'OWNER' as const };

function createPreview(id = 'preview-1', actionType = 'manual-transaction.create') {
  const now = new Date();
  return {
    id, actorUserId: owner.id, actionType, schemaVersion: `${actionType}.v1`, riskLevel: 'L2' as const,
    normalizedCommandJson: {}, displayJson: {}, resourceVersionsJson: {}, idempotencyKey: 'preview-key',
    status: PreviewStatus.PENDING, expiresAt: new Date(now.getTime() + 300_000), executedAt: null,
    createdAt: now, updatedAt: now,
  };
}

function serviceWith(overrides: Record<string, unknown> = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    actionPreview: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...createPreview('preview-1', String(data.actionType)), ...data })),
      findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: 'preview-1', status: PreviewStatus.EXECUTED }),
    },
    businessAuditEvent: {
      create: vi.fn().mockResolvedValue({ id: 'audit-confirmed' }),
      findFirst: vi.fn(),
    },
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ ...owner, isActive: true, teacher: null }) },
    actionPreview: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    ...overrides,
  };
  const manual = {
    validateInput: vi.fn(),
    createInTransaction: vi.fn().mockResolvedValue({ id: 'manual-1' }),
  };
  const payroll = {
    previewGenerate: vi.fn().mockResolvedValue({
      teacherId: 'teacher-1', teacherName: '李老师', periodStart: new Date('2026-10-01T00:00:00.000Z'),
      teacherUpdatedAt: new Date('2026-10-18T00:00:00.000Z'), courseRevenue: '100.00', baseSalary: '3000.00',
      commissionRate: '10.0000', commissionAmount: '10.00', grossSalary: '3010.00', netSalary: '3010.00',
    }),
    findById: vi.fn().mockResolvedValue({ id: 'payroll-1', teacherId: 'teacher-1', teacherName: '李老师', periodStart: new Date('2026-10-01T00:00:00.000Z'), status: 'UNPAID', netSalary: '3010.00', version: 2 }),
    generateInTransaction: vi.fn().mockResolvedValue({ id: 'payroll-1', netSalary: new Prisma.Decimal('3010.00') }),
    payInTransaction: vi.fn().mockResolvedValue({ id: 'payroll-1', status: 'PAID' }),
  };
  const periods = {
    assertWritableForDate: vi.fn().mockResolvedValue(undefined),
    previewReopen: vi.fn().mockResolvedValue({ closedPeriodId: 'closed-1', closedAt: new Date('2026-10-18T00:00:00.000Z') }),
    closeInTransaction: vi.fn().mockResolvedValue({ closedAt: new Date('2026-10-19T00:00:00.000Z') }),
    reopenInTransaction: vi.fn().mockResolvedValue({ reopenedAt: new Date('2026-10-19T00:00:00.000Z') }),
  };
  return {
    service: new AssistantActionsService(prisma as never, {} as never, {} as never, undefined, manual as never, payroll as never, periods as never),
    prisma, tx, manual, payroll, periods,
  };
}

describe('AssistantActionsService structured business previews', () => {
  it('normalizes manual transaction amount/date as strings and stores preview plus audit', async () => {
    const { service, tx, manual, periods } = serviceWith();
    const result = await service.createStructuredActionPreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'idem-1',
      actionType: 'manual-transaction.create',
      command: { kind: 'INCOME', incomeCategory: 'BOOK_SALE', amount: '123.40', channel: 'CASH', occurredAt: '2026-10-19T02:00:00.000Z' },
    });
    expect(result).toMatchObject({ actionType: 'manual-transaction.create', previewId: 'preview-1' });
    expect(tx.actionPreview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      normalizedCommandJson: expect.objectContaining({ amount: '123.40', occurredAt: '2026-10-19T02:00:00.000Z' }),
    }) }));
    expect(manual.validateInput).toHaveBeenCalledTimes(1);
    expect(periods.assertWritableForDate).toHaveBeenCalledTimes(1);
    expect(tx.businessAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it('rejects numeric amounts before opening a preview transaction', async () => {
    const { service, prisma } = serviceWith();
    await expect(service.createStructuredActionPreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: 'idem-2',
      actionType: 'manual-transaction.create',
      command: { kind: 'INCOME', incomeCategory: 'BOOK_SALE', amount: 123.4, channel: 'CASH', occurredAt: '2026-10-19T02:00:00.000Z' },
    })).rejects.toThrow('amount 必须是非空字符串');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['payroll.generate', { teacherId: 'teacher-1', period: '2026-10' }],
    ['payroll.pay', { payrollId: 'payroll-1', paidAt: '2026-10-19T02:00:00.000Z', channel: 'WECHAT' }],
    ['period.close', { period: '2026-10' }],
    ['period.reopen', { period: '2026-10', reason: '补录遗漏记录' }],
  ] as const)('creates a %s preview through its domain service', async (actionType, command) => {
    const { service, payroll, periods } = serviceWith();
    const result = await service.createStructuredActionPreview({
      actorUserId: owner.id, runId: 'run-1', requestId: 'request-1', idempotencyKey: `idem-${actionType}`, actionType, command,
    });
    expect(result.actionType).toBe(actionType);
    if (actionType === 'payroll.generate') expect(payroll.previewGenerate).toHaveBeenCalled();
    if (actionType === 'payroll.pay') expect(payroll.findById).toHaveBeenCalledWith('payroll-1');
    if (actionType === 'period.close') expect(periods.assertWritableForDate).toHaveBeenCalled();
    if (actionType === 'period.reopen') expect(periods.previewReopen).toHaveBeenCalled();
  });

  it('executes manual transaction, preview status update, and confirmation audit in one transaction', async () => {
    const { service, prisma, tx, manual } = serviceWith();
    const preview = { ...createPreview('preview-1', 'manual-transaction.create'), normalizedCommandJson: {
      kind: 'INCOME', incomeCategory: 'BOOK_SALE', amount: '123.40', channel: 'CASH', occurredAt: '2026-10-19T02:00:00.000Z', note: null,
    }, resourceVersionsJson: { periodStart: '2026-10-01T00:00:00.000Z', periodState: 'OPEN' } };
    prisma.actionPreview.findUnique.mockResolvedValue({ actionType: 'manual-transaction.create' });
    tx.actionPreview.findUnique.mockResolvedValue(preview);
    const result = await service.confirmPreview('preview-1', owner, 'confirm-key');
    expect(result).toMatchObject({ status: PreviewStatus.EXECUTED, receipt: { manualTransactionId: 'manual-1', idempotencyKey: 'confirm-key' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(manual.createInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({ amount: expect.any(Prisma.Decimal) }));
    expect(tx.actionPreview.update).toHaveBeenCalledTimes(1);
    expect(tx.businessAuditEvent.create).toHaveBeenCalledTimes(1);
  });
});
