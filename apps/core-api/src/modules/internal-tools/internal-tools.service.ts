import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { LessonStatus, PayrollStatus, Prisma, UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ReportsService } from '../reports/reports.service.js';

type OwnerDashboardSummary = {
  role: 'OWNER';
  businessDate: string;
  period: string;
  highlights: string[];
  todayLessons: { total: number; scheduled: number; completed: number; cancelled: number };
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

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
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
    return !referenceAt || referenceAt.getTime() < threshold;
  }).length;
}

@Injectable()
export class InternalToolsService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly reports?: ReportsService) {}

  async teacherCandidates(
    subjectId: string,
    input: { teacherName: string },
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
      return {
        candidates: teacher.name === input.teacherName
          ? [{ teacherId: teacher.id, name: teacher.name }]
          : [],
      };
    }

    if (user.role !== UserRole.OWNER) throw new ForbiddenException('Capability 用户角色不可用');
    const teachers = await this.prisma.teacher.findMany({
      where: { name: input.teacherName, isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    return {
      candidates: teachers.map((teacher) => ({ teacherId: teacher.id, name: teacher.name })),
    };
  }

  async courseAccountCandidates(
    subjectId: string,
    input: { studentName: string; courseName: string },
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
        student: { name: input.studentName },
        course: { name: input.courseName },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        student: { select: { name: true } },
        course: { select: { name: true } },
      },
    });

    return {
      candidates: accounts.map((account) => ({
        accountId: account.id,
        studentName: account.student.name,
        courseName: account.course.name,
      })),
    };
  }

  async studentCandidates(
    subjectId: string,
    input: { studentName: string },
  ): Promise<{ candidates: StudentCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true },
    });
    if (!user?.isActive || user.role !== UserRole.OWNER) {
      throw new ForbiddenException('仅启用中的店主账号可查询学生候选');
    }
    const students = await this.prisma.student.findMany({
      where: { name: input.studentName },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    return { candidates: students.map((student) => ({ studentId: student.id, name: student.name })) };
  }

  async lessonCandidates(
    subjectId: string,
    input: { studentName: string; date?: string | undefined },
  ): Promise<{ candidates: LessonCandidate[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: { role: true, isActive: true, teacher: { select: { id: true, isActive: true } } },
    });
    if (!user?.isActive || ![UserRole.OWNER, UserRole.TEACHER].includes(user.role)) {
      throw new ForbiddenException('Capability 用户角色不可用');
    }
    const where = {
      account: { student: { name: input.studentName.trim() } },
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
    return { candidates: lessons.map((lesson) => ({
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

  async dashboardSummary(subjectId: string, now = new Date()): Promise<DashboardSummary> {
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
    return {
      role: 'OWNER',
      businessDate: date,
      period,
      todayLessons: { total: scheduled + completed + cancelled, scheduled, completed, cancelled },
      todayLessonItems: toTodayLessonItems(todayLessonRows),
      monthlyOperatingIncome: monthlyOperatingIncome ?? null,
      frozenStudentCount,
      studentsWithNegativeBalanceCount,
      unpaidPayrollCount,
      highlights: [
        `今日课程 ${scheduled + completed + cancelled} 节（待上 ${scheduled}、已完成 ${completed}、已取消 ${cancelled}）`,
        `冻结学生 ${frozenStudentCount} 人`,
        `课程账户负余额学生 ${studentsWithNegativeBalanceCount} 人`,
        `${period} 待发工资 ${unpaidPayrollCount} 笔`,
        ...(monthlyOperatingIncome ? [`${period} 经营收入 ${monthlyOperatingIncome} 元`] : []),
      ],
    };
  }
}
