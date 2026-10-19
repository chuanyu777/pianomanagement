import { z } from 'zod';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import { DashboardSummarySchema, type DashboardSummary } from './dashboard-summary.js';

const SingleLessonPreviewRequestSchema = z
  .object({
    accountId: z.uuid(),
    teacherId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().min(1).max(2_000).optional(),
    idempotencyKey: z.uuid(),
    requestId: z.uuid(),
  })
  .strict();

export type SingleLessonPreviewRequest = z.infer<typeof SingleLessonPreviewRequestSchema>;

const SingleLessonPreviewResponseSchema = z
  .object({
    previewId: z.uuid(),
    actionType: z.literal('lesson.schedule.single'),
    command: z
      .object({
        accountId: z.uuid(),
        teacherId: z.uuid(),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
        note: z.string().optional(),
      })
      .strict(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
      })
      .strict(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type SingleLessonPreviewResponse = z.infer<typeof SingleLessonPreviewResponseSchema>;

const BatchLessonPreviewRequestSchema = z.object({
  accountId: z.uuid(),
  teacherId: z.uuid(),
  firstStartsAt: z.iso.datetime({ offset: true }),
  weeks: z.number().int().min(1).max(52),
  note: z.string().trim().max(2_000).optional(),
  idempotencyKey: z.uuid(),
  requestId: z.uuid(),
}).strict();

const BatchLessonPreviewResponseSchema = z.object({
  previewId: z.uuid(),
  actionType: z.literal('lesson.schedule.weekly-batch'),
  command: z.object({
    accountId: z.uuid(), teacherId: z.uuid(), firstStartsAt: z.iso.datetime(),
    weeks: z.number().int().min(1).max(52), note: z.string().nullable(),
  }).strict(),
  display: z.object({
    title: z.string().min(1), summary: z.string().min(1),
    lessons: z.array(z.object({ week: z.number().int().min(1), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).strict()),
    conflicts: z.array(z.record(z.string(), z.string())),
  }).strict(),
  resourceVersions: z.record(z.string(), z.unknown()),
  expiresAt: z.iso.datetime(),
  auditEventId: z.uuid(),
}).strict();

export type BatchLessonPreviewRequest = z.infer<typeof BatchLessonPreviewRequestSchema>;
export type BatchLessonPreviewResponse = z.infer<typeof BatchLessonPreviewResponseSchema>;

const FinalRefundPreviewRequestSchema = z.object({
  studentId: z.uuid(),
  feeAmount: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/),
  channel: z.enum(['CASH', 'WECHAT', 'ALIPAY', 'BANK_CARD', 'OTHER']),
  occurredAt: z.iso.datetime({ offset: true }),
  note: z.string().trim().max(2_000).optional(),
  idempotencyKey: z.uuid(),
  requestId: z.uuid(),
}).strict();

const FinalRefundPreviewResponseSchema = z.object({
  previewId: z.uuid(),
  actionType: z.literal('student.final-refund'),
  command: z.object({
    studentId: z.uuid(), feeAmount: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/), channel: z.enum(['CASH', 'WECHAT', 'ALIPAY', 'BANK_CARD', 'OTHER']),
    occurredAt: z.iso.datetime(), note: z.string().nullable(),
  }).strict(),
  display: z.object({
    title: z.string().min(1), summary: z.string().min(1), studentId: z.uuid(), studentName: z.string().min(1),
    studentStatusBefore: z.string().min(1), studentStatusAfter: z.string().min(1), totalPaidRefund: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
    feeAmount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/), feePercentage: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
    actualRefundAmount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
    courses: z.array(z.object({
      accountId: z.uuid(), courseName: z.string().min(1), paidBalanceBefore: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
      giftBalanceBefore: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
      paidRefundAmount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/), giftClearingAmount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
    }).strict()),
  }).strict(),
  resourceVersions: z.record(z.string(), z.unknown()),
  expiresAt: z.iso.datetime(), auditEventId: z.uuid(),
}).strict();

export type FinalRefundPreviewRequest = z.infer<typeof FinalRefundPreviewRequestSchema>;
export type FinalRefundPreviewResponse = z.infer<typeof FinalRefundPreviewResponseSchema>;

