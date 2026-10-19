import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

export type PayrollSummary = {
  id: string; teacherId: string; teacherName: string; periodStart: Date;
  courseRevenue: string; baseSalary: string; commissionRate: string; commissionAmount: string;
  bonusAmount: string; bonusNote: string | null; deductionAmount: string; deductionNote: string | null;
  grossSalary: string; netSalary: string; status: PayrollStatus; paidAt: Date | null;
  paymentChannel: PaymentChannel | null; paymentNote: string | null; version: number;
};

export type GeneratePayrollInput = { teacherId: string; periodStart: Date; actorId: string };
export type UpdatePayrollInput = { baseSalary: Prisma.Decimal; commissionRate: Prisma.Decimal; bonusAmount: Prisma.Decimal; bonusNote?: string | undefined; deductionAmount: Prisma.Decimal; deductionNote?: string | undefined; actorId: string };
export type PayPayrollInput = { paidAt: Date; channel: PaymentChannel; note?: string | undefined; actorId: string };
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
    const grossSalary = teacher.defaultBaseSalary.add(commissionAmount);
    return {
      teacherName: teacher.name,
      teacherUpdatedAt: teacher.updatedAt,
      courseRevenue,
      baseSalary: teacher.defaultBaseSalary,
      commissionRate: teacher.defaultCommissionRate,
      commissionAmount,
      grossSalary,
      netSalary: grossSalary,
    };
  }

  async update(id: string, input: UpdatePayrollInput): Promise<PayrollSummary> {
    nonNegative(input.baseSalary, '基本工资不能为负数'); nonNegative(input.commissionRate, '提成比例不能为负数');
    nonNegative(input.bonusAmount, '奖金不能为负数'); nonNegative(input.deductionAmount, '代扣不能为负数');
    if (input.bonusAmount.gt(0) && !input.bonusNote?.trim()) throw new BadRequestException('奖金必须填写备注');
    if (input.deductionAmount.gt(0) && !input.deductionNote?.trim()) throw new BadRequestException('代扣必须填写备注');
    return summary(await this.prisma.$transaction(async (tx) => {
      const existing = await tx.payroll.findUnique({ where: { id }, select: { periodStart: true, courseRevenue: true, status: true } });
      if (!existing) throw new NotFoundException('工资记录不存在');
      if (existing.status === PayrollStatus.PAID) throw new ConflictException('已支付工资不能修改，请先取消支付');
      await this.periods.assertWritableForDate(existing.periodStart, tx);
      const commissionAmount = existing.courseRevenue.mul(input.commissionRate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const grossSalary = input.baseSalary.add(commissionAmount).add(input.bonusAmount);
      const netSalary = grossSalary.sub(input.deductionAmount);
      if (netSalary.lt(0)) throw new BadRequestException('实发工资不得小于零');
      return tx.payroll.update({ where: { id }, data: { baseSalary: input.baseSalary, commissionRate: input.commissionRate, commissionAmount, bonusAmount: input.bonusAmount, bonusNote: input.bonusAmount.gt(0) ? input.bonusNote!.trim() : null, deductionAmount: input.deductionAmount, deductionNote: input.deductionAmount.gt(0) ? input.deductionNote!.trim() : null, grossSalary, netSalary, version: { increment: 1 } }, select: PAYROLL_SELECT });
    }));
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

  async cancelPayment(id: string): Promise<PayrollSummary> {
    return summary(await this.prisma.$transaction(async (tx) => {
      const existing = await tx.payroll.findUnique({ where: { id }, select: { periodStart: true, status: true } });
      if (!existing) throw new NotFoundException('工资记录不存在');
      if (existing.status === PayrollStatus.UNPAID) throw new ConflictException('工资尚未支付');
      await this.periods.assertWritableForDate(existing.periodStart, tx);
      return tx.payroll.update({ where: { id }, data: { status: PayrollStatus.UNPAID, paidAt: null, paymentChannel: null, paymentNote: null, paidById: null, version: { increment: 1 } }, select: PAYROLL_SELECT });
    }));
  }

  async list(periodStart?: Date): Promise<PayrollSummary[]> {
    const rows = await this.prisma.payroll.findMany({ where: periodStart ? { periodStart } : {}, select: PAYROLL_SELECT, orderBy: [{ periodStart: 'desc' }, { teacher: { name: 'asc' } }] });
    return rows.map(summary);
  }
}
