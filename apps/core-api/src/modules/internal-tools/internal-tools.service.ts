import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { LedgerEntryKind, LessonStatus, PayrollStatus, Prisma, UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { CourseLedgerService } from '../course-ledger/course-ledger.service.js';
import { LessonsService, type LessonReadFilters } from '../lessons/lessons.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { StudentsService, type StudentEnrollmentStatus } from '../students/students.service.js';
import { TeachersService } from '../teachers/teachers.service.js';
import { CoursesService } from '../courses/courses.service.js';
import { businessNow } from '../../common/time/business-clock.js';

type OwnerDashboardSummary = {
  role: 'OWNER';
  businessDate: string;
  period: string;
  highlights: string[];
  todayLessons: { total: number; scheduled: number; completed: number; cancelled: number };
  todayEndedUnconfirmedCount: number;
  todayLessonItems: TodayLessonItem[];
  monthlyOperatingIncome: string | null;
  frozenStudentCount: number;
  studentsWithNegativeBalanceCount: number;
  unpaidPayrollCount: number;
};

type TeacherDashboardSummary = {
  role: 'TEACHER';
  businessDate: string;
  highlights: string[];
  todayScheduledCount: number;
  todayLessonItems: TodayLessonItem[];
  futureScheduledCount: number;
};

export type DashboardSummary = OwnerDashboardSummary | TeacherDashboardSummary;

type TodayLessonItem = {
  lessonId: string;
  startsAt: string;
  endsAt: string;
  startTime: string;
  studentName: string;
  courseName: string;
  teacherName: string;
  statusLabel: string;
};

function toTodayLessonItems(lessons: Array<{
  id: string; startsAt: Date; endsAt: Date; status: LessonStatus;
  account: { student: { name: string }; course: { name: string } }; teacher: { name: string };
}>): TodayLessonItem[] {
  const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const statusLabels: Record<LessonStatus, string> = {
    [LessonStatus.SCHEDULED]: '待上课', [LessonStatus.COMPLETED]: '已完成', [LessonStatus.CANCELLED]: '已取消',
  };
  return lessons.map((lesson) => ({
    lessonId: lesson.id, startsAt: lesson.startsAt.toISOString(), endsAt: lesson.endsAt.toISOString(),
    startTime: timeFormatter.format(lesson.startsAt), studentName: lesson.account.student.name,
    courseName: lesson.account.course.name, teacherName: lesson.teacher.name, statusLabel: statusLabels[lesson.status],
  }));
}

const TODAY_LESSON_SELECT = {
  id: true, startsAt: true, endsAt: true, status: true,
  account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } },
  teacher: { select: { name: true } },
} as const;

export type CourseAccountCandidate = {
  accountId: string;
  studentName: string;
  courseName: string;
};

export type TeacherCandidate = {
  teacherId: string;
  name: string;
};

export type StudentCandidate = {
  studentId: string;
  name: string;
};

export type LessonCandidate = {
  lessonId: string;
  studentName: string;
  courseName: string;
  teacherName: string;
  startsAt: Date;
  status: LessonStatus;
};

export type PayrollCandidate = {
  payrollId: string;
  teacherId: string;
  teacherName: string;
  period: string;
  status: PayrollStatus;
};

export type InternalLessonsQuery = {
  dateFrom: string;
  dateTo: string;
  studentName?: string | undefined;
  courseName?: string | undefined;
  teacherName?: string | undefined;
  status?: LessonStatus | undefined;
  statusText?: '待上课' | '已完成' | '已取消' | undefined;
};

export type InternalLesson = {
  lessonId: string;
  accountId: string;
  teacherId: string;
  startsAt: string;
  endsAt: string;
  studentName: string;
  courseName: string;
  teacherName: string;
  statusLabel: string;
  status: LessonStatus;
};

export type InternalLessonsRead = {
  businessDate: string;
  dateFrom: string;
  dateTo: string;
  lessons: InternalLesson[];
};

export type CourseAccountRead = {
  accountId: string;
  version: number;
  studentName: string;
  courseName: string;
  currentUnitPrice: string;
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
};

export type InternalMonthlyReportRead = {
  period: string;
  report: NonNullable<Awaited<ReturnType<ReportsService['monthly']>>> & {
    operatingIncome: string;
    cashOperatingGap: string;
  };
};

export type InternalCourseAccountLedgerEntry = {
  entryId: string;
  occurredAt: string;
  kind: string;
  amount: string;
  paidDelta: string;
  giftDelta: string;
  note: string | null;
  operator: string;
};

export type InternalCourseAccountLedgerRead = {
  accountId: string;
  entries: InternalCourseAccountLedgerEntry[];
};

export type InternalMonthlyPayrollItem = {
  payrollId: string;
  teacherId: string;
  teacherName: string;
  courseRevenue: string;
  baseSalary: string;
  commissionRate: string;
  commissionAmount: string;
  bonusAmount: string;
  bonusNote: string | null;
  deductionAmount: string;
  deductionNote: string | null;
  grossSalary: string;
  netSalary: string;
  status: PayrollStatus;
};

export type InternalMonthlyPayrollRead = {
  period: string;
  payrolls: InternalMonthlyPayrollItem[];
};