const PREVIEW_PATHS = {
  lesson: '/assistant-actions/lessons/single/preview',
  lessonBatch: '/assistant-actions/lessons/batch/preview',
  payment: '/assistant-actions/course-accounts/payment/preview',
  gift: '/assistant-actions/course-accounts/gift/preview',
  finalRefund: '/assistant-actions/students/final-refund/preview',
} as const;

type PreviewRequestPath = (typeof PREVIEW_PATHS)[keyof typeof PREVIEW_PATHS];

const PositiveMoneyStringSchema = z.string().regex(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d*\.\d{2})$/);
const BalanceMoneyStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/);
const PaymentChannelSchema = z.enum(['CASH', 'WECHAT', 'ALIPAY', 'BANK_CARD', 'OTHER']);

const MoneyPreviewBaseRequestSchema = z
  .object({
    accountId: z.uuid(),
    amount: PositiveMoneyStringSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(2_000).optional(),
    idempotencyKey: z.uuid(),
    requestId: z.uuid(),
  })
  .strict();

const PaymentPreviewRequestSchema = MoneyPreviewBaseRequestSchema.extend({
  channel: PaymentChannelSchema,
}).strict();

const GiftPreviewRequestSchema = MoneyPreviewBaseRequestSchema;

export type PaymentPreviewRequest = z.infer<typeof PaymentPreviewRequestSchema>;
export type GiftPreviewRequest = z.infer<typeof GiftPreviewRequestSchema>;

const CourseAccountBalanceSchema = z
  .object({
    accountId: z.uuid(),
    paidBalance: BalanceMoneyStringSchema,
    giftBalance: BalanceMoneyStringSchema,
    totalBalance: BalanceMoneyStringSchema,
  })
  .strict();

const MoneyPreviewDisplaySchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    beforeBalance: CourseAccountBalanceSchema,
    afterBalance: CourseAccountBalanceSchema,
  })
  .strict();

const PaymentPreviewResponseSchema = z
  .object({
    previewId: z.uuid(),
    actionType: z.literal('course-account.payment'),
    command: z
      .object({
        accountId: z.uuid(),
        amount: PositiveMoneyStringSchema,
        channel: PaymentChannelSchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
      })
      .strict(),
    display: MoneyPreviewDisplaySchema,
    expiresAt: z.iso.datetime(),
    auditEventId: z.uuid(),
  })
  .strict();

const GiftPreviewResponseSchema = z
  .object({
    previewId: z.uuid(),
    actionType: z.literal('course-account.gift'),
    command: z
      .object({
        accountId: z.uuid(),
        amount: PositiveMoneyStringSchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
      })
      .strict(),
    display: MoneyPreviewDisplaySchema,
    expiresAt: z.iso.datetime(),
    auditEventId: z.uuid(),
  })
  .strict();

export type PaymentPreviewResponse = z.infer<typeof PaymentPreviewResponseSchema>;
export type GiftPreviewResponse = z.infer<typeof GiftPreviewResponseSchema>;

