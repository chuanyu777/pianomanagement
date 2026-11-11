import { z } from 'zod';

/**
 * 经营摘要（只读投影）。
 *
 * 它刻意不复刻领域实体，只提供对话与首页需要的计数和少量明细；
 * Core 用它导出文档，Agent 用它校验返回，避免两处各写一份。
 */
export const DashboardSummarySchema = z.object({
  role: z.enum(['OWNER', 'TEACHER']).optional(),
  businessDate: z.iso.date(),
  highlights: z.array(z.string().min(1).max(300)).max(20),
  period: z.string().regex(/^\d{4}-\d{2}$/u).optional(),
  todayLessons: z
    .object({
      total: z.number().int().nonnegative(),
      scheduled: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
    })
    .optional(),
  todayEndedUnconfirmedCount: z.number().int().nonnegative().optional(),
  todayLessonItems: z
    .array(
      z.object({
        lessonId: z.string().min(1),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/u),
        studentName: z.string().min(1),
        courseName: z.string().min(1),
        teacherName: z.string().min(1),
        statusLabel: z.string().min(1),
      }),
    )
    .optional(),
  monthlyOperatingIncome: z
    .string()
    .regex(/^-?(0|[1-9]\d*)\.\d{2}$/u)
    .nullable()
    .optional(),
  frozenStudentCount: z.number().int().nonnegative().optional(),
  studentsWithNegativeBalanceCount: z.number().int().nonnegative().optional(),
  unpaidPayrollCount: z.number().int().nonnegative().optional(),
  todayScheduledCount: z.number().int().nonnegative().optional(),
});

export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
