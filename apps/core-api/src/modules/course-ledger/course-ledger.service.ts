import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerEntryKind,
  type PaymentChannel,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';

type LedgerTransaction = Prisma.TransactionClient;

type LedgerEntryForBalance = {
  paidDelta: Prisma.Decimal;
  giftDelta: Prisma.Decimal;
};

type AccountForBalance = {
  id: string;
  openingPaidBalance: Prisma.Decimal;
  openingGiftBalance: Prisma.Decimal;
};

export type CourseAccountBalance = {
  accountId: string;
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
};

export type CourseAccountLedgerEntry = {
  entryId: string;
  occurredAt: string;
  kind: string;
  amount: string;
  paidDelta: string;
  giftDelta: string;
  note: string | null;
  operator: string;
};

export type CourseAccountLedger = {
  accountId: string;
  entries: CourseAccountLedgerEntry[];
};

export type CourseAccountPreviewSnapshot = CourseAccountBalance & { version: number };
export type ProjectedCourseAccountBalance = {
  before: CourseAccountBalance;
  after: CourseAccountBalance;
};

export type RecordPaymentInput = {
  accountId: string;
  amount: Prisma.Decimal;
  channel: PaymentChannel;
  occurredAt: Date;
  note?: string | undefined;
  createdById: string;
  commandId: string;
};

export type RecordGiftInput = {
  accountId: string;
  amount: Prisma.Decimal;
  occurredAt: Date;
  note?: string | undefined;
  createdById: string;
  commandId: string;
};

export type ReverseLedgerEntryInput = {
  entryId: string;
  accountVersion: number;
  occurredAt: Date;
  note?: string | undefined;
  createdById: string;
  commandId: string;
};
export type ReverseLedgerEntryPreview = {
  entryId: string;
  accountId: string;
  accountVersion: number;
  kind: 'PAYMENT' | 'GIFT';
  amount: string;
  before: CourseAccountBalance;
  after: CourseAccountBalance;
};

const ACCOUNT_BALANCE_SELECT = {
  id: true,
  openingPaidBalance: true,
  openingGiftBalance: true,
} satisfies Prisma.StudentCourseAccountSelect;

const ENTRY_BALANCE_SELECT = {
  id: true,
  accountId: true,
  kind: true,
  paidDelta: true,
  giftDelta: true,
  createdById: true,
  commandId: true,
  reversesEntryId: true,
} satisfies Prisma.LedgerEntrySelect;

