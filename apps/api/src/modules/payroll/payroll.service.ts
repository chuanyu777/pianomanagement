import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { money, sumMoney, toMoneyString, type Money } from '../../common/money.js';
import { prevPeriod, type Period } from '../../common/period.js';
import { Prisma, UserRole } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { UpsertPayrollDto } from './dto/upsert-payroll.dto.js';
import {
  computePayrollForTeacher,
  computePayrollSheet,
  computePeriodTotals as computePeriodTotalsForPrisma,
  type PayrollComputation,
} from './payroll-totals.js';

/**
 * 趋势（供总览用）。`payroll-totals.ts` 里已有权威实现，这里只转出，
 * 不重写 —— 趋势与两口径必须共用同一套汇总逻辑。
 */
export { computePayrollTrend } from './payroll-totals.js';

/**
 * 工资表的「可选列」（US-PR-04）。
 *
 * 需求说这些列默认关闭、可在设置中开启。**不需要为此建表**：
 * 它是一份静态的列定义，前端拿它渲染「列开关」，开关状态由前端本地保存即可。
 * 一旦建表并落库，就多出一份「哪些列可选」的第二实现，改一处忘一处就会漂移。
 */
export const OPTIONAL_PAYROLL_COLUMNS = [
  { key: 'baseSalary', label: '应发基础工资', defaultEnabled: false },
  { key: 'pianoBonus', label: '钢琴', defaultEnabled: false },
] as const;

export type OptionalPayrollColumn = {
  key: string;
  label: string;
  defaultEnabled: boolean;
};

export type SerializedDeduction = {
  deductionItemId: string;
  name: string;
  amount: string;
};

/** 工资表的一行。金额一律序列化成两位小数字符串，不让 Decimal 漏到前端。 */
export type PayrollRow = {
  teacherId: string;
  teacherName: string;
  teacherStatus: string;
  attendance: { expected: number; actual: number; absent: number };
  baseSalary: string;
  pianoBonus: string;
  recruitBonus: string;
  performance: string;
  commissionRate: string;
  commission: string;
  grossSalary: string;
  deductions: SerializedDeduction[];
  totalDeduction: string;
  netSalary: string;
  confirmedLessonCount: number;
};

export type PayrollSheet = {
  period: Period;
  rows: PayrollRow[];
  totals: {
    grossTotal: string;
    netTotal: string;
    performanceTotal: string;
    totalDeduction: string;
  };
};

export type RecomputeResult = {
  period: Period;
  recomputed: true;
  performanceTotal: string;
  lessonCount: number;
};

export type MyPayroll = PayrollRow & { period: Period };

export type PeriodTotalsResult = {
  period: Period;
  accruedTotal: string;
  cashTotal: string;
  previousPeriod: Period;
};

/** 只包含「传了的」字段，用于 upsert 的 update —— 未传字段必须保持原值。 */
type PayrollEntryFields = {
  attendanceExpected?: number;
  attendanceActual?: number;
  attendanceAbsent?: number;
  baseSalary?: Prisma.Decimal;
  pianoBonus?: Prisma.Decimal;
  recruitBonus?: Prisma.Decimal;
  commissionRate?: Prisma.Decimal;
  note?: string | null;
};

function serializeRow(row: PayrollComputation): PayrollRow {
  return {
    teacherId: row.teacherId,
    teacherName: row.teacherName,
    teacherStatus: row.teacherStatus,
    attendance: {
      expected: row.attendanceExpected,
      actual: row.attendanceActual,
      absent: row.attendanceAbsent,
    },
    baseSalary: toMoneyString(row.baseSalary),
    pianoBonus: toMoneyString(row.pianoBonus),
    recruitBonus: toMoneyString(row.recruitBonus),
    performance: toMoneyString(row.performance),
    commissionRate: toMoneyString(row.commissionRate),
    commission: toMoneyString(row.commission),
    grossSalary: toMoneyString(row.grossSalary),
    deductions: row.deductions.map((deduction) => ({
      deductionItemId: deduction.deductionItemId,
      name: deduction.name,
      amount: toMoneyString(deduction.amount),
    })),
    totalDeduction: toMoneyString(row.totalDeduction),
    netSalary: toMoneyString(row.netSalary),
    confirmedLessonCount: row.confirmedLessonCount,
  };
}

