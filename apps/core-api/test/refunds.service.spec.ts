import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentChannel, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { RefundsService } from '../src/modules/refunds/refunds.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const studentId = 'student-1';
const actorId = 'owner-1';
const accountA = 'account-a';
const accountB = 'account-b';
const occurredAt = new Date('2026-10-17T04:00:00.000Z');
const owner = { id: actorId, username: 'owner', role: UserRole.OWNER };

type Account = {
  id: string;
  studentId: string;
  openingPaidBalance: Prisma.Decimal;
  openingGiftBalance: Prisma.Decimal;
  version: number;
};

function account(id: string, paid: string, gift: string): Account {
  return {
    id,
    studentId,
    openingPaidBalance: new Prisma.Decimal(paid),
    openingGiftBalance: new Prisma.Decimal(gift),
    version: 0,
  };
}

function makeService(options: {
  accounts?: Account[];
  entries?: Array<Record<string, unknown>>;
  periodError?: Error;
} = {}) {
  const accounts = options.accounts ?? [account(accountA, '70.00', '30.00'), account(accountB, '0.00', '15.00')];
  const entries = options.entries ?? [
    { id: 'entry-1', accountId: accountA, paidDelta: new Prisma.Decimal('-20.00'), giftDelta: new Prisma.Decimal('5.00') },
  ];
  const refunds: Array<Record<string, unknown>> = [];
  const details: Array<Record<string, unknown>> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const student = { id: studentId, withdrawnAt: null as Date | null };
  let sequence = 0;
  let transactionTail = Promise.resolve();
  const tx = {
    student: {
      findUnique: vi.fn(async () => student),
      update: vi.fn(async ({ data }: { data: { withdrawnAt: Date } }) => {
        student.withdrawnAt = data.withdrawnAt;
        return student;
      }),
    },
    studentCourseAccount: {
      findMany: vi.fn(async () => [...accounts].sort((left, right) => left.id.localeCompare(right.id))),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = accounts.find(({ id }) => id === where.id)!;
        found.version += 1;
        return found;
      }),
    },
    refundRecord: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; studentId?: string } }) => {
        const found = refunds.find((refund) => refund['id'] === where.id || refund['studentId'] === where.studentId);
        if (!found) return null;
        return { ...found, details: details.filter((detail) => detail['refundId'] === found['id']) };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { ...data };
        refunds.push(created);
        return created;
      }),
    },
    refundDetail: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `detail-${++sequence}`, ...data };
        details.push(created);
        return created;
      }),
    },
    ledgerEntry: {
      findMany: vi.fn(async ({ where }: { where: { accountId: { in: string[] } } }) =>
        entries.filter((entry) => where.accountId.in.includes(entry['accountId'] as string))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `ledger-${++sequence}`, ...data };
        ledger.push(created);
        return created;
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      queries.push({ sql, values });
      if (sql.includes('FROM "Student"')) return student.id === values[0] ? [{ id: student.id }] : [];
      return accounts.filter((item) => item.studentId === values[0]).map(({ id }) => ({ id }));
    }),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async <T>(callback: (transaction: typeof tx) => Promise<T>) => {
      let release = (): void => {};
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    }),
  };
  const repository = { ...tx, $transaction: undefined, transaction: prisma.$transaction };
  const periods = { assertWritableForDate: vi.fn(async () => {
    if (options.periodError) throw options.periodError;
  }) };
  return {
    service: new RefundsService(repository as never, periods as never),
    prisma,
    tx,
    accounts,
    entries,
    refunds,
    details,
    ledger,
    queries,
    student,
    periods,
  };
}

function refundCommand(overrides: Record<string, unknown> = {}) {
  return {
    studentId,
    feeAmount: new Prisma.Decimal('5.00'),
    channel: PaymentChannel.CASH,
    occurredAt,
    createdById: actorId,
    commandId: '9fce6d2b-4b55-4c05-9f84-25abf95b51b6',
    ...overrides,
  };
}