function toBalance(account: AccountForBalance, entries: LedgerEntryForBalance[]): CourseAccountBalance {
  const paidBalance = entries.reduce(
    (sum, entry) => sum.add(entry.paidDelta),
    account.openingPaidBalance,
  );
  const giftBalance = entries.reduce(
    (sum, entry) => sum.add(entry.giftDelta),
    account.openingGiftBalance,
  );
  return {
    accountId: account.id,
    paidBalance: paidBalance.toFixed(2),
    giftBalance: giftBalance.toFixed(2),
    totalBalance: paidBalance.add(giftBalance).toFixed(2),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CourseLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  async getBalance(accountId: string): Promise<CourseAccountBalance> {
    return this.getBalanceWithClient(this.prisma, accountId);
  }

  async listEntries(accountId: string): Promise<CourseAccountLedger> {
    const account = await this.prisma.studentCourseAccount.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        occurredAt: true,
        kind: true,
        paidDelta: true,
        giftDelta: true,
        note: true,
        createdBy: { select: { username: true } },
      },
    });
    return {
      accountId: account.id,
      entries: entries.map((entry) => ({
        entryId: entry.id,
        occurredAt: entry.occurredAt.toISOString(),
        kind: entry.kind,
        amount: entry.paidDelta.add(entry.giftDelta).abs().toFixed(2),
        paidDelta: entry.paidDelta.toFixed(2),
        giftDelta: entry.giftDelta.toFixed(2),
        note: entry.note,
        operator: entry.createdBy.username,
      })),
    };
  }

  async getPreviewSnapshotInTransaction(
    tx: LedgerTransaction,
    accountId: string,
  ): Promise<CourseAccountPreviewSnapshot> {
    await this.lockAccount(tx, accountId);
    const account = await tx.studentCourseAccount.findUnique({
      where: { id: accountId },
      select: { version: true },
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    return { ...(await this.getBalanceWithClient(tx, accountId)), version: account.version };
  }

  projectBalance(
    before: CourseAccountBalance,
    kind: 'PAYMENT' | 'GIFT',
    amount: Prisma.Decimal,
  ): ProjectedCourseAccountBalance {
    this.assertPositiveAmount(amount);
    const paid = new Prisma.Decimal(before.paidBalance);
    const gift = new Prisma.Decimal(before.giftBalance);
    const afterPaid = kind === 'PAYMENT' ? paid.add(amount) : paid;
    const afterGift = kind === 'GIFT' ? gift.add(amount) : gift;
    return {
      before,
      after: {
        accountId: before.accountId,
        paidBalance: afterPaid.toFixed(2),
        giftBalance: afterGift.toFixed(2),
        totalBalance: afterPaid.add(afterGift).toFixed(2),
      },
    };
  }

  async recordPayment(input: RecordPaymentInput): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    if (input.channel === 'OTHER' && !input.note?.trim()) {
      throw new BadRequestException('选择其他渠道时必须填写备注');
    }
    try {
      return await this.prisma.$transaction((tx) => this.recordPaymentInTransaction(tx, input));
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
  }

  async recordPaymentInTransaction(
    tx: LedgerTransaction,
    input: RecordPaymentInput,
  ): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    if (input.channel === 'OTHER' && !input.note?.trim()) {
      throw new BadRequestException('选择其他渠道时必须填写备注');
    }
    await this.periods.assertWritableForDate(input.occurredAt, tx);
    const replay = await this.findCommandResult(tx, input.commandId, input.createdById);
    if (replay) return replay;
    await this.lockAccount(tx, input.accountId);
    const afterLockReplay = await this.findCommandResult(tx, input.commandId, input.createdById);
    if (afterLockReplay) return afterLockReplay;
    const payment = await tx.paymentRecord.create({
      data: {
        accountId: input.accountId,
        amount: input.amount,
        occurredAt: input.occurredAt,
        channel: input.channel,
        note: input.note?.trim() || null,
        createdById: input.createdById,
      },
      select: { id: true },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: input.accountId,
        kind: LedgerEntryKind.PAYMENT,
        paidDelta: input.amount,
        giftDelta: new Prisma.Decimal(0),
        occurredAt: input.occurredAt,
        note: input.note?.trim() || null,
        createdById: input.createdById,
        commandId: input.commandId,
        paymentId: payment.id,
      },
    });
    await this.incrementAccountVersion(tx, input.accountId);
    return this.getBalanceWithClient(tx, input.accountId);
  }

  async recordGift(input: RecordGiftInput): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    try {
      return await this.prisma.$transaction((tx) => this.recordGiftInTransaction(tx, input));
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
  }

  async recordGiftInTransaction(
    tx: LedgerTransaction,
    input: RecordGiftInput,
  ): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    await this.periods.assertWritableForDate(input.occurredAt, tx);
    const replay = await this.findCommandResult(tx, input.commandId, input.createdById);
    if (replay) return replay;
    await this.lockAccount(tx, input.accountId);
    const afterLockReplay = await this.findCommandResult(tx, input.commandId, input.createdById);
    if (afterLockReplay) return afterLockReplay;
    const gift = await tx.giftRecord.create({
      data: {
        accountId: input.accountId,
        amount: input.amount,
        occurredAt: input.occurredAt,
        note: input.note?.trim() || null,
        createdById: input.createdById,
      },
      select: { id: true },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: input.accountId,
        kind: LedgerEntryKind.GIFT,
        paidDelta: new Prisma.Decimal(0),
        giftDelta: input.amount,
        occurredAt: input.occurredAt,
        note: input.note?.trim() || null,
        createdById: input.createdById,
        commandId: input.commandId,
        giftId: gift.id,
      },
    });
    await this.incrementAccountVersion(tx, input.accountId);
    return this.getBalanceWithClient(tx, input.accountId);
  }

  async reverseEntry(input: ReverseLedgerEntryInput): Promise<CourseAccountBalance> {
    try {
      return await this.prisma.$transaction((tx) => this.reverseEntryInTransaction(tx, input));
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
  }

  async previewReverseEntry(entryId: string): Promise<ReverseLedgerEntryPreview> {
    const original = await this.prisma.ledgerEntry.findUnique({ where: { id: entryId }, select: ENTRY_BALANCE_SELECT });
    if (!original) throw new NotFoundException('金额流水不存在');
    if (original.kind !== LedgerEntryKind.PAYMENT && original.kind !== LedgerEntryKind.GIFT) throw new BadRequestException('当前仅支持冲正交费或赠送流水');
    const [account, existingReversal, before] = await Promise.all([
      this.prisma.studentCourseAccount.findUnique({ where: { id: original.accountId }, select: { version: true } }),
      this.prisma.ledgerEntry.findUnique({ where: { reversesEntryId: original.id }, select: { id: true } }),
      this.getBalance(original.accountId),
    ]);
    if (!account) throw new NotFoundException('学生课程账户不存在');
    if (existingReversal) throw new ConflictException('该金额流水已冲正');
    const paid = new Prisma.Decimal(before.paidBalance).sub(original.paidDelta);
    const gift = new Prisma.Decimal(before.giftBalance).sub(original.giftDelta);
    if (paid.isNegative() || gift.isNegative()) throw new BadRequestException('该流水金额已被使用，冲正后课程账户余额将为负数');
    return {
      entryId: original.id, accountId: original.accountId, accountVersion: account.version,
      kind: original.kind, amount: (original.kind === LedgerEntryKind.PAYMENT ? original.paidDelta : original.giftDelta).toFixed(2),
      before, after: { accountId: original.accountId, paidBalance: paid.toFixed(2), giftBalance: gift.toFixed(2), totalBalance: paid.add(gift).toFixed(2) },
    };
  }

  async reverseEntryInTransaction(tx: LedgerTransaction, input: ReverseLedgerEntryInput): Promise<CourseAccountBalance> {
        await this.periods.assertWritableForDate(input.occurredAt, tx);
        const replay = await this.findCommandResult(tx, input.commandId, input.createdById);
        if (replay) return replay;
        const original = await tx.ledgerEntry.findUnique({
          where: { id: input.entryId },
          select: ENTRY_BALANCE_SELECT,
        });
        if (!original) throw new NotFoundException('金额流水不存在');
        if (original.kind !== LedgerEntryKind.PAYMENT && original.kind !== LedgerEntryKind.GIFT) {
          throw new BadRequestException('当前仅支持冲正交费或赠送流水');
        }
        await this.lockAccount(tx, original.accountId);
        const account = await tx.studentCourseAccount.findUnique({
          where: { id: original.accountId },
          select: { version: true },
        });
        if (!account) throw new NotFoundException('学生课程账户不存在');
        if (account.version !== input.accountVersion) {
          throw new ConflictException('课程账户已变化，请重新确认冲正');
        }
        const existingReversal = await tx.ledgerEntry.findUnique({
          where: { reversesEntryId: original.id },
          select: { id: true },
        });
        if (existingReversal) throw new ConflictException('该金额流水已冲正');

        const balance = await this.getBalanceWithClient(tx, original.accountId);
        const resultingPaidBalance = new Prisma.Decimal(balance.paidBalance).sub(original.paidDelta);
        const resultingGiftBalance = new Prisma.Decimal(balance.giftBalance).sub(original.giftDelta);
        if (resultingPaidBalance.isNegative() || resultingGiftBalance.isNegative()) {
          throw new BadRequestException('该流水金额已被使用，冲正后课程账户余额将为负数');
        }

        await tx.ledgerEntry.create({
          data: {
            accountId: original.accountId,
            kind: original.kind === LedgerEntryKind.PAYMENT
              ? LedgerEntryKind.PAYMENT_REVERSAL
              : LedgerEntryKind.GIFT_REVERSAL,
            paidDelta: original.paidDelta.negated(),
            giftDelta: original.giftDelta.negated(),
            occurredAt: input.occurredAt,
            note: input.note?.trim() || null,
            createdById: input.createdById,
            commandId: input.commandId,
            reversesEntryId: original.id,
          },
        });
        await this.incrementAccountVersion(tx, original.accountId);
        return this.getBalanceWithClient(tx, original.accountId);
  }

  private assertPositiveAmount(amount: Prisma.Decimal): void {
    if (!amount.isFinite() || !amount.gt(0)) throw new BadRequestException('金额必须大于零');
  }

  private async lockAccount(tx: LedgerTransaction, accountId: string): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "StudentCourseAccount" WHERE "id" = ${accountId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('学生课程账户不存在');
  }

  private async incrementAccountVersion(tx: LedgerTransaction, accountId: string): Promise<void> {
    await tx.studentCourseAccount.update({
      where: { id: accountId },
      data: { version: { increment: 1 } },
      select: { id: true },
    });
  }

  private async findCommandResult(
    client: Pick<LedgerTransaction, 'ledgerEntry' | 'studentCourseAccount'>,
    commandId: string,
    actorId: string,
  ): Promise<CourseAccountBalance | undefined> {
    const entry = await client.ledgerEntry.findUnique({
      where: { commandId },
      select: { accountId: true, createdById: true },
    });
    if (!entry) return undefined;
    if (entry.createdById !== actorId) throw new ConflictException('幂等键已被其他用户使用');
    return this.getBalanceWithClient(client, entry.accountId);
  }

  private async resolveCommandConflict(commandId: string, actorId: string): Promise<CourseAccountBalance> {
    const result = await this.findCommandResult(this.prisma, commandId, actorId);
    if (!result) throw new ConflictException('命令重复提交，请使用新的幂等键重试');
    return result;
  }

  private async getBalanceWithClient(
    client: Pick<LedgerTransaction, 'studentCourseAccount' | 'ledgerEntry'>,
    accountId: string,
  ): Promise<CourseAccountBalance> {
    const account = await client.studentCourseAccount.findUnique({
      where: { id: accountId },
      select: ACCOUNT_BALANCE_SELECT,
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    const entries = await client.ledgerEntry.findMany({
      where: { accountId },
      select: { paidDelta: true, giftDelta: true },
    });
    return toBalance(account, entries);
  }
}
