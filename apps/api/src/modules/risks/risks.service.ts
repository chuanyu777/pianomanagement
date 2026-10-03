import { Injectable } from '@nestjs/common';
import { toMoneyString, ZERO, type Money } from '../../common/money.js';
import { LessonStatus, StudentStatus } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { computeEnrollmentBalances } from '../ledger/balance.js';

/**
 * 沉睡阈值（天）：**单一来源常量**，响应里回传 `thresholdDays`，前端不许硬编码 40。
 * 判定口径「超过 40 天没有已确认的课」→ 第 41 天才算沉睡，正好第 40 天不算。
 */
export const SLEEPING_IDLE_DAYS = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/** RA-01 欠费行：某条报名关系余额为负，附学生维度合计。 */
export type UnpaidRow = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  courseTypeName: string;
  balance: string;
  totalBalance: string;
};

/** RA-02 名单行：**不带任何金额**（需求明确）。 */
export type SleepingStudent = {
  studentId: string;
  studentName: string;
  /** 最后一节已确认课的时间；「从未有确认课」为 null。 */
  lastConfirmedAt: string | null;
  /** 距最后一节已确认课（never 类为距建卡）的天数，向下取整。 */
  idleDays: number;
};

export type SleepingList = {
  thresholdDays: number;
  /** 曾经有确认课、已超过阈值未再确认。 */
  sleeping: SleepingStudent[];
  /** 一次确认课都没有（如刚报名）——**不叫沉睡**，单独列出。 */
  never: SleepingStudent[];
};

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * 风险提醒（US-RA-01 / US-RA-02）。
 *
 * 余额一律走 `computeEnrollmentBalances`（`../ledger/balance.js`），不自己 SUM。
 * 沉睡判定只认 `LessonStatus.CONFIRMED`（排除 CANCELLED / LEAVE / SCHEDULED），
 * 并排除已退学学生（`status != WITHDRAWN`）。
 */
@Injectable()
export class RisksService {
  constructor(private readonly prisma: PrismaService) {}

  /** RA-01：任一报名余额为负即欠费，按欠费升序（余额最小的排最前）。仅店主可见。 */
  async listUnpaid(): Promise<UnpaidRow[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { student: { status: { not: StudentStatus.WITHDRAWN } } },
      include: {
        student: { select: { id: true, name: true, status: true } },
        courseType: { select: { name: true } },
      },
    });
    if (enrollments.length === 0) return [];

    const balances = await computeEnrollmentBalances(
      this.prisma,
      enrollments.map((enrollment) => enrollment.id),
    );

    // 学生维度合计（用于 totalBalance），口径是各报名的 total 之和。
    const totalByStudent = new Map<string, Money>();
    for (const enrollment of enrollments) {
      const balance = balances.get(enrollment.id);
      if (!balance) continue;
      totalByStudent.set(
        enrollment.student.id,
        (totalByStudent.get(enrollment.student.id) ?? ZERO).plus(balance.total),
      );
    }

    const rows: {
      studentId: string;
      studentName: string;
      enrollmentId: string;
      courseTypeName: string;
      balance: Money;
      totalBalance: Money;
    }[] = [];

    for (const enrollment of enrollments) {
      // 查询已排除退学，这里再兜一层：名单里出现退学学生一定是错的。
      if (enrollment.student.status === StudentStatus.WITHDRAWN) continue;
      const balance = balances.get(enrollment.id);
      if (!balance || !balance.total.isNegative()) continue;
      rows.push({
        studentId: enrollment.student.id,
        studentName: enrollment.student.name,
        enrollmentId: enrollment.id,
        courseTypeName: enrollment.courseType.name,
        balance: balance.total,
        totalBalance: totalByStudent.get(enrollment.student.id) ?? ZERO,
      });
    }

    rows.sort(
      (a, b) =>
        a.balance.comparedTo(b.balance) ||
        a.totalBalance.comparedTo(b.totalBalance) ||
        a.studentName.localeCompare(b.studentName, 'zh-Hans-CN'),
    );

    return rows.map((row) => ({
      studentId: row.studentId,
      studentName: row.studentName,
      enrollmentId: row.enrollmentId,
      courseTypeName: row.courseTypeName,
      balance: toMoneyString(row.balance),
      totalBalance: toMoneyString(row.totalBalance),
    }));
  }

  /**
   * RA-02：沉睡名单（店主与授课老师都可见）。
   *
   * 「当前时间」做成注入参数（默认 `new Date()`），边界测试才能拿到确定结果。
   * `never` 的 `idleDays` 用「距建卡天数」——它不带金额、也不参与阈值判定，
   * 只是一个「报名多久了还没上过课」的参考值。
   */
  async listSleeping(now: Date = new Date()): Promise<SleepingList> {
    const students = await this.prisma.student.findMany({
      where: { status: { not: StudentStatus.WITHDRAWN } },
      select: { id: true, name: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const active = students.filter((student) => student.status !== StudentStatus.WITHDRAWN);
    if (active.length === 0) {
      return { thresholdDays: SLEEPING_IDLE_DAYS, sleeping: [], never: [] };
    }

    const grouped = await this.prisma.lesson.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: active.map((student) => student.id) },
        status: LessonStatus.CONFIRMED,
      },
      _max: { confirmedAt: true },
    });
    const lastByStudent = new Map<string, Date>();
    for (const row of grouped) {
      if (row._max.confirmedAt) lastByStudent.set(row.studentId, row._max.confirmedAt);
    }

    const sleeping: SleepingStudent[] = [];
    const never: SleepingStudent[] = [];
    for (const student of active) {
      const lastConfirmedAt = lastByStudent.get(student.id);
      if (!lastConfirmedAt) {
        never.push({
          studentId: student.id,
          studentName: student.name,
          lastConfirmedAt: null,
          idleDays: wholeDaysBetween(student.createdAt, now),
        });
        continue;
      }
      const idleDays = wholeDaysBetween(lastConfirmedAt, now);
      if (idleDays > SLEEPING_IDLE_DAYS) {
        sleeping.push({
          studentId: student.id,
          studentName: student.name,
          lastConfirmedAt: lastConfirmedAt.toISOString(),
          idleDays,
        });
      }
    }

    sleeping.sort(
      (a, b) => b.idleDays - a.idleDays || a.studentName.localeCompare(b.studentName, 'zh-Hans-CN'),
    );

    return { thresholdDays: SLEEPING_IDLE_DAYS, sleeping, never };
  }
}