describe('RefundsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refunds each account independently, clears gifts, records fee percentage, and withdraws the student', async () => {
    const fixture = makeService();
    const result = await fixture.service.refund(refundCommand(), owner);

    expect(result).toMatchObject({
      id: '9fce6d2b-4b55-4c05-9f84-25abf95b51b6',
      studentId,
      totalPaidRefund: '50.00',
      feeAmount: '5.00',
      feePercentage: '10.00',
      actualRefundAmount: '45.00',
    });
    expect(fixture.refunds[0]).toMatchObject({
      id: '9fce6d2b-4b55-4c05-9f84-25abf95b51b6',
      totalPaidRefund: expect.any(Prisma.Decimal),
      feeAmount: expect.any(Prisma.Decimal),
      actualRefundAmount: expect.any(Prisma.Decimal),
      feePercentage: expect.any(Prisma.Decimal),
    });
    expect(fixture.details).toHaveLength(2);
    expect(fixture.details.map((detail) => [detail['accountId'], (detail['paidRefundAmount'] as Prisma.Decimal).toFixed(2), (detail['giftClearingAmount'] as Prisma.Decimal).toFixed(2)])).toEqual([
      [accountA, '50.00', '35.00'],
      [accountB, '0.00', '15.00'],
    ]);
    expect(fixture.ledger.map((entry) => [entry['kind'], (entry['paidDelta'] as Prisma.Decimal).toFixed(2), (entry['giftDelta'] as Prisma.Decimal).toFixed(2)])).toEqual([
      ['REFUND_PAID', '-50.00', '0.00'],
      ['REFUND_GIFT_CLEARING', '0.00', '-35.00'],
      ['REFUND_GIFT_CLEARING', '0.00', '-15.00'],
    ]);
    expect(fixture.accounts.map(({ version }) => version)).toEqual([1, 1]);
    expect(fixture.student.withdrawnAt).toEqual(occurredAt);
    expect(fixture.periods.assertWritableForDate).toHaveBeenCalledWith(occurredAt, expect.any(Object));
  });

  it('locks all student course accounts in sorted order', async () => {
    const fixture = makeService({
      accounts: [account('account-z', '0.00', '0.00'), account('account-a', '1.00', '0.00')],
      entries: [],
    });

    await fixture.service.refund(refundCommand({ feeAmount: new Prisma.Decimal('0.00') }), owner);

    const accountLock = fixture.queries.find(({ sql }) => sql.includes('FROM "StudentCourseAccount"'));
    expect(accountLock?.sql).toContain('ORDER BY "id" FOR UPDATE');
  });

  it('rejects a negative paid balance in any account without cross-account offsetting', async () => {
    const fixture = makeService({
      accounts: [account(accountA, '10.00', '0.00'), account(accountB, '0.00', '0.00')],
      entries: [{ id: 'negative-entry', accountId: accountB, paidDelta: new Prisma.Decimal('-3.00'), giftDelta: new Prisma.Decimal(0) }],
    });

    await expect(fixture.service.refund(refundCommand({ feeAmount: new Prisma.Decimal('0.00') }), owner))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.refunds).toHaveLength(0);
    expect(fixture.details).toHaveLength(0);
    expect(fixture.ledger).toHaveLength(0);
  });

  it('rejects a fee larger than the total paid refund', async () => {
    const fixture = makeService();

    await expect(fixture.service.refund(refundCommand({ feeAmount: new Prisma.Decimal('50.01') }), owner))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.refunds).toHaveLength(0);
  });

  it('uses zero fee percentage when no paid balance exists', async () => {
    const fixture = makeService({
      accounts: [account(accountA, '0.00', '20.00')],
      entries: [],
    });

    const result = await fixture.service.refund(refundCommand({ feeAmount: new Prisma.Decimal('0.00') }), owner);

    expect(result).toMatchObject({ totalPaidRefund: '0.00', feeAmount: '0.00', feePercentage: '0.00', actualRefundAmount: '0.00' });
    expect(fixture.ledger).toMatchObject([{ kind: 'REFUND_GIFT_CLEARING', paidDelta: expect.any(Prisma.Decimal) }]);
    expect((fixture.ledger.at(0)!['paidDelta'] as Prisma.Decimal).isZero()).toBe(true);
  });

  it('requires a note for OTHER channel and checks the accounting period', async () => {
    const fixture = makeService();
    await expect(fixture.service.refund(refundCommand({ channel: PaymentChannel.OTHER }), owner))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.periods.assertWritableForDate).not.toHaveBeenCalled();

    const closed = makeService({ periodError: new ConflictException('该业务月份已关账') });
    await expect(closed.service.refund(refundCommand(), owner)).rejects.toBeInstanceOf(ConflictException);
    expect(closed.refunds).toHaveLength(0);
  });

  it('returns the same refund for concurrent requests with the same idempotency key', async () => {
    const fixture = makeService();
    const command = refundCommand();

    const [first, second] = await Promise.all([
      fixture.service.refund(command, owner),
      fixture.service.refund(command, owner),
    ]);

    expect(fixture.refunds).toHaveLength(1);
    expect(fixture.details).toHaveLength(2);
    expect(second).toEqual(first);
  });
});
