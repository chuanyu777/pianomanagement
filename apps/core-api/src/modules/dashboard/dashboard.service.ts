import { Injectable } from '@nestjs/common';
import { businessNow } from '../../common/time/business-clock.js';
import { businessMonthStart, formatBusinessMonth } from '../../common/time/business-calendar.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { LessonsService } from '../lessons/lessons.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { StudentsService } from '../students/students.service.js';
import { DashboardRepository } from './dashboard.repository.js';

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function dayRange(now: Date): { businessDate: string; start: Date; end: Date } {
  const businessDate = DAY_FORMATTER.format(now);
  const start = new Date(`${businessDate}T00:00:00+08:00`);
  return { businessDate, start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly lessons: LessonsService,
    private readonly students: StudentsService,
    private readonly reports: ReportsService,
    private readonly periods: PeriodsService,
    private readonly repository: DashboardRepository,
  ) {}

  async overview(actor: AuthenticatedActor) {
    const now = businessNow();
    const range = dayRange(now);
    const monthStart = businessMonthStart(now);
    const todayLessons = await this.lessons.listForActorInRange(actor, { startsAt: range.start, endsAt: range.end });
    const pendingCount = todayLessons.filter((lesson) => lesson.status === 'SCHEDULED' && lesson.endsAt.getTime() < now.getTime()).length;
    const today = {
      total: todayLessons.length,
      pendingCount,
      completedCount: todayLessons.filter((lesson) => lesson.status === 'COMPLETED').length,
      lessons: todayLessons.map((lesson) => ({
        id: lesson.id,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        status: lesson.status,
        student: lesson.student,
        course: lesson.course,
      })),
    };
    if (actor.role !== 'OWNER') {
      return { asOf: now.toISOString(), businessDate: range.businessDate, today, students: null, finance: null, preclose: null, recentRecords: null };
    }
    const [students, report, preclose, facts] = await Promise.all([
      this.students.list(),
      this.reports.monthly(monthStart),
      this.periods.preclose(monthStart),
      this.repository.ownerFacts(),
    ]);
    return {
      asOf: now.toISOString(),
      businessDate: range.businessDate,
      today,
      students: { total: students.length, frozenCount: students.filter((student) => student.enrollmentStatus === 'FROZEN').length, arrearsCount: facts.arrearsCount },
      finance: { period: formatBusinessMonth(monthStart), operatingProfit: report.operatingProfit, cashNet: report.cashNet },
      preclose: { period: preclose.period, closed: preclose.closed, blockers: preclose.blockers, unpaidPayrollCount: preclose.unpaidPayrolls.length },
      recentRecords: facts.recentRecords,
    };
  }
}