/**
 * 工资模块（US-PR-01 … US-PR-07）。
 *
 * 口径全部来自 `payroll-totals.ts`（已冻结的权威实现）：
 * 业绩与课消奖实时汇总、不落库；本 service 只负责编排、事务、权限与序列化。
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  /** US-PR-01：在职老师整表 + 底部合计。 */
  async getSheet(period: Period): Promise<PayrollSheet> {
    const rows = await computePayrollSheet(this.prisma, period);
    return {
      period,
      rows: rows.map(serializeRow),
      totals: {
        grossTotal: toMoneyString(sumMoney(rows.map((row) => row.grossSalary))),
        netTotal: toMoneyString(sumMoney(rows.map((row) => row.netSalary))),
        performanceTotal: toMoneyString(sumMoney(rows.map((row) => row.performance))),
        totalDeduction: toMoneyString(sumMoney(rows.map((row) => row.totalDeduction))),
      },
    };
  }

  /**
   * US-PR-03「按课时重算业绩」。
   *
   * **为什么不需要写库**：业绩与课消奖本来就是每次查询时从「已确认课」实时汇总出来的
   *（见 `payroll-totals.ts`），`Payroll` 表只存人工录入的基础项、出勤与代扣。
   * 所以「重算」本质就是把同一套汇总再跑一遍：对数据零副作用、重复调用结果恒定，
   * 天然幂等。若把业绩写回 `Payroll`，改价 / 取消课 / 回冲之后工资表的业绩就会
   * 和台账里的消费对不上，而且不报错 —— 那正是 US-PR-03 要避免的。
   */
  async recompute(period: Period): Promise<RecomputeResult> {
    const rows = await computePayrollSheet(this.prisma, period);
    return {
      period,
      recomputed: true,
      performanceTotal: toMoneyString(sumMoney(rows.map((row) => row.performance))),
      lessonCount: rows.reduce((count, row) => count + row.confirmedLessonCount, 0),
    };
  }

  /** US-PR-06：录入工资基础项。只写传了的字段；代扣项整体替换在同一事务里。 */
  async upsertEntry(teacherId: string, dto: UpsertPayrollDto): Promise<PayrollRow> {
    const teacher = await this.prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { id: true },
    });
    if (!teacher) throw new NotFoundException('老师不存在');

    const period = dto.period;
    await this.periods.assertOpen(period);

    const deductionItemIds =
      dto.deductions === undefined ? [] : [...new Set(dto.deductions.map((item) => item.deductionItemId))];
    if (deductionItemIds.length > 0) {
      const found = await this.prisma.deductionItem.findMany({
        where: { id: { in: deductionItemIds } },
        select: { id: true },
      });
      if (found.length !== deductionItemIds.length) {
        const foundIds = new Set(found.map((item) => item.id));
        const missing = deductionItemIds.filter((id) => !foundIds.has(id));
        throw new BadRequestException(`代扣项不存在：${missing.join(', ')}`);
      }
    }

    const data: PayrollEntryFields = {};
    if (dto.attendanceExpected !== undefined) data.attendanceExpected = dto.attendanceExpected;
    if (dto.attendanceActual !== undefined) data.attendanceActual = dto.attendanceActual;
    if (dto.attendanceAbsent !== undefined) data.attendanceAbsent = dto.attendanceAbsent;
    if (dto.baseSalary !== undefined) data.baseSalary = money(dto.baseSalary);
    if (dto.pianoBonus !== undefined) data.pianoBonus = money(dto.pianoBonus);
    if (dto.recruitBonus !== undefined) data.recruitBonus = money(dto.recruitBonus);
    if (dto.commissionRate !== undefined) data.commissionRate = money(dto.commissionRate);
    if (dto.note !== undefined) data.note = dto.note;

    await this.prisma.$transaction(async (tx) => {
      const payroll = await tx.payroll.upsert({
        where: { teacherId_period: { teacherId, period } },
        create: { teacherId, period, ...data },
        update: data,
        select: { id: true },
      });

      // 传了 deductions（含空数组）就整体替换：先删后建，与工资主记录同事务。
      if (dto.deductions !== undefined) {
        await tx.payrollDeduction.deleteMany({ where: { payrollId: payroll.id } });
        if (dto.deductions.length > 0) {
          await tx.payrollDeduction.createMany({
            data: dto.deductions.map((item) => ({
              payrollId: payroll.id,
              deductionItemId: item.deductionItemId,
              amount: money(item.amount),
            })),
          });
        }
      }
    });

    const row = await computePayrollForTeacher(this.prisma, teacherId, period);
    if (!row) throw new NotFoundException('老师不存在');
    return serializeRow(row);
  }

  /** US-PR-04：可选列定义。只读、无状态，不落库。 */
  getColumns(): OptionalPayrollColumn[] {
    return OPTIONAL_PAYROLL_COLUMNS.map((column) => ({
      key: column.key,
      label: column.label,
      defaultEnabled: column.defaultEnabled,
    }));
  }

  /**
   * US-PR-07：老师看自己的工资与课时。
   *
   * 服务端强制：老师身份只能取「自己账号关联的那位老师」，**绝不接受**
   * 由 query 传入的 teacherId —— 否则任何老师都能拿别人工资。
   */
  async getMine(actor: AuthenticatedUser, period: Period): Promise<MyPayroll> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { teacherId: true },
    });
    if (!user) throw new NotFoundException('账号不存在');

    if (!user.teacherId) {
      // 店主没关联老师 → 没有「个人工资」这个概念，是 404；
      // 授课老师没关联老师 → 越权边界，是 403。
      if (actor.role === UserRole.OWNER) {
        throw new NotFoundException('当前账号未关联老师档案，没有可查看的个人工资');
      }
      throw new ForbiddenException('当前账号未关联老师档案，无法查看工资');
    }

    const row = await computePayrollForTeacher(this.prisma, user.teacherId, period);
    if (!row) throw new NotFoundException('关联的老师档案不存在');
    return { period, ...serializeRow(row) };
  }

  /**
   * US-PR-05 两口径（§12 跨模块契约，finance 只调它）。
   *
   * `accruedTotal` = **经营支出**（本月应发综合工资合计）。
   * `cashTotal`    = **现金支出**（实际要发出去的钱）= 上月应发合计；
   *                  首月没有上期数据时回落到 `Organization.previousMonthPayroll`。
   *
   * 两个口径天然相差一个月，这是需求要的，不是 bug。
   * 金额是 Decimal，由调用方决定如何序列化。
   */
  computePeriodTotals(period: Period): Promise<{ accruedTotal: Money; cashTotal: Money }> {
    return computePeriodTotalsForPrisma(this.prisma, period);
  }

  /** HTTP 出口：把两口径序列化成字符串，并附上期月份。 */
  async getTotals(period: Period): Promise<PeriodTotalsResult> {
    const { accruedTotal, cashTotal } = await this.computePeriodTotals(period);
    return {
      period,
      accruedTotal: toMoneyString(accruedTotal),
      cashTotal: toMoneyString(cashTotal),
      previousPeriod: prevPeriod(period),
    };
  }
}
