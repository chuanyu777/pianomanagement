import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LedgerEntryKind, type PaymentChannel, Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { PeriodsService } from '../periods/periods.service.js';
import { RefundsRepository } from './refunds.repository.js';

type RefundTransaction = Prisma.TransactionClient;

export type CreateRefundInput = {
  studentId: string;
  feeAmount: Prisma.Decimal | string;
  channel: PaymentChannel;
  occurredAt: Date;
  note?: string | undefined;
  commandId: string;
};

const REFUND_WITH_DETAILS_SELECT = {
  id: true,
  studentId: true,
  totalPaidRefund: true,
  feeAmount: true,
  feePercentage: true,
  actualRefundAmount: true,
  channel: true,
  occurredAt: true,
  note: true,
  createdById: true,
  details: {
    select: {
      id: true,
      accountId: true,
      paidBalanceBefore: true,
      giftBalanceBefore: true,
      paidRefundAmount: true,
      giftClearingAmount: true,
    },
    orderBy: { accountId: 'asc' },
  },
} satisfies Prisma.RefundRecordSelect;

type RefundRecordWithDetails = Prisma.RefundRecordGetPayload<{ select: typeof REFUND_WITH_DETAILS_SELECT }>;

export type RefundSummary = {
  id: string;
  studentId: string;
  totalPaidRefund: string;
  feeAmount: string;
  feePercentage: string;
  actualRefundAmount: string;
  channel: PaymentChannel;
  occurredAt: Date;
  note: string | null;
  details: Array<{
    id: string;
    accountId: string;
    paidBalanceBefore: string;
    giftBalanceBefore: string;
    paidRefundAmount: string;
    giftClearingAmount: string;
  }>;
};

type RefundBalance = { paid: Prisma.Decimal; gift: Prisma.Decimal };

