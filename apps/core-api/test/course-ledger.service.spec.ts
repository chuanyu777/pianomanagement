import { Prisma } from '../src/generated/prisma/client.js';
import { CourseLedgerService } from '../src/modules/course-ledger/course-ledger.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountId = 'account-1';
const actorId = 'owner-1';
const at = new Date('2026-10-16T02:00:00.000Z');

type Entry = {
  id: string;
  accountId: string;
  kind: string;
  paidDelta: Prisma.Decimal;
  giftDelta: Prisma.Decimal;
  occurredAt: Date;
  createdById: string;
  commandId: string;
  reversesEntryId: string | null;
};

function makePrisma(options?: { openingPaid?: string; openingGift?: string }) {
  const account = {
    id: accountId,
    openingPaidBalance: new Prisma.Decimal(options?.openingPaid ?? '0.00'),
    openingGiftBalance: new Prisma.Decimal(options?.openingGift ?? '0.00'),
  };
  const entries: Entry[] = [];
  const payments: Array<Record<string, unknown>> = [];
  const gifts: Array<Record<string, unknown>> = [];
  let nextId = 1;
  let transactionTail = Promise.resolve();

  const tx = {
    studentCourseAccount: {
      findUnique: vi.fn(async () => account),
      update: vi.fn(async () => account),
    },
    paymentRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `payment-${nextId++}`, ...data };
        payments.push(record);
        return record;
      }),
    },
    giftRecord: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `gift-${nextId++}`, ...data };
        gifts.push(record);
        return record;
      }),
    },
    ledgerEntry: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        if (where.commandId) return entries.find((entry) => entry.commandId === where.commandId) ?? null;
        if (where.id) return entries.find((entry) => entry.id === where.id) ?? null;
        if (where.reversesEntryId) {
          return entries.find((entry) => entry.reversesEntryId === where.reversesEntryId) ?? null;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where: { accountId: string } }) =>
        entries.filter((entry) => entry.accountId === where.accountId)),
      create: vi.fn(async ({ data }: { data: Omit<Entry, 'id'> }) => {
        const entry = { id: `entry-${nextId++}`, ...data };
        entries.push(entry);
        return entry;
      }),
    },
    $queryRaw: vi.fn(async () => [{ id: accountId }]),
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

  return { prisma, tx, entries, payments, gifts };
}