export type InternalDirectoryRead = {
  students: Array<{ studentId: string; name: string; enrollmentStatus: StudentEnrollmentStatus }>;
  teachers: Array<{ teacherId: string; name: string; isActive: boolean }>;
  courses: Array<{ courseId: string; name: string; defaultUnitPrice: string; defaultDurationMinutes: number; isActive: boolean }>;
};
export type InternalArrearsAndFrozenRead = {
  arrears: Array<{ studentId: string; studentName: string; courseId: string; courseName: string; paidBalance: string }>;
  frozenStudents: Array<{ studentId: string; name: string; reason: string }>;
};
export type InternalConsumptionGroup = Array<{ id: string; name: string; amount: string }>;
export type InternalMonthlyConsumptionRead = {
  period: string;
  totalAmount: string;
  courses: InternalConsumptionGroup;
  teachers: InternalConsumptionGroup;
  students: InternalConsumptionGroup;
};
export type InternalPrecloseRead = {
  period: string;
  closed: boolean;
  pendingLessons: Array<{ lessonId: string; studentName: string; courseName: string; teacherName: string; endsAt: string }>;
  refundAnomalies: Array<{ refundId: string; studentName: string; issue: string }>;
  missingPayrollTeachers: Array<{ teacherId: string; teacherName: string }>;
  unpaidPayrolls: Array<{ payrollId: string; teacherId: string; teacherName: string; netSalary: string }>;
  ledgerAnomalies: Array<{ entryId: string; kind: string; issue: string }>;
  blockers: Array<{ code: string; count: number; message: string }>;
  reminders: Array<{ code: string; message: string; requiresHumanJudgment: true }>;
};

const LESSON_STATUS_LABELS: Record<LessonStatus, string> = {
  [LessonStatus.SCHEDULED]: '待上课',
  [LessonStatus.COMPLETED]: '已完成',
  [LessonStatus.CANCELLED]: '已取消',
};
const LESSON_STATUS_BY_TEXT: Record<NonNullable<InternalLessonsQuery['statusText']>, LessonStatus> = {
  '待上课': LessonStatus.SCHEDULED,
  '已完成': LessonStatus.COMPLETED,
  '已取消': LessonStatus.CANCELLED,
};

function businessDateParts(value: Date): { date: string; year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values['year']);
  const month = Number(values['month']);
  return { date: `${values['year']}-${values['month']}-${values['day']}`, year, month };
}

function shanghaiMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

function businessMonthRange(start: Date): { start: Date; end: Date } {
  const offset = 8 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return {
    start: new Date(startUtc - offset),
    end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - offset),
  };
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function parseBusinessDate(date: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
  return shanghaiMidnight(date);
}

type CandidateMatch = 'search';

function candidateNameWhere(name: string, match: CandidateMatch | undefined): string | { contains: string; mode: 'insensitive' } {
  return match === 'search' ? { contains: name, mode: 'insensitive' } : name;
}

function preferExactCandidates<T>(items: T[], query: string, getName: (item: T) => string): T[] {
  const exact = items.filter((item) => getName(item) === query);
  return exact.length > 0 ? exact : items;
}

function monthStart(year: number, month: number): Date {
  const date = `${year}-${String(month).padStart(2, '0')}-01`;
  return shanghaiMidnight(date);
}