function toSummary(record: RefundRecordWithDetails): RefundSummary {
  return {
    id: record.id,
    studentId: record.studentId,
    totalPaidRefund: record.totalPaidRefund.toFixed(2),
    feeAmount: record.feeAmount.toFixed(2),
    feePercentage: record.feePercentage.toFixed(2),
    actualRefundAmount: record.actualRefundAmount.toFixed(2),
    channel: record.channel,
    occurredAt: record.occurredAt,
    note: record.note,
    details: record.details.map((detail) => ({
      id: detail.id,
      accountId: detail.accountId,
      paidBalanceBefore: detail.paidBalanceBefore.toFixed(2),
      giftBalanceBefore: detail.giftBalanceBefore.toFixed(2),
      paidRefundAmount: detail.paidRefundAmount.toFixed(2),
      giftClearingAmount: detail.giftClearingAmount.toFixed(2),
    })),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly repository: RefundsRepository,
    private readonly periods: PeriodsService,
  ) {}

  async refund(input: CreateRefundInput, actor: AuthenticatedActor): Promise<RefundSummary> {
    try {
      this.validateInput(input, actor);
      return await this.repository.transaction((tx) => this.refundInTransaction(tx, input, actor));
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveUniqueConflict(input, actor.id);
    }
  }

  /**
   * Executes the complete refund mutation on the caller's transaction.
   * Assistant Preview/Confirm uses this method so the refund, ledger reversal,
   * withdrawal state, Preview status and receipt audit commit atomically.
   */
  async refundInTransaction(
    tx: RefundTransaction,
    input: CreateRefundInput,
    actor: AuthenticatedActor,
  ): Promise<RefundSummary> {
    this.validateInput(input, actor);

    const replay = await this.findReplay(tx, input.commandId, input.studentId, actor.id);
    if (replay) return replay;

    await this.periods.assertWritableForDate(input.occurredAt, tx);
    await this.lockStudent(tx, input.studentId);

    const afterLockReplay = await this.findReplay(tx, input.commandId, input.studentId, actor.id);
    if (afterLockReplay) return afterLockReplay;
    const existingRefund = await tx.refundRecord.findUnique({
      where: { studentId: input.studentId },
      select: { id: true },
    });
    if (existingRefund) throw new ConflictException('该学生已登记退费');

    const feeAmount = this.parseFee(input.feeAmount);
    const note = input.note?.trim() || null;
    const accountIds = await this.lockStudentAccounts(tx, input.studentId);
    const accounts = accountIds.length === 0
      ? []
      : await tx.studentCourseAccount.findMany({
        where: { id: { in: accountIds } },
        orderBy: { id: 'asc' },
        select: { id: true, openingPaidBalance: true, openingGiftBalance: true },
      });
    const balances = new Map<string, RefundBalance>(accounts.map((account) => [account.id, {
      paid: account.openingPaidBalance,
      gift: account.openingGiftBalance,
    }]));
    if (accountIds.length > 0) {
      const entries = await tx.ledgerEntry.findMany({
        where: { accountId: { in: accountIds } },
        select: { accountId: true, paidDelta: true, giftDelta: true },
      });
      for (const entry of entries) {
        const balance = balances.get(entry.accountId);
        if (!balance) continue;
        balance.paid = balance.paid.add(entry.paidDelta);
        balance.gift = balance.gift.add(entry.giftDelta);
      }
    }

    for (const account of accounts) {
      const balance = balances.get(account.id)!;
      if (balance.paid.isNegative()) {
        throw new BadRequestException(`课程账户 ${account.id} 的实收余额为负数，不能办理退费`);
      }
      if (balance.gift.isNegative()) {
        throw new BadRequestException(`课程账户 ${account.id} 的赠送余额为负数，不能办理退费`);
      }
    }
    const zero = new Prisma.Decimal(0);
    const totalPaidRefund = accounts.reduce((sum, account) => {
      const paid = balances.get(account.id)!.paid;
      return sum.add(paid.gt(0) ? paid : zero);
    }, zero);
    if (feeAmount.gt(totalPaidRefund)) throw new BadRequestException('手续费不能大于实收退费总额');
    const actualRefundAmount = totalPaidRefund.sub(feeAmount);
    const feePercentage = totalPaidRefund.isZero()
      ? zero
      : feeAmount.div(totalPaidRefund).mul(100).toDecimalPlaces(2);

    const refund = await tx.refundRecord.create({
      data: {
        id: input.commandId,
        studentId: input.studentId,
        totalPaidRefund,
        feeAmount,
        feePercentage,
        actualRefundAmount,
        channel: input.channel,
        occurredAt: input.occurredAt,
        note,
        createdById: actor.id,
      },
      select: { id: true },
    });
    const createdDetails: RefundSummary['details'] = [];

    for (const account of accounts) {
      const balance = balances.get(account.id)!;
      const paidRefundAmount = balance.paid.gt(0) ? balance.paid : zero;
      const giftClearingAmount = balance.gift.gt(0) ? balance.gift : zero;
      const detail = await tx.refundDetail.create({
        data: {
          refundId: refund.id,
          accountId: account.id,
          paidBalanceBefore: balance.paid,
          giftBalanceBefore: balance.gift,
          paidRefundAmount,
          giftClearingAmount,
        },
        select: {
          id: true,
          accountId: true,
          paidBalanceBefore: true,
          giftBalanceBefore: true,
          paidRefundAmount: true,
          giftClearingAmount: true,
        },
      });
      if (paidRefundAmount.gt(0)) {
        await this.createRefundLedgerEntry(tx, {
          accountId: account.id,
          refundDetailId: detail.id,
          kind: LedgerEntryKind.REFUND_PAID,
          paidDelta: paidRefundAmount.negated(),
          giftDelta: zero,
          occurredAt: input.occurredAt,
          note,
          createdById: actor.id,
        });
      }
      if (giftClearingAmount.gt(0)) {
        await this.createRefundLedgerEntry(tx, {
          accountId: account.id,
          refundDetailId: detail.id,
          kind: LedgerEntryKind.REFUND_GIFT_CLEARING,
          paidDelta: zero,
          giftDelta: giftClearingAmount.negated(),
          occurredAt: input.occurredAt,
          note,
          createdById: actor.id,
        });
      }
      await tx.studentCourseAccount.update({
        where: { id: account.id },
        data: { version: { increment: 1 } },
        select: { id: true },
      });
      createdDetails.push({
        id: detail.id,
        accountId: detail.accountId,
        paidBalanceBefore: detail.paidBalanceBefore.toFixed(2),
        giftBalanceBefore: detail.giftBalanceBefore.toFixed(2),
        paidRefundAmount: detail.paidRefundAmount.toFixed(2),
        giftClearingAmount: detail.giftClearingAmount.toFixed(2),
      });
    }

    await tx.student.update({
      where: { id: input.studentId },
      data: { withdrawnAt: input.occurredAt },
      select: { id: true },
    });
    return {
      id: refund.id,
      studentId: input.studentId,
      totalPaidRefund: totalPaidRefund.toFixed(2),
      feeAmount: feeAmount.toFixed(2),
      feePercentage: feePercentage.toFixed(2),
      actualRefundAmount: actualRefundAmount.toFixed(2),
      channel: input.channel,
      occurredAt: input.occurredAt,
      note,
      details: createdDetails,
    };
  }

  private validateInput(input: CreateRefundInput, actor: AuthenticatedActor): void {
    if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以登记退费');
    this.parseFee(input.feeAmount);
    const note = input.note?.trim() || null;
    if (input.channel === 'OTHER' && !note) throw new BadRequestException('选择其他渠道时必须填写备注');
    if (!Number.isFinite(input.occurredAt.getTime())) throw new BadRequestException('退费时间无效');
  }

  private parseFee(feeAmount: Prisma.Decimal | string): Prisma.Decimal {
    try {
      const parsed = new Prisma.Decimal(feeAmount);
      if (!parsed.isFinite() || parsed.isNegative()) throw new BadRequestException('手续费不能为负数');
      if (parsed.decimalPlaces() > 2 || parsed.gt('999999999999.99')) {
        throw new BadRequestException('手续费最多保留两位小数且不能超过金额上限');
      }
      return parsed;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('手续费金额无效');
    }
  }

  private async findReplay(
    tx: Pick<RefundTransaction, 'refundRecord'>,
    commandId: string,
    studentId: string,
    actorId: string,
  ): Promise<RefundSummary | undefined> {
    const record = await tx.refundRecord.findUnique({
      where: { id: commandId },
      select: REFUND_WITH_DETAILS_SELECT,
    });
    if (!record) return undefined;
    if (record.studentId !== studentId || record.createdById !== actorId) {
      throw new ConflictException('幂等键已用于其他退费操作');
    }
    return toSummary(record);
  }

  private async resolveUniqueConflict(input: CreateRefundInput, actorId: string): Promise<RefundSummary> {
    const replay = await this.repository.refundRecord.findUnique({
      where: { id: input.commandId },
      select: REFUND_WITH_DETAILS_SELECT,
    });
    if (replay) {
      if (replay.studentId !== input.studentId || replay.createdById !== actorId) {
        throw new ConflictException('幂等键已用于其他退费操作');
      }
      return toSummary(replay);
    }
    const existing = await this.repository.refundRecord.findUnique({
      where: { studentId: input.studentId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('该学生已登记退费');
    throw new ConflictException('幂等键重复提交，请使用新的 Idempotency-Key 重试');
  }

  private async lockStudent(tx: Pick<RefundTransaction, '$queryRaw'>, studentId: string): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Student" WHERE "id" = ${studentId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundException('学生不存在');
  }

  private async lockStudentAccounts(
    tx: Pick<RefundTransaction, '$queryRaw'>,
    studentId: string,
  ): Promise<string[]> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "StudentCourseAccount"
      WHERE "studentId" = ${studentId}
      ORDER BY "id" FOR UPDATE
    `;
    return locked.map(({ id }) => id);
  }

  private async createRefundLedgerEntry(
    tx: Pick<RefundTransaction, 'ledgerEntry'>,
    input: {
      accountId: string;
      refundDetailId: string;
      kind: LedgerEntryKind;
      paidDelta: Prisma.Decimal;
      giftDelta: Prisma.Decimal;
      occurredAt: Date;
      note: string | null;
      createdById: string;
    },
  ): Promise<void> {
    await tx.ledgerEntry.create({ data: { ...input, commandId: randomUUID() } });
  }
}
