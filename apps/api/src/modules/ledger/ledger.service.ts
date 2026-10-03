import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { money, toMoneyString, ZERO, type Money } from '../../common/money.js';
import { isValidPeriod, periodRange } from '../../common/period.js';
import { Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { computeEnrollmentBalances, type EnrollmentBalance } from './balance.js';
import { ListEntriesQueryDto } from './dto/list-entries.dto.js';

/** 单价为 0 时「余额 ÷ 单价」会除零。此时不展示剩余课时，提示先维护单价。 */
const ZERO_UNIT_PRICE_HINT = '该课程单价为 0，请先维护单价';

export type EnrollmentLedgerRow = {
  enrollmentId: string;
  courseTypeName: string;
  teacherName: string;
  unitPrice: string;
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
  /** 预计剩余课时 = 合计余额 ÷ 该报名单价，保留 1 位小数；单价为 0 时不返回。 */
  remainingLessons?: number;
  remainingLessonsHint?: string;
};

export type MoneyTotals = {
  paidBalance: string;
  giftBalance: string;
  totalBalance: string;
};

/**
 * 学生余额与课时台账（US-ML-01）。
 *
 * 三条不变量：
 * 1. **余额不自己算**：一律调 `computeEnrollmentBalances`（`./balance.js`）。
 *    自己写 SUM 就是第二份实现，迟早和权威实现对不上还不报错。
 * 2. **金额只走 Decimal**：所有加减乘除用 money.ts，对外 `toMoneyString`。
 * 3. 余额是**当前值**，不按月份切分（实施计划 §1）；月份只用于筛选流水。
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** 某学生的连续余额台账：每条报名一行 + 学生维度合计 + 余额状态。 */
  async getStudentLedger(studentId: string, period?: string) {
    this.assertPeriod(period);

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, status: true },
    });
    if (!student) throw new NotFoundException('学生不存在');

    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId },
      orderBy: { createdAt: 'asc' },
      include: {
        courseType: { select: { name: true } },
        teacher: { select: { name: true } },
      },
    });

    const balances = await computeEnrollmentBalances(
      this.prisma,
      enrollments.map((enrollment) => enrollment.id),
    );

    const rows: EnrollmentLedgerRow[] = [];
    const totals = { paid: ZERO, gift: ZERO, total: ZERO };
    let hasNegative = false;

    for (const enrollment of enrollments) {
      const balance = balances.get(enrollment.id) ?? emptyBalance(enrollment.id);
      const unitPrice = money(enrollment.unitPrice);

      const row: EnrollmentLedgerRow = {
        enrollmentId: enrollment.id,
        courseTypeName: enrollment.courseType.name,
        teacherName: enrollment.teacher.name,
        unitPrice: toMoneyString(unitPrice),
        paidBalance: toMoneyString(balance.paid),
        giftBalance: toMoneyString(balance.gift),
        totalBalance: toMoneyString(balance.total),
      };

      if (unitPrice.lessThanOrEqualTo(ZERO)) {
        // 不返回 Infinity / NaN，也不返回一个误导性的 0。
        row.remainingLessonsHint = ZERO_UNIT_PRICE_HINT;
      } else {
        row.remainingLessons = toLessonCount(balance.total.dividedBy(unitPrice));
      }

      rows.push(row);
      totals.paid = totals.paid.plus(balance.paid);
      totals.gift = totals.gift.plus(balance.gift);
      totals.total = totals.total.plus(balance.total);
      if (balance.total.isNegative()) hasNegative = true;
    }

    return {
      student,
      enrollments: rows,
      totals: serializeTotals(totals),
      balanceStatus: hasNegative ? '欠费' : '正常',
    };
  }

  /** 台账流水：按 occurredAt 倒序分页，可按学生 / 报名 / 类型 / 月份过滤。 */
  async listEntries(query: ListEntriesQueryDto) {
    const where: Prisma.LedgerEntryWhereInput = {};
    if (query.enrollmentId !== undefined) where.enrollmentId = query.enrollmentId;
    if (query.studentId !== undefined) where.enrollment = { studentId: query.studentId };
    if (query.kind !== undefined) where.kind = query.kind;
    if (query.period !== undefined) {
      const { start, end } = periodRange(query.period);
      where.occurredAt = { gte: start, lt: end };
    }

    const [entries, total] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          enrollment: {
            include: {
              courseType: { select: { name: true } },
              student: { select: { name: true } },
              teacher: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);

    return {
      items: entries.map((entry) => ({
        id: entry.id,
        occurredAt: entry.occurredAt.toISOString(),
        kind: entry.kind,
        courseTypeName: entry.enrollment.courseType.name,
        studentName: entry.enrollment.student.name,
        teacherName: entry.enrollment.teacher.name,
        paidDelta: toMoneyString(entry.paidDelta),
        giftDelta: toMoneyString(entry.giftDelta),
        note: entry.note,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 按老师分组查看：老师 → 学生 → 各报名余额。 */
  async listByTeacher(period?: string) {
    this.assertPeriod(period);

    const enrollments = await this.prisma.enrollment.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        student: { select: { id: true, name: true } },
        teacher: { select: { id: true, name: true } },
        courseType: { select: { name: true } },
      },
    });

    const balances = await computeEnrollmentBalances(
      this.prisma,
      enrollments.map((enrollment) => enrollment.id),
    );

    // 按老师分组后，嵌套行不必再重复 teacherName —— 父级已经带着了。
    type NestedEnrollmentRow = Omit<
      EnrollmentLedgerRow,
      'remainingLessons' | 'remainingLessonsHint' | 'teacherName'
    >;
    type StudentGroup = {
      studentId: string;
      studentName: string;
      enrollments: NestedEnrollmentRow[];
      totals: { paid: Money; gift: Money; total: Money };
    };
    type TeacherGroup = {
      teacherId: string;
      teacherName: string;
      students: Map<string, StudentGroup>;
      totals: { paid: Money; gift: Money; total: Money };
    };

    const teacherGroups = new Map<string, TeacherGroup>();

    for (const enrollment of enrollments) {
      const balance = balances.get(enrollment.id) ?? emptyBalance(enrollment.id);

      let teacherGroup = teacherGroups.get(enrollment.teacher.id);
      if (!teacherGroup) {
        teacherGroup = {
          teacherId: enrollment.teacher.id,
          teacherName: enrollment.teacher.name,
          students: new Map<string, StudentGroup>(),
          totals: { paid: ZERO, gift: ZERO, total: ZERO },
        };
        teacherGroups.set(enrollment.teacher.id, teacherGroup);
      }

      let studentGroup = teacherGroup.students.get(enrollment.student.id);
      if (!studentGroup) {
        studentGroup = {
          studentId: enrollment.student.id,
          studentName: enrollment.student.name,
          enrollments: [],
          totals: { paid: ZERO, gift: ZERO, total: ZERO },
        };
        teacherGroup.students.set(enrollment.student.id, studentGroup);
      }

      studentGroup.enrollments.push({
        enrollmentId: enrollment.id,
        courseTypeName: enrollment.courseType.name,
        unitPrice: toMoneyString(enrollment.unitPrice),
        paidBalance: toMoneyString(balance.paid),
        giftBalance: toMoneyString(balance.gift),
        totalBalance: toMoneyString(balance.total),
      });
      studentGroup.totals.paid = studentGroup.totals.paid.plus(balance.paid);
      studentGroup.totals.gift = studentGroup.totals.gift.plus(balance.gift);
      studentGroup.totals.total = studentGroup.totals.total.plus(balance.total);
      teacherGroup.totals.paid = teacherGroup.totals.paid.plus(balance.paid);
      teacherGroup.totals.gift = teacherGroup.totals.gift.plus(balance.gift);
      teacherGroup.totals.total = teacherGroup.totals.total.plus(balance.total);
    }

    return [...teacherGroups.values()].map((group) => ({
      teacherId: group.teacherId,
      teacherName: group.teacherName,
      students: [...group.students.values()].map((student) => ({
        ...student,
        totals: serializeTotals(student.totals),
      })),
      totals: serializeTotals(group.totals),
    }));
  }

  /** service 层兜底校验：DTO 之外（如内部调用）也挡非法月份。 */
  private assertPeriod(period?: string): void {
    if (period !== undefined && !isValidPeriod(period)) {
      throw new BadRequestException(`period 非法：${period}，应形如 2026-10`);
    }
  }
}

function emptyBalance(enrollmentId: string): EnrollmentBalance {
  return { enrollmentId, paid: ZERO, gift: ZERO, total: ZERO };
}

function serializeTotals(totals: { paid: Money; gift: Money; total: Money }): MoneyTotals {
  return {
    paidBalance: toMoneyString(totals.paid),
    giftBalance: toMoneyString(totals.gift),
    totalBalance: toMoneyString(totals.total),
  };
}

/** 课时数是数量不是金额，可以落回 number；保留 1 位小数。 */
function toLessonCount(value: Money): number {
  return Number(value.toDecimalPlaces(1).toString());
}