const SystemStatusSchema = z.object({
  status: z.literal('available'),
  businessTimezone: z.literal('Asia/Shanghai'),
  serverTime: z.iso.datetime(),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

const CourseAccountCandidatesSchema = z.object({
  candidates: z.array(z.object({
    accountId: z.uuid(),
    studentName: z.string().trim().min(1),
    courseName: z.string().trim().min(1),
  }).strict()),
}).strict();

export type CourseAccountCandidates = z.infer<typeof CourseAccountCandidatesSchema>;

const TeacherCandidatesSchema = z
  .object({
    candidates: z.array(z.object({
      teacherId: z.uuid(),
      name: z.string().trim().min(1),
    }).strict()),
  })
  .strict();

export type TeacherCandidates = z.infer<typeof TeacherCandidatesSchema>;

const StudentCandidatesSchema = z.object({
  candidates: z.array(z.object({ studentId: z.uuid(), name: z.string().trim().min(1) }).strict()),
}).strict();

export type StudentCandidates = z.infer<typeof StudentCandidatesSchema>;

export class CoreToolClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly serviceSecret: string,
  ) {}

  async getSystemStatus(capabilityToken: string): Promise<SystemStatus> {
    const url = `${this.baseUrl}/tools/system-status`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          securityHeaders: { authorization },
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return SystemStatusSchema.parse(await response.json());
  }

  async getDashboardSummary(capabilityToken: string): Promise<DashboardSummary> {
    const url = `${this.baseUrl}/tools/dashboard-summary`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          securityHeaders: { authorization },
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return DashboardSummarySchema.parse(await response.json());
  }

  async getCourseAccountCandidates(
    capabilityToken: string,
    input: { studentName: string; courseName: string },
  ): Promise<CourseAccountCandidates> {
    const studentName = z.string().trim().min(1).max(100).parse(input.studentName);
    const courseName = z.string().trim().min(1).max(100).parse(input.courseName);
    const query = new URLSearchParams({ studentName, courseName });
    const url = `${this.baseUrl}/tools/course-account-candidates?${query.toString()}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          securityHeaders: { authorization },
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return CourseAccountCandidatesSchema.parse(await response.json());
  }

  async getTeacherCandidates(
    capabilityToken: string,
    input: { teacherName: string },
  ): Promise<TeacherCandidates> {
    const teacherName = z.string().trim().min(1).max(100).parse(input.teacherName);
    const query = new URLSearchParams({ teacherName });
    const url = `${this.baseUrl}/tools/teacher-candidates?${query.toString()}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          securityHeaders: { authorization },
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return TeacherCandidatesSchema.parse(await response.json());
  }

  async getStudentCandidates(
    capabilityToken: string,
    input: { studentName: string },
  ): Promise<StudentCandidates> {
    const studentName = z.string().trim().min(1).max(100).parse(input.studentName);
    const query = new URLSearchParams({ studentName });
    const url = `${this.baseUrl}/tools/student-candidates?${query.toString()}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          securityHeaders: { authorization },
        }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return StudentCandidatesSchema.parse(await response.json());
  }

  async createSingleLessonPreview(
    capabilityToken: string,
    request: SingleLessonPreviewRequest,
  ): Promise<SingleLessonPreviewResponse> {
    const parsedRequest = SingleLessonPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(
      PREVIEW_PATHS.lesson,
      capabilityToken,
      parsedRequest,
      SingleLessonPreviewResponseSchema,
    );
  }

  async createBatchLessonPreview(
    capabilityToken: string,
    request: BatchLessonPreviewRequest,
  ): Promise<BatchLessonPreviewResponse> {
    const parsedRequest = BatchLessonPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(
      PREVIEW_PATHS.lessonBatch,
      capabilityToken,
      parsedRequest,
      BatchLessonPreviewResponseSchema,
    );
  }

  async createFinalRefundPreview(
    capabilityToken: string,
    request: FinalRefundPreviewRequest,
  ): Promise<FinalRefundPreviewResponse> {
    const parsedRequest = FinalRefundPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(
      PREVIEW_PATHS.finalRefund,
      capabilityToken,
      parsedRequest,
      FinalRefundPreviewResponseSchema,
    );
  }

  async createPaymentPreview(
    capabilityToken: string,
    request: PaymentPreviewRequest,
  ): Promise<PaymentPreviewResponse> {
    const parsedRequest = PaymentPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(
      PREVIEW_PATHS.payment,
      capabilityToken,
      parsedRequest,
      PaymentPreviewResponseSchema,
    );
  }

  async createGiftPreview(
    capabilityToken: string,
    request: GiftPreviewRequest,
  ): Promise<GiftPreviewResponse> {
    const parsedRequest = GiftPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(
      PREVIEW_PATHS.gift,
      capabilityToken,
      parsedRequest,
      GiftPreviewResponseSchema,
    );
  }

  private async postPreviewRequest<TRequest, TResponse>(
    path: PreviewRequestPath,
    capabilityToken: string,
    request: TRequest,
    responseSchema: z.ZodType<TResponse>,
  ): Promise<TResponse> {
    if (!Object.values(PREVIEW_PATHS).includes(path)) {
      throw new TypeError('Preview 请求路径不合法');
    }

    const url = `${this.baseUrl}${path}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization,
        ...createSignedInternalRequestHeaders({
          secret: this.serviceSecret,
          method: 'POST',
          path: `${target.pathname}${target.search}`,
          body: request,
          securityHeaders: { authorization },
        }),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Core Tool API 调用失败：${response.status}`);
    return responseSchema.parse(await response.json());
  }
}