describe('CourseLedgerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives each balance from immutable ledger deltas plus the account opening balances', async () => {
    const { prisma, tx, entries } = makePrisma({ openingPaid: '125.30', openingGift: '40.00' });
    entries.push(
      {
        id: 'entry-payment', accountId, kind: 'PAYMENT', paidDelta: new Prisma.Decimal('50.25'),
        giftDelta: new Prisma.Decimal('0.00'), occurredAt: at, createdById: actorId,
        commandId: 'payment-command', reversesEntryId: null,
      },
      {
        id: 'entry-gift', accountId, kind: 'GIFT', paidDelta: new Prisma.Decimal('0.00'),
        giftDelta: new Prisma.Decimal('12.40'), occurredAt: at, createdById: actorId,
        commandId: 'gift-command', reversesEntryId: null,
      },
      {
        id: 'entry-adjustment', accountId, kind: 'LESSON_CONSUMPTION',
        paidDelta: new Prisma.Decimal('-5.55'), giftDelta: new Prisma.Decimal('-2.10'),
        occurredAt: at, createdById: actorId, commandId: 'lesson-command', reversesEntryId: null,
      },
    );
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    await expect(service.getBalance(accountId)).resolves.toEqual({
      accountId,
      paidBalance: '170.00',
      giftBalance: '50.30',
      totalBalance: '220.30',
    });
    expect(tx.studentCourseAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: accountId },
      select: expect.objectContaining({ openingPaidBalance: true, openingGiftBalance: true }),
    }));
    expect(tx.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId },
    }));
    expect(tx.ledgerEntry).not.toHaveProperty('update');
    expect(tx.ledgerEntry).not.toHaveProperty('delete');
  });

  it('records a positive payment only in the paid pool using Prisma Decimal and its payment channel', async () => {
    const { prisma, tx, entries, payments } = makePrisma();
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    const result = await service.recordPayment({
      accountId,
      amount: new Prisma.Decimal('123.45'),
      channel: 'WECHAT',
      occurredAt: at,
      createdById: actorId,
      commandId: 'payment-1',
    });

    expect(payments).toHaveLength(1);
    const paymentRecord = payments[0]!;
    expect(paymentRecord).toMatchObject({ amount: expect.any(Prisma.Decimal), channel: 'WECHAT' });
    expect((paymentRecord['amount'] as Prisma.Decimal).eq('123.45')).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'PAYMENT', paidDelta: expect.any(Prisma.Decimal) });
    expect(entries[0]?.paidDelta.eq('123.45')).toBe(true);
    expect(entries[0]?.giftDelta.eq('0.00')).toBe(true);
    expect(result).toMatchObject({ paidBalance: '123.45', giftBalance: '0.00', totalBalance: '123.45' });
    expect(tx.ledgerEntry).not.toHaveProperty('update');
    expect(tx.ledgerEntry).not.toHaveProperty('delete');
  });

  it('records a positive gift only in the gift pool, independently of any payment channel', async () => {
    const { prisma, entries, gifts } = makePrisma();
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    const result = await service.recordGift({
      accountId,
      amount: new Prisma.Decimal('80.00'),
      occurredAt: at,
      createdById: actorId,
      commandId: 'gift-1',
    });

    expect(gifts).toHaveLength(1);
    const giftRecord = gifts[0]!;
    expect(giftRecord).toMatchObject({ amount: expect.any(Prisma.Decimal) });
    expect((giftRecord['amount'] as Prisma.Decimal).eq('80.00')).toBe(true);
    expect(giftRecord).not.toHaveProperty('channel');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'GIFT', giftDelta: expect.any(Prisma.Decimal) });
    expect(entries[0]?.paidDelta.eq('0.00')).toBe(true);
    expect(entries[0]?.giftDelta.eq('80.00')).toBe(true);
    expect(result).toMatchObject({ paidBalance: '0.00', giftBalance: '80.00', totalBalance: '80.00' });
  });

  it('makes concurrent submissions with the same commandId produce one entry and the same result', async () => {
    const { prisma, entries, payments } = makePrisma();
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);
    const command = {
      accountId,
      amount: new Prisma.Decimal('90.10'),
      channel: 'CASH' as const,
      occurredAt: at,
      createdById: actorId,
      commandId: 'same-command',
    };

    const [first, second] = await Promise.all([
      service.recordPayment(command),
      service.recordPayment(command),
    ]);

    expect(entries).toHaveLength(1);
    expect(payments).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ paidBalance: '90.10', giftBalance: '0.00', totalBalance: '90.10' });
  });

  it('creates one equal and opposite reversal and rejects a second reversal of the same entry', async () => {
    const { prisma, entries } = makePrisma({ openingPaid: '200.00', openingGift: '30.00' });
    entries.push({
      id: 'original-entry', accountId, kind: 'PAYMENT', paidDelta: new Prisma.Decimal('75.25'),
      giftDelta: new Prisma.Decimal('0.00'), occurredAt: at, createdById: actorId,
      commandId: 'original-command', reversesEntryId: null,
    });
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);

    const reversal = await service.reverseEntry({
      entryId: 'original-entry',
      occurredAt: at,
      createdById: actorId,
      commandId: 'reverse-command-1',
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      reversesEntryId: 'original-entry',
      paidDelta: expect.any(Prisma.Decimal),
      giftDelta: expect.any(Prisma.Decimal),
    });
    expect(entries[1]?.paidDelta.eq('-75.25')).toBe(true);
    expect(entries[1]?.giftDelta.eq('0.00')).toBe(true);
    expect(reversal).toMatchObject({ paidBalance: '200.00', giftBalance: '30.00', totalBalance: '230.00' });

    await expect(service.reverseEntry({
      entryId: 'original-entry',
      occurredAt: at,
      createdById: actorId,
      commandId: 'reverse-command-2',
    })).rejects.toBeDefined();
    expect(entries).toHaveLength(2);
  });

  it('returns the original result for a repeated reversal commandId', async () => {
    const { prisma, entries } = makePrisma();
    entries.push({
      id: 'original-gift', accountId, kind: 'GIFT', paidDelta: new Prisma.Decimal('0.00'),
      giftDelta: new Prisma.Decimal('25.00'), occurredAt: at, createdById: actorId,
      commandId: 'gift-original-command', reversesEntryId: null,
    });
    const service = new CourseLedgerService(prisma as never, { assertWritableForDate: vi.fn() } as never);
    const command = {
      entryId: 'original-gift', occurredAt: at, createdById: actorId, commandId: 'gift-reversal-command',
    };

    const first = await service.reverseEntry(command);
    const second = await service.reverseEntry(command);

    expect(entries).toHaveLength(2);
    expect(entries[1]?.giftDelta.eq('-25.00')).toBe(true);
    expect(second).toEqual(first);
  });
});
