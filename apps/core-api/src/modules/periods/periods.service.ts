import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { businessMonthStart } from '../../common/time/business-calendar.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerEntryKind, LessonStatus, PayrollStatus } from '../../generated/prisma/client.js';

type DatabaseClient = Prisma.TransactionClient | PrismaService;

export type ClosedPeriodSummary = {
  periodStart: Date;
  closedAt: Date;
  reopenedAt: Date | null;
  reopenReason: string | null;
};

export type PeriodCloseReadiness = {
  period: string;
  closed: boolean;
  blockers: Array<{ code: 'PENDING_LESSONS' | 'MISSING_PAYROLL' | 'UNPAID_PAYROLL' | 'REFUND_ANOMALY' | 'LEDGER_ANOMALY'; count: number; message: string }>;
  pendingLessons: Array<{ lessonId: string; studentName: string; courseName: string; teacherName: string; endsAt: string }>;
  missingPayrollTeachers: Array<{ teacherId: string; teacherName: string }>;
  unpaidPayrolls: Array<{ payrollId: string; teacherId: string; teacherName: string; netSalary: string }>;
  refundAnomalies: Array<{ refundId: string; studentName: string; issue: string }>;
  ledgerAnomalies: Array<{ entryId: string; kind: string; issue: string }>;
};

function businessMonthRange(start: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return {
    start: new Date(monthStart - offset),
    end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - offset),
  };
}

