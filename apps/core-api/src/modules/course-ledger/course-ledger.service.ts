import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LedgerEntryKind,
  type PaymentChannel,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

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
  occurredAt: Date;
  note?: string | undefined;
  createdById: string;
  commandId: string;
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
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(accountId: string): Promise<CourseAccountBalance> {
    return this.getBalanceWithClient(this.prisma, accountId);
  }

  async recordPayment(input: RecordPaymentInput): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    if (input.channel === 'OTHER' && !input.note?.trim()) {
      throw new BadRequestException('选择其他渠道时必须填写备注');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
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
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
  }

  async recordGift(input: RecordGiftInput): Promise<CourseAccountBalance> {
    this.assertPositiveAmount(input.amount);
    try {
      return await this.prisma.$transaction(async (tx) => {
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
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
  }

  async reverseEntry(input: ReverseLedgerEntryInput): Promise<CourseAccountBalance> {
    try {
      return await this.prisma.$transaction(async (tx) => {
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
        const existingReversal = await tx.ledgerEntry.findUnique({
          where: { reversesEntryId: original.id },
          select: { id: true },
        });
        if (existingReversal) throw new ConflictException('该金额流水已冲正');

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
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveCommandConflict(input.commandId, input.createdById);
    }
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
