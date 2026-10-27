import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PayrollStatus, Prisma, type PaymentChannel } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';

type PayrollRecord = Prisma.PayrollGetPayload<{ select: typeof PAYROLL_SELECT }>;

const PAYROLL_SELECT = {
  id: true, teacherId: true, periodStart: true, courseRevenue: true, baseSalary: true,
  commissionRate: true, commissionAmount: true, bonusAmount: true, bonusNote: true,
  deductionAmount: true, deductionNote: true, grossSalary: true, netSalary: true,
  status: true, paidAt: true, paymentChannel: true, paymentNote: true, version: true,
  teacher: { select: { name: true } },
} satisfies Prisma.PayrollSelect;
const CANCEL_PAYROLL_SELECT = { ...PAYROLL_SELECT, paidById: true } satisfies Prisma.PayrollSelect;

export type PayrollSummary = {
  id: string; teacherId: string; teacherName: string; periodStart: Date;
  courseRevenue: string; baseSalary: string; commissionRate: string; commissionAmount: string;
  bonusAmount: string; bonusNote: string | null; deductionAmount: string; deductionNote: string | null;
  grossSalary: string; netSalary: string; status: PayrollStatus; paidAt: Date | null;
  paymentChannel: PaymentChannel | null; paymentNote: string | null; version: number;
};

export type GeneratePayrollInput = { teacherId: string; periodStart: Date; actorId: string };
export type UpdatePayrollInput = { baseSalary: Prisma.Decimal; commissionRate: Prisma.Decimal; bonusAmount: Prisma.Decimal; bonusNote?: string | undefined; deductionAmount: Prisma.Decimal; deductionNote?: string | undefined; actorId: string };
export type AdjustPayrollInput = {
  baseSalary?: Prisma.Decimal;
  commissionRate?: Prisma.Decimal;
  bonusAmount?: Prisma.Decimal;
  bonusNote?: string | undefined;
  deductionAmount?: Prisma.Decimal;
  deductionNote?: string | undefined;
  actorId: string;
};
export type PayPayrollInput = { paidAt: Date; channel: PaymentChannel; note?: string | undefined; actorId: string };
export type CancelPayrollPaymentInput = { actorId: string; expectedVersion: number; note?: string | undefined };
export type CancelPayrollPaymentPreview = { payroll: PayrollSummary; expectedVersion: number };
export type PayrollGenerationPreview = {
  teacherId: string;
  teacherName: string;
  periodStart: Date;
  teacherUpdatedAt: Date;
  courseRevenue: string;
  baseSalary: string;
  commissionRate: string;
  commissionAmount: string;
  grossSalary: string;
  netSalary: string;
};
export type PayrollAdjustmentPreview = {
  payroll: PayrollSummary;
  payrollVersion: number;
  beforeBaseSalary: string;
  afterBaseSalary: string;
  beforeCommissionRate: string;
  afterCommissionRate: string;
  beforeBonusAmount: string;
  afterBonusAmount: string;
  beforeDeductionAmount: string;
  afterDeductionAmount: string;
};