@Injectable()
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  async assertWritableForDate(occurredAt: Date, client: DatabaseClient = this.prisma): Promise<void> {
    const periodStart = businessMonthStart(occurredAt);
    const closed = await client.closedPeriod.findFirst({
      where: { periodStart, reopenedAt: null },
      select: { id: true },
    });
    if (closed) throw new ConflictException('该业务月份已关账，不能修改资金或课消记录');
  }

  async close(periodStart: Date, actorId: string): Promise<ClosedPeriodSummary> {
    return this.prisma.$transaction((tx) => this.closeInTransaction(tx, periodStart, actorId));
  }

  async closeInTransaction(
    tx: Prisma.TransactionClient,
    periodStart: Date,
    actorId: string,
  ): Promise<ClosedPeriodSummary> {
    await this.assertCloseableInTransaction(tx, periodStart);
    const reclaimed = await tx.closedPeriod.updateMany({
      where: { periodStart, reopenedAt: { not: null } },
      data: { closedAt: new Date(), closedById: actorId, reopenedAt: null, reopenedById: null, reopenReason: null },
    });
    if (reclaimed.count === 1) {
      return tx.closedPeriod.findUniqueOrThrow({
        where: { periodStart },
        select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      });
    }
    try {
      const closed = await tx.closedPeriod.create({
        data: { periodStart, closedById: actorId },
        select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      });
      return closed;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该月份已经关账');
      }
      throw error;
    }
  }

  async preclose(periodStart: Date): Promise<PeriodCloseReadiness> {
    return this.getCloseReadiness(this.prisma, periodStart);
  }

  private async assertCloseableInTransaction(tx: Prisma.TransactionClient, periodStart: Date): Promise<void> {
    const readiness = await this.getCloseReadiness(tx, periodStart);
    if (readiness.blockers.length > 0) {
      throw new ConflictException(`该月份存在关账阻断：${readiness.blockers.map((item) => item.message).join('；')}`);
    }
  }

  private async getCloseReadiness(client: DatabaseClient, periodStart: Date): Promise<PeriodCloseReadiness> {
    const range = businessMonthRange(periodStart);
    const now = new Date();
    const [pendingLessons, completedLessons, payrolls, refunds, ledgerEntries, closedPeriod] = await Promise.all([
      client.lesson.findMany({
        where: { status: LessonStatus.SCHEDULED, startsAt: { gte: range.start, lt: range.end }, endsAt: { lt: now } },
        orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
        select: { id: true, endsAt: true, account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } }, teacher: { select: { id: true, name: true } } },
      }),
      client.lesson.findMany({
        where: { status: LessonStatus.COMPLETED, completedAt: { gte: range.start, lt: range.end } },
        select: { teacherId: true, teacher: { select: { id: true, name: true } } },
      }),
      client.payroll.findMany({
        where: { periodStart },
        select: { id: true, teacherId: true, status: true, netSalary: true, teacher: { select: { name: true } } },
      }),
      client.refundRecord.findMany({ where: { occurredAt: { gte: range.start, lt: range.end } }, select: { id: true, totalPaidRefund: true, feeAmount: true, actualRefundAmount: true, student: { select: { name: true } }, details: { select: { paidRefundAmount: true, ledgerEntries: { select: { kind: true, paidDelta: true } } } } } }),
      client.ledgerEntry.findMany({ where: { occurredAt: { gte: range.start, lt: range.end } }, select: { id: true, kind: true, paidDelta: true, giftDelta: true, paymentId: true, giftId: true, lessonId: true, refundDetailId: true, reversesEntryId: true, correctsEntryId: true, payment: { select: { amount: true } }, gift: { select: { amount: true } }, lesson: { select: { unitPriceSnapshot: true } }, refundDetail: { select: { paidRefundAmount: true, giftClearingAmount: true } }, reversesEntry: { select: { kind: true, paidDelta: true, giftDelta: true } }, correctsEntry: { select: { kind: true } } } }),
      client.closedPeriod.findUnique({ where: { periodStart }, select: { reopenedAt: true } }),
    ]);
    const payrollTeacherIds = new Set(payrolls.map((payroll) => payroll.teacherId));
    const seenTeachers = new Set<string>();
    const missingPayrollTeachers = completedLessons.flatMap((lesson) => {
      if (payrollTeacherIds.has(lesson.teacherId) || seenTeachers.has(lesson.teacherId)) return [];
      seenTeachers.add(lesson.teacherId);
      return [{ teacherId: lesson.teacher.id, teacherName: lesson.teacher.name }];
    }).sort((left, right) => left.teacherName.localeCompare(right.teacherName, 'zh-CN') || left.teacherId.localeCompare(right.teacherId));
    const pending = pendingLessons.map((lesson) => ({ lessonId: lesson.id, studentName: lesson.account.student.name, courseName: lesson.account.course.name, teacherName: lesson.teacher.name, endsAt: lesson.endsAt.toISOString() }));
    const unpaid = payrolls.filter((payroll) => payroll.status === PayrollStatus.UNPAID).map((payroll) => ({ payrollId: payroll.id, teacherId: payroll.teacherId, teacherName: payroll.teacher.name, netSalary: payroll.netSalary.toFixed(2) }));
    const refundAnomalies = refunds.flatMap((refund) => {
      const detailTotal = refund.details.reduce((sum, detail) => sum.add(detail.paidRefundAmount), new Prisma.Decimal(0));
      const ledgerTotal = refund.details.flatMap((detail) => detail.ledgerEntries).filter((entry) => entry.kind === LedgerEntryKind.REFUND_PAID).reduce((sum, entry) => sum.add(entry.paidDelta.negated()), new Prisma.Decimal(0));
      const issues: string[] = [];
      if (!detailTotal.eq(refund.totalPaidRefund)) issues.push('退款明细合计不一致');
      if (!refund.totalPaidRefund.sub(refund.feeAmount).eq(refund.actualRefundAmount)) issues.push('实际退款金额不一致');
      if (!ledgerTotal.eq(refund.totalPaidRefund)) issues.push('退款流水合计不一致');
      return issues.map((issue) => ({ refundId: refund.id, studentName: refund.student.name, issue }));
    });
    const ledgerAnomalies = ledgerEntries.flatMap((entry) => {
      let issue: string | null = null;
      if (entry.kind === LedgerEntryKind.PAYMENT) issue = !entry.payment || !entry.paymentId || !entry.paidDelta.eq(entry.payment.amount) || !entry.giftDelta.isZero() ? '交费流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.GIFT) issue = !entry.gift || !entry.giftId || !entry.giftDelta.eq(entry.gift.amount) || !entry.paidDelta.isZero() ? '赠送流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.LESSON_CONSUMPTION) issue = !entry.lesson || !entry.lessonId || !entry.lesson.unitPriceSnapshot || !entry.paidDelta.add(entry.giftDelta).eq(entry.lesson.unitPriceSnapshot.negated()) ? '课消流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.REFUND_PAID) issue = !entry.refundDetail || !entry.refundDetailId || !entry.paidDelta.eq(entry.refundDetail.paidRefundAmount.negated()) || !entry.giftDelta.isZero() ? '退款实收流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.REFUND_GIFT_CLEARING) issue = !entry.refundDetail || !entry.refundDetailId || !entry.giftDelta.eq(entry.refundDetail.giftClearingAmount.negated()) || !entry.paidDelta.isZero() ? '赠送清零流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.PAYMENT_REVERSAL || entry.kind === LedgerEntryKind.GIFT_REVERSAL || entry.kind === LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL) issue = !entry.reversesEntryId || !entry.reversesEntry || !entry.paidDelta.eq(entry.reversesEntry.paidDelta.negated()) || !entry.giftDelta.eq(entry.reversesEntry.giftDelta.negated()) ? '冲正流水关联或金额不一致' : null;
      else if (entry.kind === LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION) issue = !entry.correctsEntryId || !entry.correctsEntry ? '课消纠正流水缺少原流水关联' : null;
      return issue ? [{ entryId: entry.id, kind: entry.kind, issue }] : [];
    });
    const blockers: PeriodCloseReadiness['blockers'] = [];
    if (pending.length > 0) blockers.push({ code: 'PENDING_LESSONS', count: pending.length, message: `有 ${pending.length} 节已结束但未确认的课程` });
    if (missingPayrollTeachers.length > 0) blockers.push({ code: 'MISSING_PAYROLL', count: missingPayrollTeachers.length, message: `有 ${missingPayrollTeachers.length} 位教师尚未生成工资` });
    if (unpaid.length > 0) blockers.push({ code: 'UNPAID_PAYROLL', count: unpaid.length, message: `有 ${unpaid.length} 笔工资尚未支付` });
    if (refundAnomalies.length > 0) blockers.push({ code: 'REFUND_ANOMALY', count: refundAnomalies.length, message: `有 ${refundAnomalies.length} 项退款数据异常` });
    if (ledgerAnomalies.length > 0) blockers.push({ code: 'LEDGER_ANOMALY', count: ledgerAnomalies.length, message: `有 ${ledgerAnomalies.length} 项账户流水异常` });
    return { period: `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`, closed: Boolean(closedPeriod && !closedPeriod.reopenedAt), blockers, pendingLessons: pending, missingPayrollTeachers, unpaidPayrolls: unpaid, refundAnomalies, ledgerAnomalies };
  }

  async reopen(periodStart: Date, reason: string, actorId: string): Promise<ClosedPeriodSummary> {
    return this.prisma.$transaction((tx) => this.reopenInTransaction(tx, periodStart, reason, actorId));
  }

  async reopenInTransaction(
    tx: Prisma.TransactionClient,
    periodStart: Date,
    reason: string,
    actorId: string,
  ): Promise<ClosedPeriodSummary> {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw new ConflictException('重开关账月份必须填写原因');
    const target = await this.getReopenableInTransaction(tx, periodStart);
    return tx.closedPeriod.update({
      where: { id: target.id },
      data: { reopenedAt: new Date(), reopenedById: actorId, reopenReason: normalizedReason },
      select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
    });
  }

  async previewReopen(periodStart: Date): Promise<{ closedPeriodId: string; closedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.getReopenableInTransaction(tx, periodStart);
      return { closedPeriodId: target.id, closedAt: target.closedAt };
    });
  }

  private async getReopenableInTransaction(tx: Prisma.TransactionClient, periodStart: Date) {
    const target = await tx.closedPeriod.findUnique({
      where: { periodStart },
      select: { id: true, closedAt: true, reopenedAt: true },
    });
    if (!target) throw new NotFoundException('该月份尚未关账');
    if (target.reopenedAt) throw new ConflictException('该月份已经重新打开');
    const latest = await tx.closedPeriod.findFirst({
      where: { reopenedAt: null },
      orderBy: { closedAt: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== target.id) throw new ConflictException('只能重新打开最近一次关账的月份');
    return target;
  }

  list(): Promise<ClosedPeriodSummary[]> {
    return this.prisma.closedPeriod.findMany({
      select: { periodStart: true, closedAt: true, reopenedAt: true, reopenReason: true },
      orderBy: { periodStart: 'desc' },
    });
  }
}
