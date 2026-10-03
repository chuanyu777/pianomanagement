import { money, multiplyMoney, sumMoney, ZERO, type Money } from '../../common/money.js';
import { lastPeriods, periodRange, prevPeriod, type Period } from '../../common/period.js';
import { LessonStatus } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * 工资计算。**业绩与课消奖一律实时汇总，不落库。**
 *
 * 为什么工资表只存人工录入的部分（出勤、基本工资、钢琴奖、招生奖、代扣），
 * 而不存业绩和课消奖：需求 US-PR-03 要的是「业绩与上课确认一致、不手工抄」。
 * 一旦把业绩存一份，改价、取消课、回冲之后就会出现
 * 「工资表的业绩」和「台账里的消费」对不上，而且没有任何报错。
 */

export type PayrollComputation = {
  teacherId: string;
  teacherName: string;
  teacherStatus: string;
  attendanceExpected: number;
  attendanceActual: number;
  attendanceAbsent: number;
  baseSalary: Money;
  pianoBonus: Money;
  recruitBonus: Money;
  /** 业绩 = 该老师当月「已确认」且「非赠送」课的单价快照合计 */
  performance: Money;
  commissionRate: Money;
  /** 课消奖 = 业绩 × 比例 */
  commission: Money;
  /** 应发综合工资 */
  grossSalary: Money;
  deductions: { deductionItemId: string; name: string; amount: Money }[];
  totalDeduction: Money;
  /** 实发工资 */
  netSalary: Money;
  /** 当月已确认课时数（含赠送课 —— 出勤口径，不影响业绩） */
  confirmedLessonCount: number;
};

/** 只需要这两个 model，事务客户端也满足。 */
export type PayrollTotalsPrisma = Pick<
  PrismaService,
  'teacher' | 'lesson' | 'payroll' | 'organization'
>;

export async function computeTeacherPerformance(
  prisma: PayrollTotalsPrisma,
  teacherId: string,
  period: Period,
): Promise<{ amount: Money; lessonCount: number }> {
  const { start, end } = periodRange(period);

  const [confirmed, nonGiftAgg] = await Promise.all([
    prisma.lesson.count({
      where: {
        teacherId,
        status: LessonStatus.CONFIRMED,
        confirmedAt: { gte: start, lt: end },
      },
    }),
    prisma.lesson.aggregate({
      where: {
        teacherId,
        status: LessonStatus.CONFIRMED,
        isGift: false,
        confirmedAt: { gte: start, lt: end },
      },
      _sum: { unitPriceSnapshot: true },
      _count: { _all: true },
    }),
  ]);

  return {
    amount: money(nonGiftAgg._sum.unitPriceSnapshot),
    lessonCount: confirmed,
  };
}

export async function computePayrollForTeacher(
  prisma: PayrollTotalsPrisma,
  teacherId: string,
  period: Period,
): Promise<PayrollComputation | null> {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher) return null;

  const [payroll, performance] = await Promise.all([
    prisma.payroll.findUnique({
      where: { teacherId_period: { teacherId, period } },
      include: { deductions: { include: { deductionItem: true } } },
    }),
    computeTeacherPerformance(prisma, teacherId, period),
  ]);

  const organization = await prisma.organization.findFirst();

  const baseSalary = money(payroll?.baseSalary);
  const pianoBonus = money(payroll?.pianoBonus);
  const recruitBonus = money(payroll?.recruitBonus);

  // 比例优先级：工资表逐月覆盖 → 老师档案默认 → 机构默认
  const commissionRate = money(
    payroll?.commissionRate ?? teacher.commissionRate ?? organization?.defaultCommissionRate,
  );
  const commission = multiplyMoney(performance.amount, commissionRate);
  const grossSalary = sumMoney([baseSalary, pianoBonus, recruitBonus, commission]);

  const deductions = (payroll?.deductions ?? [])
    .map((row) => ({
      deductionItemId: row.deductionItemId,
      name: row.deductionItem.name,
      amount: money(row.amount),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const totalDeduction = sumMoney(deductions.map((row) => row.amount));

  return {
    teacherId: teacher.id,
    teacherName: teacher.name,
    teacherStatus: teacher.status,
    attendanceExpected: payroll?.attendanceExpected ?? 0,
    attendanceActual: payroll?.attendanceActual ?? 0,
    attendanceAbsent: payroll?.attendanceAbsent ?? 0,
    baseSalary,
    pianoBonus,
    recruitBonus,
    performance: performance.amount,
    commissionRate,
    commission,
    grossSalary,
    deductions,
    totalDeduction,
    netSalary: grossSalary.minus(totalDeduction),
    confirmedLessonCount: performance.lessonCount,
  };
}

/** 某月全部在职老师的工资明细（工资表 US-PR-01 用它）。 */
export async function computePayrollSheet(
  prisma: PayrollTotalsPrisma,
  period: Period,
): Promise<PayrollComputation[]> {
  const teachers = await prisma.teacher.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
    select: { id: true },
  });

  const rows = await Promise.all(
    teachers.map((teacher) => computePayrollForTeacher(prisma, teacher.id, period)),
  );
  return rows.filter((row): row is PayrollComputation => row !== null);
}

/**
 * 工资的两个口径（US-PR-05）。
 *
 * accruedTotal = 本月应发合计（经营支出口径）
 * cashTotal    = 本月实际要发出去的钱 = **上月应发合计**（现金支出口径）
 *
 * 首月没有上期数据：这时如果按「上月应发 = 0」算，整张首月报表的现金支出会变成 0，
 * 而这恰恰是需求 US-IW-02 明确要避免的。所以首月回落到初始化时手工录入的
 * `Organization.previousMonthPayroll`。
 * 「首月」的判定：上一个月既没有任何工资记录、也没有任何已确认课。
 */
export async function computePeriodTotals(
  prisma: PayrollTotalsPrisma,
  period: Period,
): Promise<{ accruedTotal: Money; cashTotal: Money }> {
  const accruedTotal = sumMoney(
    (await computePayrollSheet(prisma, period)).map((row) => row.grossSalary),
  );

  const previous = prevPeriod(period);
  const { start, end } = periodRange(previous);
  const [previousPayrollCount, previousLessonCount, organization] = await Promise.all([
    prisma.payroll.count({ where: { period: previous } }),
    prisma.lesson.count({
      where: { status: LessonStatus.CONFIRMED, confirmedAt: { gte: start, lt: end } },
    }),
    prisma.organization.findFirst({ select: { previousMonthPayroll: true } }),
  ]);

  const hasPreviousData = previousPayrollCount > 0 || previousLessonCount > 0;
  const cashTotal = hasPreviousData
    ? sumMoney((await computePayrollSheet(prisma, previous)).map((row) => row.grossSalary))
    : money(organization?.previousMonthPayroll);

  return { accruedTotal, cashTotal };
}

/** 近 N 个月每个月应发合计，趋势图用。 */
export async function computePayrollTrend(
  prisma: PayrollTotalsPrisma,
  endPeriod: Period,
  months: number,
): Promise<{ period: Period; accruedTotal: Money }[]> {
  const periods = lastPeriods(endPeriod, months);
  return Promise.all(
    periods.map(async (period) => ({
      period,
      accruedTotal: (await computePeriodTotals(prisma, period)).accruedTotal ?? ZERO,
    })),
  );
}
