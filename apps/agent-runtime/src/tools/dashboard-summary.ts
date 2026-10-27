import { z } from 'zod';

/** Compact read model; it deliberately avoids mirroring Core domain entities. */
export const DashboardSummarySchema = z.object({
  role: z.enum(['OWNER', 'TEACHER']).optional(),
  businessDate: z.iso.date(),
  highlights: z.array(z.string().min(1).max(300)).max(20),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  todayLessons: z.object({ total: z.number().int().nonnegative(), scheduled: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }).optional(),
  todayEndedUnconfirmedCount: z.number().int().nonnegative().optional(),
  todayLessonItems: z.array(z.object({
    lessonId: z.string().min(1), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/), studentName: z.string().min(1), courseName: z.string().min(1), teacherName: z.string().min(1), statusLabel: z.string().min(1),
  })).optional(),
  monthlyOperatingIncome: z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/).nullable().optional(),
  frozenStudentCount: z.number().int().nonnegative().optional(),
  studentsWithNegativeBalanceCount: z.number().int().nonnegative().optional(),
  unpaidPayrollCount: z.number().int().nonnegative().optional(),
  todayScheduledCount: z.number().int().nonnegative().optional(),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
