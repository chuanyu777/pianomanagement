import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ManualExpenseCategory,
  ManualIncomeCategory,
  ManualTransactionKind,
  Prisma,
  type PaymentChannel,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';

export type CreateManualTransactionInput = {
  kind: ManualTransactionKind;
  incomeCategory?: ManualIncomeCategory | undefined;
  expenseCategory?: ManualExpenseCategory | undefined;
  amount: Prisma.Decimal;
  channel: PaymentChannel;
  occurredAt: Date;
  note?: string | undefined;
  createdById: string;
};

export type ManualTransactionSummary = {
  id: string;
  kind: ManualTransactionKind;
  incomeCategory: ManualIncomeCategory | null;
  expenseCategory: ManualExpenseCategory | null;
  amount: string;
  channel: PaymentChannel;
  occurredAt: Date;
  note: string | null;
  createdAt: Date;
};

function toSummary(value: {
  id: string;
  kind: ManualTransactionKind;
  incomeCategory: ManualIncomeCategory | null;
  expenseCategory: ManualExpenseCategory | null;
  amount: Prisma.Decimal;
  channel: PaymentChannel;
  occurredAt: Date;
  note: string | null;
  createdAt: Date;
}): ManualTransactionSummary {
  return { ...value, amount: value.amount.toFixed(2) };
}

@Injectable()
export class ManualTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  async create(input: CreateManualTransactionInput): Promise<ManualTransactionSummary> {
    const transaction = await this.prisma.$transaction((tx) => this.createInTransaction(tx, input));
    return toSummary(transaction);
  }

  async createInTransaction(
    client: Prisma.TransactionClient,
    input: CreateManualTransactionInput,
  ): Promise<{
    id: string;
    kind: ManualTransactionKind;
    incomeCategory: ManualIncomeCategory | null;
    expenseCategory: ManualExpenseCategory | null;
    amount: Prisma.Decimal;
    channel: PaymentChannel;
    occurredAt: Date;
    note: string | null;
    createdAt: Date;
  }> {
    this.validateInput(input);
    await this.periods.assertWritableForDate(input.occurredAt, client);
    return client.manualTransaction.create({
      data: {
        kind: input.kind,
        incomeCategory: input.incomeCategory ?? null,
        expenseCategory: input.expenseCategory ?? null,
        amount: input.amount,
        channel: input.channel,
        occurredAt: input.occurredAt,
        note: input.note?.trim() || null,
        createdById: input.createdById,
      },
    });
  }

  validateInput(input: CreateManualTransactionInput): void {
    if (!input.amount.isFinite() || !input.amount.gt(0)) throw new BadRequestException('金额必须大于零');
    if (input.channel === 'OTHER' && !input.note?.trim()) {
      throw new BadRequestException('选择其他渠道时必须填写备注');
    }
    this.assertCategory(input);
  }

  async list(from?: Date, to?: Date): Promise<ManualTransactionSummary[]> {
    const rows = await this.prisma.manualTransaction.findMany({
      where: from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {},
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toSummary);
  }

  private assertCategory(input: CreateManualTransactionInput): void {
    const income = input.kind === ManualTransactionKind.INCOME;
    if ((income && (!input.incomeCategory || input.expenseCategory)) || (!income && (!input.expenseCategory || input.incomeCategory))) {
      throw new BadRequestException('收入和支出必须使用对应的固定分类');
    }
  }
}
