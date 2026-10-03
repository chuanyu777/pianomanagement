import { Injectable } from '@nestjs/common';
import { money, toMoneyString, ZERO, type Money } from '../../common/money.js';
import { lastPeriods, periodRange, type Period } from '../../common/period.js';
import { LessonStatus } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { computePayrollSheet } from '../payroll/payroll-totals.js';

/** AN-01 教师业绩排行的一行。名次由服务端给，前端不生成序号。 */
export type TeacherRankingRow = {
  rank: number;
  teacherId: string;
  teacherName: string;
  performance: string;
  lessonCount: number;
};

/** AN-02 教师业绩趋势：每位老师一条折线。 */
export type TeacherTrendSeries = {
  teacherId: string;
  teacherName: string;
  points: { period: Period; performance: string }[];
};

/** AN-03 学生消费排行的一行。 */
export type StudentRankingRow = {
  rank: number;
  studentId: string;
  studentName: string;
  consumption: string;
  lessonCount: number;
};

/**
 * 经营分析（US-AN-01 / AN-02 / AN-03）。
 *
 * 三条口径全部复用现成的权威实现，**本模块不自己算钱**：
 * - 教师业绩 = `computePayrollSheet`（业绩只统计已确认且非赠送课的单价快照，见 payroll-totals）。
 * - 学生消费 = 该月已确认且非赠送课 `unitPriceSnapshot` 按学生汇总（口径与 finance 的课时消费一致）。
 *
 * 排序一律在服务端完成（需求明确），并返回 `rank`；名次按位置连续编号（1,2,3…），不是竞赛式并列。
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** AN-01：按业绩降序。业绩为 0 的老师也要返回（不做过滤）。 */
  async teacherRanking(period: Period): Promise<TeacherRankingRow[]> {
    const sheet = await computePayrollSheet(this.prisma, period);

    return sheet
      .map((row) => ({
        teacherName: row.teacherName,
        teacherId: row.teacherId,
        performance: money(row.performance),
        lessonCount: row.confirmedLessonCount,
      }))
      .sort(
        (a, b) =>
          b.performance.comparedTo(a.performance) ||
          a.teacherName.localeCompare(b.teacherName, 'zh-Hans-CN'),
      )
      .map((row, index) => ({
        rank: index + 1,
        teacherId: row.teacherId,
        teacherName: row.teacherName,
        performance: toMoneyString(row.performance),
        lessonCount: row.lessonCount,
      }));
  }

  /**
   * AN-02：每位老师逐月业绩。
   *
   * 老师集合来自这段时间内出现在工资表里的所有人（`computePayrollSheet` 只含在职老师）；
   * 某个老师某个月没有业绩时补 `0.00`，而不是跳过 —— 折线断点会被前端画成假的下降。
   */
  async teacherTrend(endPeriod: Period, months: number): Promise<TeacherTrendSeries[]> {
    const periods = lastPeriods(endPeriod, months);
    const sheets = await Promise.all(
      periods.map((period) => computePayrollSheet(this.prisma, period)),
    );

    const byTeacher = new Map<string, { teacherName: string; byPeriod: Map<Period, Money> }>();
    periods.forEach((period, index) => {
      for (const row of sheets[index]) {
        let entry = byTeacher.get(row.teacherId);
        if (!entry) {
          entry = { teacherName: row.teacherName, byPeriod: new Map<Period, Money>() };
          byTeacher.set(row.teacherId, entry);
        }
        entry.byPeriod.set(period, money(row.performance));
      }
    });

    return [...byTeacher.entries()]
      .sort((a, b) => a[1].teacherName.localeCompare(b[1].teacherName, 'zh-Hans-CN'))
      .map(([teacherId, entry]) => ({
        teacherId,
        teacherName: entry.teacherName,
        points: periods.map((period) => ({
          period,
          performance: toMoneyString(entry.byPeriod.get(period) ?? ZERO),
        })),
      }));
  }

  /** AN-03：按该月消费降序。消费为 0 的学生不返回。 */
  async studentRanking(period: Period): Promise<StudentRankingRow[]> {
    const { start, end } = periodRange(period);

    const grouped = await this.prisma.lesson.groupBy({
      by: ['studentId'],
      where: {
        status: LessonStatus.CONFIRMED,
        isGift: false,
        confirmedAt: { gte: start, lt: end },
      },
      _sum: { unitPriceSnapshot: true },
      _count: { _all: true },
    });

    const ranked = grouped
      .map((row) => ({
        studentId: row.studentId,
        consumption: money(row._sum.unitPriceSnapshot),
        lessonCount: row._count._all,
      }))
      .filter((row) => row.consumption.greaterThan(ZERO))
      .sort((a, b) => b.consumption.comparedTo(a.consumption));
    if (ranked.length === 0) return [];

    const students = await this.prisma.student.findMany({
      where: { id: { in: ranked.map((row) => row.studentId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(students.map((student) => [student.id, student.name]));

    return ranked.map((row, index) => ({
      rank: index + 1,
      studentId: row.studentId,
      studentName: nameById.get(row.studentId) ?? '',
      consumption: toMoneyString(row.consumption),
      lessonCount: row.lessonCount,
    }));
  }
}
