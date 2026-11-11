import { z } from 'zod';

/**
 * 对话过程中用于"选人、选课、选单"的候选结构。
 *
 * 与确认单一样，这里只定义一份：Core 用它导出接口文档，Agent 用它校验返回。
 * 候选只承载身份与必要描述，绝不携带余额或金额，避免选择前泄露资金信息。
 */

export const CourseAccountCandidatesResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          accountId: z.uuid(),
          studentId: z.uuid(),
          studentName: z.string().trim().min(1),
          courseName: z.string().trim().min(1),
        })
        .loose(),
    ),
  })
  .loose();

export const TeacherCandidatesResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          teacherId: z.uuid(),
          name: z.string().trim().min(1),
        })
        .loose(),
    ),
  })
  .loose();

export const StudentCandidatesResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          studentId: z.uuid(),
          name: z.string().trim().min(1),
        })
        .loose(),
    ),
  })
  .loose();

export const LessonCandidatesResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          lessonId: z.uuid(),
          studentName: z.string().trim().min(1),
          courseName: z.string().trim().min(1),
          teacherName: z.string().trim().min(1),
          startsAt: z.iso.datetime(),
          status: z.string().trim().min(1),
        })
        .loose(),
    ),
  })
  .loose();

export const PayrollCandidatesResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          payrollId: z.uuid(),
          teacherId: z.uuid(),
          teacherName: z.string().trim().min(1),
          period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
          status: z.string().trim().min(1),
        })
        .loose(),
    ),
  })
  .loose();

export type CourseAccountCandidatesResponse = z.infer<typeof CourseAccountCandidatesResponseSchema>;
export type TeacherCandidatesResponse = z.infer<typeof TeacherCandidatesResponseSchema>;
export type StudentCandidatesResponse = z.infer<typeof StudentCandidatesResponseSchema>;
export type LessonCandidatesResponse = z.infer<typeof LessonCandidatesResponseSchema>;
export type PayrollCandidatesResponse = z.infer<typeof PayrollCandidatesResponseSchema>;