function money(value: Prisma.Decimal): string { return value.toFixed(2); }
function summary(value: PayrollRecord): PayrollSummary {
  return {
    ...value,
    teacherName: value.teacher.name,
    courseRevenue: money(value.courseRevenue), baseSalary: money(value.baseSalary),
    commissionRate: value.commissionRate.toFixed(4), commissionAmount: money(value.commissionAmount),
    bonusAmount: money(value.bonusAmount), deductionAmount: money(value.deductionAmount),
    grossSalary: money(value.grossSalary), netSalary: money(value.netSalary),
  };
}
function businessMonthRange(start: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return { start: new Date(monthStart - offset), end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - offset) };
}
function nonNegative(value: Prisma.Decimal, message: string): void {
  if (!value.isFinite() || value.lt(0)) throw new BadRequestException(message);
}
function validateAdjustInput(input: AdjustPayrollInput): void {
  if (input.baseSalary === undefined && input.commissionRate === undefined &&
    input.bonusAmount === undefined && input.deductionAmount === undefined) {
    throw new BadRequestException('至少需要调整一项工资数据');
  }
  if (input.baseSalary !== undefined) {
    nonNegative(input.baseSalary, '基本工资不能为负数');
    if (input.baseSalary.decimalPlaces() > 2) throw new BadRequestException('基本工资最多保留两位小数');
  }
  if (input.commissionRate !== undefined) {
    nonNegative(input.commissionRate, '提成比例不能为负数');
    if (input.commissionRate.gt('999.9999')) throw new BadRequestException('提成比例不能超过999.9999%');
    if (input.commissionRate.decimalPlaces() > 4) throw new BadRequestException('提成比例最多保留四位小数');
  }
  if (input.bonusAmount !== undefined) {
    nonNegative(input.bonusAmount, '奖金不能为负数');
    if (input.bonusAmount.decimalPlaces() > 2) throw new BadRequestException('奖金最多保留两位小数');
  }
  if (input.deductionAmount !== undefined) {
    nonNegative(input.deductionAmount, '代扣不能为负数');
    if (input.deductionAmount.decimalPlaces() > 2) throw new BadRequestException('代扣最多保留两位小数');
  }
}
function calculateSalary(input: {
  baseSalary: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  bonusAmount: Prisma.Decimal;
  deductionAmount: Prisma.Decimal;
}): { grossSalary: Prisma.Decimal; netSalary: Prisma.Decimal } {
  const grossSalary = input.baseSalary.add(input.commissionAmount).add(input.bonusAmount);
  return { grossSalary, netSalary: grossSalary.sub(input.deductionAmount) };
}

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService, private readonly periods: PeriodsService) {}

  async generate(input: GeneratePayrollInput): Promise<PayrollSummary> {
    await this.periods.assertWritableForDate(input.periodStart);
    try {
      const payroll = await this.prisma.$transaction((tx) => this.generateInTransaction(tx, input));
      return summary(payroll);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('该老师本月工资已经生成');
      throw error;
    }
  }

  async generateInTransaction(
    tx: Prisma.TransactionClient,
    input: GeneratePayrollInput,
    expected?: { teacherUpdatedAt: Date; courseRevenue: Prisma.Decimal },
  ) {
    await this.periods.assertWritableForDate(input.periodStart, tx);
    const calculated = await this.calculateGenerationInTransaction(tx, input);
    if (expected && (
      calculated.teacherUpdatedAt.getTime() !== expected.teacherUpdatedAt.getTime() ||
      !calculated.courseRevenue.eq(expected.courseRevenue)
    )) {
      throw new ConflictException('工资基础数据已变化，请重新预览');
    }
    return tx.payroll.create({
      data: {
        teacherId: input.teacherId,
        periodStart: input.periodStart,
        courseRevenue: calculated.courseRevenue,
        baseSalary: calculated.baseSalary,
        commissionRate: calculated.commissionRate,
        commissionAmount: calculated.commissionAmount,
        grossSalary: calculated.grossSalary,
        netSalary: calculated.netSalary,
        generatedById: input.actorId,
      },
      select: PAYROLL_SELECT,
    });
  }

  async previewGenerate(input: GeneratePayrollInput): Promise<PayrollGenerationPreview> {
    return this.prisma.$transaction(async (tx) => {
      const calculated = await this.calculateGenerationInTransaction(tx, input);
      const existing = await tx.payroll.findUnique({
        where: { teacherId_periodStart: { teacherId: input.teacherId, periodStart: input.periodStart } },
        select: { id: true },
      });
      if (existing) throw new ConflictException('该老师本月工资已经生成');
      return {
        teacherId: input.teacherId,
        teacherName: calculated.teacherName,
        periodStart: input.periodStart,
        teacherUpdatedAt: calculated.teacherUpdatedAt,
        courseRevenue: money(calculated.courseRevenue),
        baseSalary: money(calculated.baseSalary),
        commissionRate: calculated.commissionRate.toFixed(4),
        commissionAmount: money(calculated.commissionAmount),
        grossSalary: money(calculated.grossSalary),
        netSalary: money(calculated.netSalary),
      };
    });
  }

  private async calculateGenerationInTransaction(tx: Prisma.TransactionClient, input: GeneratePayrollInput) {
    const range = businessMonthRange(input.periodStart);
    const teacher = await tx.teacher.findUnique({
      where: { id: input.teacherId },
      select: { name: true, updatedAt: true, defaultBaseSalary: true, defaultCommissionRate: true },
    });
    if (!teacher) throw new NotFoundException('老师不存在');
    const revenue = await tx.lesson.aggregate({
      where: { teacherId: input.teacherId, status: 'COMPLETED', completedAt: { gte: range.start, lt: range.end } },
      _sum: { unitPriceSnapshot: true },
    });
    const courseRevenue = revenue._sum.unitPriceSnapshot ?? new Prisma.Decimal(0);
    const commissionAmount = courseRevenue.mul(teacher.defaultCommissionRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const { grossSalary, netSalary } = calculateSalary({
      baseSalary: teacher.defaultBaseSalary,
      commissionAmount,
      bonusAmount: new Prisma.Decimal(0),
      deductionAmount: new Prisma.Decimal(0),
    });
    return {
      teacherName: teacher.name,
      teacherUpdatedAt: teacher.updatedAt,
      courseRevenue,
      baseSalary: teacher.defaultBaseSalary,
      commissionRate: teacher.defaultCommissionRate,
      commissionAmount,
      grossSalary,
      netSalary,
    };
  }

  async update(id: string, input: UpdatePayrollInput): Promise<PayrollSummary> {
    return summary(await this.prisma.$transaction((tx) => this.updateInTransaction(tx, id, input)));
  }

  async previewAdjust(input: { payrollId: string } & AdjustPayrollInput): Promise<PayrollAdjustmentPreview> {
    validateAdjustInput(input);
    const before = await this.findById(input.payrollId);
    if (before.status === PayrollStatus.PAID) throw new ConflictException('已支付工资不能修改，请先取消支付');
    await this.periods.assertWritableForDate(before.periodStart);
    const baseSalary = input.baseSalary?.toFixed(2) ?? before.baseSalary;
    const commissionRate = input.commissionRate?.toFixed(4) ?? before.commissionRate;
    const bonusAmount = input.bonusAmount?.toFixed(2) ?? before.bonusAmount;
    const deductionAmount = input.deductionAmount?.toFixed(2) ?? before.deductionAmount;
    const bonusNote = input.bonusAmount === undefined ? before.bonusNote : input.bonusNote?.trim() || null;
    const deductionNote = input.deductionAmount === undefined ? before.deductionNote : input.deductionNote?.trim() || null;
    const bonus = new Prisma.Decimal(bonusAmount);
    const deduction = new Prisma.Decimal(deductionAmount);
    if (bonus.gt(0) && !bonusNote) throw new BadRequestException('奖金必须填写备注');
    if (deduction.gt(0) && !deductionNote) throw new BadRequestException('代扣必须填写备注');
    const commissionAmount = new Prisma.Decimal(before.courseRevenue)
      .mul(new Prisma.Decimal(commissionRate)).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const { grossSalary, netSalary } = calculateSalary({
      baseSalary: new Prisma.Decimal(baseSalary),
      commissionAmount,
      bonusAmount: bonus,
      deductionAmount: deduction,
    });
    if (netSalary.lt(0)) throw new BadRequestException('实发工资不得小于零');
    const updated: PayrollSummary = {
      ...before, baseSalary, commissionRate, commissionAmount: commissionAmount.toFixed(2),
      bonusAmount, bonusNote, deductionAmount, deductionNote,
      grossSalary: grossSalary.toFixed(2), netSalary: netSalary.toFixed(2), version: before.version + 1,
    };
    return {
      payroll: updated,
      payrollVersion: before.version,
      beforeBaseSalary: before.baseSalary,
      afterBaseSalary: updated.baseSalary,
      beforeCommissionRate: before.commissionRate,
      afterCommissionRate: updated.commissionRate,
      beforeBonusAmount: before.bonusAmount,
      afterBonusAmount: updated.bonusAmount,
      beforeDeductionAmount: before.deductionAmount,
      afterDeductionAmount: updated.deductionAmount,
    };
  }

  async adjustInTransaction(
    tx: Prisma.TransactionClient,
    id: string,
    input: AdjustPayrollInput,
    expectedVersion?: number,
  ) {
    validateAdjustInput(input);
    const existing = await tx.payroll.findUnique({ where: { id }, select: PAYROLL_SELECT });
    if (!existing) throw new NotFoundException('工资记录不存在');
    if (existing.status === PayrollStatus.PAID) throw new ConflictException('已支付工资不能修改，请先取消支付');
    if (expectedVersion !== undefined && existing.version !== expectedVersion) throw new ConflictException('工资记录已变化，请重新预览');
    await this.periods.assertWritableForDate(existing.periodStart, tx);
    const baseSalary = input.baseSalary ?? existing.baseSalary;
    const commissionRate = input.commissionRate ?? existing.commissionRate;
    const bonusAmount = input.bonusAmount ?? existing.bonusAmount;
    const deductionAmount = input.deductionAmount ?? existing.deductionAmount;
    const bonusNote = input.bonusAmount === undefined ? existing.bonusNote : input.bonusNote?.trim() || undefined;
    const deductionNote = input.deductionAmount === undefined ? existing.deductionNote : input.deductionNote?.trim() || undefined;
    if (bonusAmount.gt(0) && !bonusNote) throw new BadRequestException('奖金必须填写备注');
    if (deductionAmount.gt(0) && !deductionNote) throw new BadRequestException('代扣必须填写备注');
    const commissionAmount = existing.courseRevenue
      .mul(commissionRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const { grossSalary, netSalary } = calculateSalary({
      baseSalary,
      commissionAmount,
      bonusAmount,
      deductionAmount,
    });
    if (netSalary.lt(0)) throw new BadRequestException('实发工资不得小于零');
    return tx.payroll.update({ where: { id }, data: {
      baseSalary, commissionRate, commissionAmount,
      bonusAmount, bonusNote: bonusAmount.gt(0) ? bonusNote! : null,
      deductionAmount, deductionNote: deductionAmount.gt(0) ? deductionNote! : null,
      grossSalary, netSalary, version: { increment: 1 },
    }, select: PAYROLL_SELECT });
  }

  private async updateInTransaction(tx: Prisma.TransactionClient, id: string, input: UpdatePayrollInput) {
    nonNegative(input.baseSalary, '基本工资不能为负数'); nonNegative(input.commissionRate, '提成比例不能为负数');
    nonNegative(input.bonusAmount, '奖金不能为负数'); nonNegative(input.deductionAmount, '代扣不能为负数');
    if (input.bonusAmount.gt(0) && !input.bonusNote?.trim()) throw new BadRequestException('奖金必须填写备注');
    if (input.deductionAmount.gt(0) && !input.deductionNote?.trim()) throw new BadRequestException('代扣必须填写备注');
    const existing = await tx.payroll.findUnique({ where: { id }, select: { periodStart: true, courseRevenue: true, status: true } });
    if (!existing) throw new NotFoundException('工资记录不存在');
    if (existing.status === PayrollStatus.PAID) throw new ConflictException('已支付工资不能修改，请先取消支付');
    await this.periods.assertWritableForDate(existing.periodStart, tx);
    const commissionAmount = existing.courseRevenue.mul(input.commissionRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const { grossSalary, netSalary } = calculateSalary({
      baseSalary: input.baseSalary,
      commissionAmount,
      bonusAmount: input.bonusAmount,
      deductionAmount: input.deductionAmount,
    });
    if (netSalary.lt(0)) throw new BadRequestException('实发工资不得小于零');
    return tx.payroll.update({ where: { id }, data: { baseSalary: input.baseSalary, commissionRate: input.commissionRate, commissionAmount, bonusAmount: input.bonusAmount, bonusNote: input.bonusAmount.gt(0) ? input.bonusNote!.trim() : null, deductionAmount: input.deductionAmount, deductionNote: input.deductionAmount.gt(0) ? input.deductionNote!.trim() : null, grossSalary, netSalary, version: { increment: 1 } }, select: PAYROLL_SELECT });
  }

  async pay(id: string, input: PayPayrollInput): Promise<PayrollSummary> {
    if (input.channel === 'OTHER' && !input.note?.trim()) throw new BadRequestException('选择其他渠道时必须填写备注');
    return summary(await this.prisma.$transaction((tx) => this.payInTransaction(tx, id, input)));
  }

  async payInTransaction(tx: Prisma.TransactionClient, id: string, input: PayPayrollInput, expectedVersion?: number) {
    const existing = await tx.payroll.findUnique({ where: { id }, select: { periodStart: true, status: true, version: true } });
    if (!existing) throw new NotFoundException('工资记录不存在');
    if (existing.status === PayrollStatus.PAID) throw new ConflictException('工资已经支付');
    if (expectedVersion !== undefined && existing.version !== expectedVersion) throw new ConflictException('工资记录已变化，请重新预览');
    await this.periods.assertWritableForDate(existing.periodStart, tx);
    return tx.payroll.update({ where: { id }, data: { status: PayrollStatus.PAID, paidAt: input.paidAt, paymentChannel: input.channel, paymentNote: input.note?.trim() || null, paidById: input.actorId, version: { increment: 1 } }, select: PAYROLL_SELECT });
  }

  async findById(id: string): Promise<PayrollSummary> {
    const payroll = await this.prisma.payroll.findUnique({ where: { id }, select: PAYROLL_SELECT });
    if (!payroll) throw new NotFoundException('工资记录不存在');
    return summary(payroll);
  }

  async cancelPayment(id: string, input: CancelPayrollPaymentInput): Promise<PayrollSummary> {
    return summary(await this.prisma.$transaction((tx) => this.cancelPaymentInTransaction(tx, id, input)));
  }

  async previewCancelPayment(id: string): Promise<CancelPayrollPaymentPreview> {
    const payroll = await this.findById(id);
    if (payroll.status === PayrollStatus.UNPAID) throw new ConflictException('工资尚未支付');
    await this.periods.assertWritableForDate(payroll.periodStart);
    return { payroll, expectedVersion: payroll.version };
  }

  async cancelPaymentInTransaction(tx: Prisma.TransactionClient, id: string, input: CancelPayrollPaymentInput) {
      const existing = await tx.payroll.findUnique({ where: { id }, select: CANCEL_PAYROLL_SELECT });
      if (!existing) throw new NotFoundException('工资记录不存在');
      if (existing.status === PayrollStatus.UNPAID) throw new ConflictException('工资尚未支付');
      await this.periods.assertWritableForDate(existing.periodStart, tx);
      if (existing.version !== input.expectedVersion) throw new ConflictException('工资记录已变化，请重新确认撤销支付');

      const cancellation = await tx.payroll.updateMany({
        where: { id, status: PayrollStatus.PAID, version: input.expectedVersion },
        data: {
          status: PayrollStatus.UNPAID,
          paidAt: null,
          paymentChannel: null,
          paymentNote: null,
          paidById: null,
          version: { increment: 1 },
        },
      });
      if (cancellation.count !== 1) throw new ConflictException('工资记录已变化，请重新确认撤销支付');

      const updated = await tx.payroll.findUnique({ where: { id }, select: PAYROLL_SELECT });
      if (!updated) throw new NotFoundException('工资记录不存在');
      await tx.businessAuditEvent.create({
        data: {
          actorUserId: input.actorId,
          eventType: 'payroll.payment.cancelled',
          resourceType: 'payroll',
          resourceId: id,
          requestId: randomUUID(),
          detailJson: {
            payrollId: id,
            teacherId: existing.teacherId,
            periodStart: existing.periodStart.toISOString(),
            cancelledById: input.actorId,
            cancellationNote: input.note?.trim() || null,
            fromVersion: existing.version,
            toVersion: updated.version,
            netSalary: existing.netSalary.toFixed(2),
            payment: {
              paidAt: existing.paidAt?.toISOString() ?? null,
              channel: existing.paymentChannel,
              note: existing.paymentNote,
              paidById: existing.paidById,
            },
          },
        },
      });
      return updated;
  }

  async list(periodStart?: Date): Promise<PayrollSummary[]> {
    const rows = await this.prisma.payroll.findMany({ where: periodStart ? { periodStart } : {}, select: PAYROLL_SELECT, orderBy: [{ periodStart: 'desc' }, { teacher: { name: 'asc' } }] });
    return rows.map(summary);
  }
}