function countFrozenStudents(
  students: Array<{
    withdrawnAt: Date | null;
    courseAccounts: Array<{ createdAt: Date; lessons: Array<{ completedAt: Date | null }> }>;
  }>,
  now: Date,
): number {
  const threshold = now.getTime() - 31 * 24 * 60 * 60 * 1000;
  return students.filter((student) => {
    if (student.withdrawnAt) return false;
    const completedAt = student.courseAccounts
      .flatMap((account) => account.lessons)
      .map((lesson) => lesson.completedAt)
      .filter((date): date is Date => date !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    const referenceAt = completedAt ?? student.courseAccounts
      .map((account) => account.createdAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return Boolean(referenceAt && referenceAt.getTime() < threshold);
  }).length;
}

@Injectable()
export class InternalToolsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly reports?: ReportsService,
    @Optional() private readonly lessons?: LessonsService,
    @Optional() private readonly ledger?: CourseLedgerService,
    @Optional() private readonly students?: StudentsService,
    @Optional() private readonly teachers?: TeachersService,
    @Optional() private readonly courses?: CoursesService,
  ) {}

  private async requireOwner(subjectId: string, activity: string) {
    const user = await this.requireActiveUser(subjectId);
    if (user.role !== UserRole.OWNER) throw new ForbiddenException(`仅启用中的店主可查询${activity}`);
  }

  async periodPreclose(subjectId: string, input: { period: string }): Promise<InternalPrecloseRead> {
    await this.requireOwner(subjectId, '关账前检查');
    const periodStart = this.parsePeriod(input.period);
    const range = businessMonthRange(periodStart);
    const [pendingLessons, completedLessons, payrolls, refunds, ledgerEntries, closedPeriod] = await Promise.all([
      this.prisma.lesson.findMany({
        where: { status: LessonStatus.SCHEDULED, startsAt: { gte: range.start, lt: range.end }, endsAt: { lt: businessNow() } },
        orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
        select: { id: true, endsAt: true, account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } }, teacher: { select: { name: true } } },
      }),
      this.prisma.lesson.findMany({
        where: { status: LessonStatus.COMPLETED, completedAt: { gte: range.start, lt: range.end } },
        select: { teacherId: true, teacher: { select: { id: true, name: true } } },
      }),
      this.prisma.payroll.findMany({ where: { periodStart }, select: { id: true, teacherId: true, status: true, netSalary: true, teacher: { select: { name: true } } } }),
      this.prisma.refundRecord.findMany({
        where: { occurredAt: { gte: range.start, lt: range.end } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, totalPaidRefund: true, feeAmount: true, actualRefundAmount: true,
          student: { select: { name: true } },
          details: { select: { paidRefundAmount: true, ledgerEntries: { select: { kind: true, paidDelta: true } } } },
        },
      }),
      this.prisma.ledgerEntry.findMany({
        where: { occurredAt: { gte: range.start, lt: range.end } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, kind: true, paidDelta: true, giftDelta: true, lessonId: true, paymentId: true, giftId: true, refundDetailId: true,
          payment: { select: { amount: true } },
          gift: { select: { amount: true } },
          lesson: { select: { id: true, unitPriceSnapshot: true } },
          refundDetail: { select: { paidRefundAmount: true, giftClearingAmount: true } },
          reversesEntry: { select: { id: true, kind: true, lessonId: true, paidDelta: true, giftDelta: true, paymentId: true, giftId: true } },
          correctsEntry: { select: { id: true, kind: true, lessonId: true, paidDelta: true, giftDelta: true } },
        },
      }),
      this.prisma.closedPeriod.findUnique({ where: { periodStart }, select: { reopenedAt: true } }),
    ]);

    const refundsWithIssues = refunds.flatMap((refund) => {
      const detailTotal = refund.details.reduce((sum, detail) => sum.add(detail.paidRefundAmount), new Prisma.Decimal(0));
      const expectedActual = refund.totalPaidRefund.sub(refund.feeAmount);
      const actualLedgerTotal = refund.details.flatMap((detail) => detail.ledgerEntries)
        .filter((entry) => entry.kind === LedgerEntryKind.REFUND_PAID)
        .reduce((sum, entry) => sum.add(entry.paidDelta.negated()), new Prisma.Decimal(0));
      const issues: string[] = [];
      if (!detailTotal.eq(refund.totalPaidRefund)) issues.push('退款明细实收合计与退款记录不一致');
      if (!expectedActual.eq(refund.actualRefundAmount)) issues.push('实际退款金额与实收退费减手续费不一致');
      if (!actualLedgerTotal.eq(refund.totalPaidRefund)) issues.push('退款实收流水合计与退款记录不一致');
      return issues.map((issue) => ({ refundId: refund.id, studentName: refund.student.name, issue }));
    });
    const payrollTeacherIds = new Set(payrolls.map((payroll) => payroll.teacherId));
    const seenTeachers = new Set<string>();
    const missingPayrollTeachers = completedLessons.flatMap((lesson) => {
      if (payrollTeacherIds.has(lesson.teacherId) || seenTeachers.has(lesson.teacherId)) return [];
      seenTeachers.add(lesson.teacherId);
      return [{ teacherId: lesson.teacher.id, teacherName: lesson.teacher.name }];
    }).sort((left, right) => left.teacherName.localeCompare(right.teacherName, 'zh-CN') || left.teacherId.localeCompare(right.teacherId));
    const ledgerAnomalies: InternalPrecloseRead['ledgerAnomalies'] = [];
    for (const entry of ledgerEntries) {
      const issue = (() => {
        if (entry.kind === LedgerEntryKind.PAYMENT) {
          return !entry.payment || entry.paymentId === null || !entry.paidDelta.eq(entry.payment.amount) || !entry.giftDelta.isZero()
            ? '交费流水与交费记录不一致' : null;
        }
        if (entry.kind === LedgerEntryKind.GIFT) {
          return !entry.gift || entry.giftId === null || !entry.giftDelta.eq(entry.gift.amount) || !entry.paidDelta.isZero()
            ? '赠送流水与赠送记录不一致' : null;
        }
        if (entry.kind === LedgerEntryKind.PAYMENT_REVERSAL || entry.kind === LedgerEntryKind.GIFT_REVERSAL) {
          const expectedKind = entry.kind === LedgerEntryKind.PAYMENT_REVERSAL ? LedgerEntryKind.PAYMENT : LedgerEntryKind.GIFT;
          const original = entry.reversesEntry;
          return !original || original.kind !== expectedKind
            || !entry.paidDelta.eq(original.paidDelta.negated()) || !entry.giftDelta.eq(original.giftDelta.negated())
            ? '资金冲正未关联匹配原流水或金额不相反' : null;
        }
        if (entry.kind === LedgerEntryKind.LESSON_CONSUMPTION) {
          return !entry.lessonId || !entry.lesson || !entry.lesson.unitPriceSnapshot
            || !entry.paidDelta.add(entry.giftDelta).eq(entry.lesson.unitPriceSnapshot.negated())
            ? '课消流水未关联课程或金额与锁定单价不一致' : null;
        }
        if (entry.kind === LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL) {
          const original = entry.reversesEntry;
          return !original || original.kind !== LedgerEntryKind.LESSON_CONSUMPTION || !original.lessonId
            || !entry.paidDelta.eq(original.paidDelta.negated()) || !entry.giftDelta.eq(original.giftDelta.negated())
            ? '课消冲正未关联匹配原流水或金额不相反' : null;
        }
        if (entry.kind === LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION) {
          const original = entry.correctsEntry;
          const correctedAmount = entry.paidDelta.add(entry.giftDelta).negated();
          return !original || original.kind !== LedgerEntryKind.LESSON_CONSUMPTION || !original.lessonId
            || !correctedAmount.gt(0)
            ? '课消纠正未关联匹配原流水或金额不合法' : null;
        }
        if (entry.kind === LedgerEntryKind.REFUND_PAID || entry.kind === LedgerEntryKind.REFUND_GIFT_CLEARING) {
          if (!entry.refundDetail || entry.refundDetailId === null) return '退款流水未关联退款明细';
          return entry.kind === LedgerEntryKind.REFUND_PAID
            ? (!entry.paidDelta.eq(entry.refundDetail.paidRefundAmount.negated()) || !entry.giftDelta.isZero() ? '退款实收流水与退款明细不一致' : null)
            : (!entry.giftDelta.eq(entry.refundDetail.giftClearingAmount.negated()) || !entry.paidDelta.isZero() ? '赠送清零流水与退款明细不一致' : null);
        }
        return null;
      })();
      if (issue) ledgerAnomalies.push({ entryId: entry.id, kind: entry.kind, issue });
    }
    const unpaidPayrolls = payrolls.filter((payroll) => payroll.status === 'UNPAID').map((payroll) => ({ payrollId: payroll.id, teacherId: payroll.teacherId, teacherName: payroll.teacher.name, netSalary: payroll.netSalary.toFixed(2) }));
    const blockers: InternalPrecloseRead['blockers'] = [];
    if (pendingLessons.length > 0) blockers.push({ code: 'PENDING_LESSONS', count: pendingLessons.length, message: `有 ${pendingLessons.length} 节已结束但未确认的课程` });
    if (missingPayrollTeachers.length > 0) blockers.push({ code: 'MISSING_PAYROLL', count: missingPayrollTeachers.length, message: `有 ${missingPayrollTeachers.length} 位教师尚未生成工资` });
    if (unpaidPayrolls.length > 0) blockers.push({ code: 'UNPAID_PAYROLL', count: unpaidPayrolls.length, message: `有 ${unpaidPayrolls.length} 笔工资尚未支付` });
    if (refundsWithIssues.length > 0) blockers.push({ code: 'REFUND_ANOMALY', count: refundsWithIssues.length, message: `有 ${refundsWithIssues.length} 项退款数据异常` });
    if (ledgerAnomalies.length > 0) blockers.push({ code: 'LEDGER_ANOMALY', count: ledgerAnomalies.length, message: `有 ${ledgerAnomalies.length} 项账户流水异常` });
    return {
      period: input.period,
      closed: Boolean(closedPeriod && !closedPeriod.reopenedAt),
      pendingLessons: pendingLessons.map((lesson) => ({
        lessonId: lesson.id, studentName: lesson.account.student.name, courseName: lesson.account.course.name,
        teacherName: lesson.teacher.name, endsAt: lesson.endsAt.toISOString(),
      })),
      refundAnomalies: refundsWithIssues,
      missingPayrollTeachers,
      unpaidPayrolls,
      ledgerAnomalies,
      blockers,
      reminders: [{ code: 'CLOSING_SEVERITY_UNSPECIFIED', message: '关账异常的阻断与提示等级尚未定义，请由店主逐项判断。', requiresHumanJudgment: true }],
    };
  }

  async directory(subjectId: string): Promise<InternalDirectoryRead> {
    await this.requireOwner(subjectId, '基础资料');
    if (!this.students || !this.teachers || !this.courses) throw new Error('基础资料服务未配置');
    const [students, teachers, courses] = await Promise.all([
      this.students.list(), this.teachers.list(), this.courses.list(),
    ]);
    return {
      students: students.map(({ id, name, enrollmentStatus }) => ({ studentId: id, name, enrollmentStatus })),
      teachers: teachers.map(({ id, name, isActive }) => ({ teacherId: id, name, isActive })),
      courses: courses.map(({ id, name, defaultUnitPrice, defaultDurationMinutes, isActive }) => ({ courseId: id, name, defaultUnitPrice, defaultDurationMinutes, isActive })),
    };
  }

  async arrearsAndFrozen(subjectId: string): Promise<InternalArrearsAndFrozenRead> {
    await this.requireOwner(subjectId, '欠费和冻结名单');
    if (!this.ledger || !this.students) throw new Error('课程账户或学生服务未配置');
    const [accounts, students] = await Promise.all([
      this.prisma.studentCourseAccount.findMany({
        where: { student: { withdrawnAt: null } },
        orderBy: [{ student: { name: 'asc' } }, { course: { name: 'asc' } }, { id: 'asc' }],
        select: {
          id: true,
          student: { select: { id: true, name: true, withdrawnAt: true } },
          course: { select: { id: true, name: true } },
        },
      }),
      this.students.list(),
    ]);
    const eligibleAccounts = accounts.filter((account) => !account.student.withdrawnAt);
    const balances = await Promise.all(eligibleAccounts.map((account) => this.ledger!.getBalance(account.id)));
    const arrears = eligibleAccounts.flatMap((account, index) => {
      const balance = balances[index]!;
      if (!new Prisma.Decimal(balance.paidBalance).isNegative()) return [];
      return [{ studentId: account.student.id, studentName: account.student.name, courseId: account.course.id, courseName: account.course.name, paidBalance: balance.paidBalance }];
    });
    return {
      arrears,
      frozenStudents: students
        .filter((student) => student.enrollmentStatus === 'FROZEN')
        .map(({ id, name }) => ({ studentId: id, name, reason: '连续31天未完成课程' })),
    };
  }

  async monthlyConsumption(subjectId: string, input: { period: string }): Promise<InternalMonthlyConsumptionRead> {
    await this.requireOwner(subjectId, '月度课消');
    const periodStart = this.parsePeriod(input.period);
    const range = businessMonthRange(periodStart);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        kind: { in: [LedgerEntryKind.LESSON_CONSUMPTION, LedgerEntryKind.LESSON_CONSUMPTION_REVERSAL, LedgerEntryKind.LESSON_CONSUMPTION_CORRECTION] },
        occurredAt: { gte: range.start, lt: range.end },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        kind: true, paidDelta: true, giftDelta: true,
        account: { select: { student: { select: { id: true, name: true } }, course: { select: { id: true, name: true } } } },
        lesson: { select: { teacher: { select: { id: true, name: true } } } },
        reversesEntry: { select: { lesson: { select: { teacher: { select: { id: true, name: true } } } } } },
        correctsEntry: { select: { lesson: { select: { teacher: { select: { id: true, name: true } } } } } },
      },
    });
    const grouped = {
      courses: new Map<string, { name: string; amount: Prisma.Decimal }>(),
      teachers: new Map<string, { name: string; amount: Prisma.Decimal }>(),
      students: new Map<string, { name: string; amount: Prisma.Decimal }>(),
    };
    for (const entry of entries) {
      const amount = entry.paidDelta.add(entry.giftDelta).negated();
      const teacher = entry.lesson?.teacher ?? entry.reversesEntry?.lesson?.teacher ?? entry.correctsEntry?.lesson?.teacher;
      const dimensions = [
        ['courses', entry.account.course] as const,
        ['teachers', teacher] as const,
        ['students', entry.account.student] as const,
      ];
      for (const [dimension, value] of dimensions) {
        if (!value) continue;
        const current = grouped[dimension].get(value.id);
        grouped[dimension].set(value.id, { name: value.name, amount: (current?.amount ?? new Prisma.Decimal(0)).add(amount) });
      }
    }
    const project = (values: Map<string, { name: string; amount: Prisma.Decimal }>): InternalConsumptionGroup =>
      [...values.entries()].sort(([leftId, left], [rightId, right]) => left.name.localeCompare(right.name, 'zh-CN') || leftId.localeCompare(rightId))
        .map(([id, value]) => ({ id, name: value.name, amount: value.amount.toFixed(2) }));
    const lessonTotal = entries.reduce((total, entry) => total.add(entry.paidDelta.add(entry.giftDelta).negated()), new Prisma.Decimal(0));
    return { period: input.period, totalAmount: lessonTotal.toFixed(2), courses: project(grouped.courses), teachers: project(grouped.teachers), students: project(grouped.students) };
  }

  private async requireActiveUser(subjectId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { id: true, role: true, isActive: true, teacher: { select: { id: true, isActive: true } } },
    });
    if (!user?.isActive) throw new ForbiddenException('Capability 用户不可用');
    return user;
  }

  private parsePeriod(period: string): Date {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
    if (!match) throw new BadRequestException('月份格式不合法');
    const start = new Date(0);
    start.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, 1);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }

  async monthlyReport(subjectId: string, input: { period: string }): Promise<InternalMonthlyReportRead> {
    const user = await this.requireActiveUser(subjectId);
    if (user.role !== UserRole.OWNER) throw new ForbiddenException('仅启用中的店主可查询月报');
    const periodStart = this.parsePeriod(input.period);
    if (!this.reports) throw new Error('ReportsService 未配置');
    const report = await this.reports.monthly(periodStart);
    const operatingIncome = new Prisma.Decimal(report.lessonIncome).add(report.refundFeeIncome).add(report.manualIncome);
    const cashOperatingGap = new Prisma.Decimal(report.operatingProfit).sub(report.cashNet);
    return { period: input.period, report: { ...report, operatingIncome: operatingIncome.toFixed(2), cashOperatingGap: cashOperatingGap.toFixed(2) } };
  }

  async courseAccountLedger(
    subjectId: string,
    input: { accountId: string },
  ): Promise<InternalCourseAccountLedgerRead> {
    const user = await this.requireActiveUser(subjectId);
    if (user.role !== UserRole.OWNER) throw new ForbiddenException('仅启用中的店主可查询课程账户流水');
    const account = await this.prisma.studentCourseAccount.findUnique({ where: { id: input.accountId }, select: { id: true } });
    if (!account) throw new NotFoundException('学生课程账户不存在');
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, occurredAt: true, kind: true, paidDelta: true, giftDelta: true, note: true,
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

  async monthlyPayroll(subjectId: string, input: { period: string }): Promise<InternalMonthlyPayrollRead> {
    const user = await this.requireActiveUser(subjectId);
    const periodStart = this.parsePeriod(input.period);
    let teacherId: string | undefined;
    if (user.role === UserRole.TEACHER) {
      if (!user.teacher?.isActive || !user.teacher.id) throw new ForbiddenException('老师账号未关联启用中的教师资料');
      teacherId = user.teacher.id;
    } else if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException('Capability 用户角色不可用');
    }
    const payrolls = await this.prisma.payroll.findMany({
      where: { periodStart, ...(teacherId ? { teacherId } : {}) },
      orderBy: [{ teacher: { name: 'asc' } }, { id: 'asc' }],
      select: {
        id: true, teacherId: true, courseRevenue: true, baseSalary: true, commissionRate: true,
        commissionAmount: true, bonusAmount: true, bonusNote: true, deductionAmount: true,
        deductionNote: true, grossSalary: true, netSalary: true, status: true,
        teacher: { select: { name: true } },
      },
    });
    return {
      period: input.period,
      payrolls: payrolls.map((payroll) => ({
        payrollId: payroll.id,
        teacherId: payroll.teacherId,
        teacherName: payroll.teacher.name,
        courseRevenue: payroll.courseRevenue.toFixed(2),
        baseSalary: payroll.baseSalary.toFixed(2),
        commissionRate: payroll.commissionRate.toFixed(4),
        commissionAmount: payroll.commissionAmount.toFixed(2),
        bonusAmount: payroll.bonusAmount.toFixed(2),
        bonusNote: payroll.bonusNote,
        deductionAmount: payroll.deductionAmount.toFixed(2),
        deductionNote: payroll.deductionNote,
        grossSalary: payroll.grossSalary.toFixed(2),
        netSalary: payroll.netSalary.toFixed(2),
        status: payroll.status,
      })),
    };
  }

  async listLessons(subjectId: string, input: InternalLessonsQuery): Promise<InternalLessonsRead> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: {
        id: true,
        role: true,
        isActive: true,
        teacher: { select: { id: true, name: true, isActive: true } },
      },
    });
    if (!user?.isActive || ![UserRole.OWNER, UserRole.TEACHER].includes(user.role)) {
      throw new ForbiddenException('Capability 用户角色不可用');
    }
    if (user.role === UserRole.TEACHER && (!user.teacher?.isActive || !user.teacher.id)) {
      throw new ForbiddenException('老师账号未关联启用中的教师资料');
    }

    const startsAt = parseBusinessDate(input.dateFrom);
    const endsAt = parseBusinessDate(nextDate(input.dateTo));
    if (startsAt >= endsAt) throw new BadRequestException('日期范围不合法');
    if (!this.lessons) throw new Error('LessonsService 未配置');

    const actor: AuthenticatedActor = {
      id: user.id,
      username: '',
      role: user.role,
      ...(user.teacher ? { teacherId: user.teacher.id } : {}),
    };
    const filters: LessonReadFilters = {
      startsAt,
      endsAt,
      studentName: input.studentName,
      courseName: input.courseName,
      teacherName: input.teacherName,
      status: input.status ?? (input.statusText ? LESSON_STATUS_BY_TEXT[input.statusText] : undefined),
    };
    const lessons = await this.lessons.listForActorInRange(actor, filters);
    return {
      businessDate: input.dateFrom,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      lessons: lessons.map((lesson) => ({
        lessonId: lesson.id,
        accountId: lesson.accountId,
        teacherId: lesson.teacherId,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        studentName: lesson.student.name,
        courseName: lesson.course.name,
        teacherName: lesson.teacher.name,
        statusLabel: LESSON_STATUS_LABELS[lesson.status],
        status: lesson.status,
      })),
    };
  }

  async courseAccount(
    subjectId: string,
    input: { accountId: string },
  ): Promise<CourseAccountRead> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true },
    });
    if (!user?.isActive || user.role !== UserRole.OWNER) {
      throw new ForbiddenException('仅启用中的店主可查询课程账户余额');
    }
    if (!this.ledger) throw new Error('CourseLedgerService 未配置');

    const account = await this.prisma.studentCourseAccount.findUnique({
      where: { id: input.accountId },
      select: {
        id: true,
        currentUnitPrice: true,
        version: true,
        student: { select: { name: true } },
        course: { select: { name: true } },
      },
    });
    if (!account) throw new NotFoundException('学生课程账户不存在');

    const balance = await this.ledger.getBalance(account.id);
    return {
      accountId: account.id,
      version: account.version,
      studentName: account.student.name,
      courseName: account.course.name,
      currentUnitPrice: account.currentUnitPrice.toFixed(2),
      paidBalance: balance.paidBalance,
      giftBalance: balance.giftBalance,
      totalBalance: balance.totalBalance,
    };
  }

  async teacherCandidates(
    subjectId: string,
    input: { teacherName: string; match?: CandidateMatch | undefined },
  ): Promise<{ candidates: TeacherCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: {
        id: true,
        role: true,
        isActive: true,
        teacher: { select: { id: true, name: true, isActive: true } },
      },
    });
    if (!user?.isActive) throw new ForbiddenException('Capability 用户不可用');

    if (user.role === UserRole.TEACHER) {
      const teacher = user.teacher;
      if (!teacher?.isActive) throw new ForbiddenException('老师账号未关联启用中的教师资料');
      if (input.match === 'search') {
        const teachers = await this.prisma.teacher.findMany({
          where: { id: teacher.id, name: candidateNameWhere(input.teacherName, input.match), isActive: true },
          orderBy: { id: 'asc' },
          select: { id: true, name: true },
        });
        const preferred = preferExactCandidates(teachers, input.teacherName, (candidate) => candidate.name);
        return { candidates: preferred.map((candidate) => ({ teacherId: candidate.id, name: candidate.name })) };
      }
      return {
        candidates: teacher.name === input.teacherName
          ? [{ teacherId: teacher.id, name: teacher.name }]
          : [],
      };
    }

    if (user.role !== UserRole.OWNER) throw new ForbiddenException('Capability 用户角色不可用');
    const teachers = await this.prisma.teacher.findMany({
      where: { name: candidateNameWhere(input.teacherName, input.match), isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    const preferred = preferExactCandidates(teachers, input.teacherName, (candidate) => candidate.name);
    return {
      candidates: preferred.map((teacher) => ({ teacherId: teacher.id, name: teacher.name })),
    };
  }

  async courseAccountCandidates(
    subjectId: string,
    input: { studentName: string; courseName?: string | undefined; match?: CandidateMatch | undefined },
  ): Promise<{ candidates: CourseAccountCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true },
    });
    if (!user?.isActive || user.role !== UserRole.OWNER) {
      throw new ForbiddenException('仅启用中的店主账号可查询课程账户候选');
    }

    const accounts = await this.prisma.studentCourseAccount.findMany({
      where: {
        student: { name: candidateNameWhere(input.studentName, input.match) },
        ...(input.courseName ? { course: { name: input.courseName } } : {}),
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        student: { select: { name: true } },
        course: { select: { name: true } },
      },
    });
    const preferred = preferExactCandidates(accounts, input.studentName, (account) => account.student.name);

    return {
      candidates: preferred.map((account) => ({
        accountId: account.id,
        studentName: account.student.name,
        courseName: account.course.name,
      })),
    };
  }

  async studentCandidates(
    subjectId: string,
    input: { studentName: string; match?: CandidateMatch | undefined },
  ): Promise<{ candidates: StudentCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true },
    });
    if (!user?.isActive || user.role !== UserRole.OWNER) {
      throw new ForbiddenException('仅启用中的店主账号可查询学生候选');
    }
    const students = await this.prisma.student.findMany({
      where: { name: candidateNameWhere(input.studentName, input.match) },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    const preferred = preferExactCandidates(students, input.studentName, (student) => student.name);
    return { candidates: preferred.map((student) => ({ studentId: student.id, name: student.name })) };
  }

  async lessonCandidates(
    subjectId: string,
    input: { studentName: string; date?: string | undefined; match?: CandidateMatch | undefined },
  ): Promise<{ candidates: LessonCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true, teacher: { select: { id: true, isActive: true } } },
    });
    if (!user?.isActive || ![UserRole.OWNER, UserRole.TEACHER].includes(user.role)) {
      throw new ForbiddenException('Capability 用户角色不可用');
    }
    const where = {
      account: { student: { name: candidateNameWhere(input.studentName.trim(), input.match) } },
      ...(input.date ? {
        startsAt: {
          gte: new Date(`${input.date}T00:00:00+08:00`),
          lt: new Date(new Date(`${input.date}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000),
        },
      } : {}),
      ...(user.role === UserRole.TEACHER ? { teacherId: user.teacher?.id ?? '__none__' } : {}),
    };
    const lessons = await this.prisma.lesson.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, startsAt: true, status: true,
        account: { select: { student: { select: { name: true } }, course: { select: { name: true } } } },
        teacher: { select: { name: true } },
      },
    });
    const preferred = preferExactCandidates(lessons, input.studentName.trim(), (lesson) => lesson.account.student.name);
    return { candidates: preferred.map((lesson) => ({
      lessonId: lesson.id,
      studentName: lesson.account.student.name,
      courseName: lesson.account.course.name,
      teacherName: lesson.teacher.name,
      startsAt: lesson.startsAt,
      status: lesson.status,
    })) };
  }

  async payrollCandidates(
    subjectId: string,
    input: { teacherName: string; period: string },
  ): Promise<{ candidates: PayrollCandidate[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: subjectId }, select: { role: true, isActive: true } });
    if (!user?.isActive || user.role !== UserRole.OWNER) throw new ForbiddenException('仅启用中的店主可查询工资候选');
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(input.period);
    if (!match) throw new BadRequestException('工资月份格式不合法');
    const periodStart = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    const payrolls = await this.prisma.payroll.findMany({
      where: { periodStart, teacher: { name: input.teacherName.trim() } },
      orderBy: [{ teacher: { name: 'asc' } }, { id: 'asc' }],
      select: { id: true, teacherId: true, periodStart: true, status: true, teacher: { select: { name: true } } },
    });
    return { candidates: payrolls.map((payroll) => ({
      payrollId: payroll.id, teacherId: payroll.teacherId, teacherName: payroll.teacher.name,
      period: input.period, status: payroll.status,
    })) };
  }

  async dashboardSummary(subjectId: string, now = businessNow()): Promise<DashboardSummary> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { id: true, role: true, isActive: true, teacher: { select: { id: true } } },
    });
    if (!user?.isActive) throw new ForbiddenException('Capability 用户不可用');

    const { date, year, month } = businessDateParts(now);
    const dayStart = shanghaiMidnight(date);
    const dayEnd = shanghaiMidnight(nextDate(date));

    if (user.role === UserRole.TEACHER) {
      if (!user.teacher) throw new ForbiddenException('老师账号未关联教师资料');
      const whereToday = {
        teacherId: user.teacher.id,
        status: LessonStatus.SCHEDULED,
        startsAt: { gte: dayStart, lt: dayEnd },
      };
      const [todayScheduledCount, futureScheduledCount, todayLessonRows] = await Promise.all([
        this.prisma.lesson.count({ where: whereToday }),
        this.prisma.lesson.count({
          where: {
            teacherId: user.teacher.id,
            status: LessonStatus.SCHEDULED,
            startsAt: { gte: dayEnd },
          },
        }),
        this.prisma.lesson.findMany({ where: whereToday, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], select: TODAY_LESSON_SELECT }),
      ]);
      return {
        role: 'TEACHER',
        businessDate: date,
        todayScheduledCount,
        todayLessonItems: toTodayLessonItems(todayLessonRows),
        futureScheduledCount,
        highlights: [`今日排课 ${todayScheduledCount} 节`, `后续排课 ${futureScheduledCount} 节`],
      };
    }

    if (user.role !== UserRole.OWNER) throw new ForbiddenException('Capability 用户角色不可用');
    const [lessonGroups, todayLessonRows, students, accounts, unpaidPayrollCount, monthlyReport] = await Promise.all([
      this.prisma.lesson.groupBy({
        by: ['status'],
        where: { startsAt: { gte: dayStart, lt: dayEnd } },
        _count: { _all: true },
      }),
      this.prisma.lesson.findMany({
        where: { startsAt: { gte: dayStart, lt: dayEnd } },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], select: TODAY_LESSON_SELECT,
      }),
      this.prisma.student.findMany({
        select: {
          withdrawnAt: true,
          courseAccounts: {
            select: {
              createdAt: true,
              lessons: { where: { status: LessonStatus.COMPLETED }, select: { completedAt: true } },
            },
          },
        },
      }),
      this.prisma.studentCourseAccount.findMany({
        select: { studentId: true, openingPaidBalance: true, ledgerEntries: { select: { paidDelta: true } } },
      }),
      this.prisma.payroll.count({
        where: { status: PayrollStatus.UNPAID, periodStart: monthStart(year, month) },
      }),
      this.reports?.monthly(new Date(Date.UTC(year, month - 1, 1))),
    ]);

    const counts = new Map(lessonGroups.map((group) => [group.status, group._count._all]));
    const studentsWithNegativeBalance = new Set<string>();
    for (const account of accounts) {
      const balance = account.ledgerEntries.reduce(
        (total, entry) => total.add(entry.paidDelta),
        account.openingPaidBalance,
      );
      if (balance.lt(0)) studentsWithNegativeBalance.add(account.studentId);
    }

    const scheduled = counts.get(LessonStatus.SCHEDULED) ?? 0;
    const completed = counts.get(LessonStatus.COMPLETED) ?? 0;
    const cancelled = counts.get(LessonStatus.CANCELLED) ?? 0;
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const monthlyOperatingIncome = monthlyReport
      ? new Prisma.Decimal(monthlyReport.lessonIncome).add(monthlyReport.refundFeeIncome).add(monthlyReport.manualIncome).toFixed(2)
      : undefined;
    const frozenStudentCount = countFrozenStudents(students, now);
    const studentsWithNegativeBalanceCount = studentsWithNegativeBalance.size;
    const todayEndedUnconfirmedCount = todayLessonRows.filter((lesson) => lesson.status === LessonStatus.SCHEDULED && lesson.endsAt <= now).length;
    return {
      role: 'OWNER',
      businessDate: date,
      period,
      todayLessons: { total: scheduled + completed + cancelled, scheduled, completed, cancelled },
      todayEndedUnconfirmedCount,
      todayLessonItems: toTodayLessonItems(todayLessonRows),
      monthlyOperatingIncome: monthlyOperatingIncome ?? null,
      frozenStudentCount,
      studentsWithNegativeBalanceCount,
      unpaidPayrollCount,
      highlights: [
        `今日课程 ${scheduled + completed + cancelled} 节（待上 ${scheduled}、已完成 ${completed}、已取消 ${cancelled}）`,
        `已结束未确认课程 ${todayEndedUnconfirmedCount} 节`,
        `冻结学生 ${frozenStudentCount} 人`,
        `欠费学生 ${studentsWithNegativeBalanceCount} 人（按课程实收负余额）`,
        `${period} 待支付工资 ${unpaidPayrollCount} 笔`,
        ...(monthlyOperatingIncome ? [`${period} 经营收入 ${monthlyOperatingIncome} 元`] : []),
      ],
    };
  }
}
