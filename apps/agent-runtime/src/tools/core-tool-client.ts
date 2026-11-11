import { z } from 'zod';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import {
  SingleLessonPreviewResponseSchema,
  BatchLessonPreviewResponseSchema,
  FinalRefundPreviewResponseSchema,
  PaymentPreviewResponseSchema,
  GiftPreviewResponseSchema,
  StructuredActionPreviewResponseSchema,
  CourseAccountCandidatesResponseSchema as CourseAccountCandidatesSchema,
  TeacherCandidatesResponseSchema as TeacherCandidatesSchema,
  StudentCandidatesResponseSchema as StudentCandidatesSchema,
  LessonCandidatesResponseSchema as LessonCandidatesSchema,
  PayrollCandidatesResponseSchema as PayrollCandidatesSchema,
} from '@piano/assistant-protocol';
import { DashboardSummarySchema, type DashboardSummary } from './dashboard-summary.js';
import { CoreDialogueError } from './dialogue-tools.js';

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

// 响应结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。

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

// 响应结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。

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

// 响应结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。

export type FinalRefundPreviewRequest = z.infer<typeof FinalRefundPreviewRequestSchema>;
export type FinalRefundPreviewResponse = z.infer<typeof FinalRefundPreviewResponseSchema>;

const PREVIEW_PATHS = {
  lesson: '/assistant-actions/lessons/single/preview',
  lessonBatch: '/assistant-actions/lessons/batch/preview',
  payment: '/assistant-actions/course-accounts/payment/preview',
  gift: '/assistant-actions/course-accounts/gift/preview',
  finalRefund: '/assistant-actions/students/final-refund/preview',
  structuredAction: '/assistant-actions/structured-action/preview',
} as const;

type PreviewRequestPath = (typeof PREVIEW_PATHS)[keyof typeof PREVIEW_PATHS];

const PositiveMoneyStringSchema = z.string().regex(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,11}\.\d{2})$/);
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

const PaymentPreviewRequestSchema = z.union([
  MoneyPreviewBaseRequestSchema.extend({channel:PaymentChannelSchema}).strict(),
  MoneyPreviewBaseRequestSchema.omit({accountId:true}).extend({studentId:z.uuid(),courseId:z.uuid(),currentUnitPrice:PositiveMoneyStringSchema.optional(),channel:PaymentChannelSchema}).strict(),
]);

const GiftPreviewRequestSchema = MoneyPreviewBaseRequestSchema;

export type PaymentPreviewRequest = z.infer<typeof PaymentPreviewRequestSchema>;
export type GiftPreviewRequest = z.infer<typeof GiftPreviewRequestSchema>;

// 响应结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。


export type PaymentPreviewResponse = z.infer<typeof PaymentPreviewResponseSchema>;
export type GiftPreviewResponse = z.infer<typeof GiftPreviewResponseSchema>;

const SystemStatusSchema = z.object({
  status: z.literal('available'),
  businessTimezone: z.literal('Asia/Shanghai'),
  serverTime: z.iso.datetime(),
});

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

// 候选结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。
export type CourseAccountCandidates = z.infer<typeof CourseAccountCandidatesSchema>;
export type TeacherCandidates = z.infer<typeof TeacherCandidatesSchema>;
export type StudentCandidates = z.infer<typeof StudentCandidatesSchema>;
export type LessonCandidates = z.infer<typeof LessonCandidatesSchema>;
export type PayrollCandidates = z.infer<typeof PayrollCandidatesSchema>;

const StructuredActionPreviewRequestSchema = z.object({
  actionType: z.string().trim().min(1), command: z.record(z.string(), z.unknown()),
  idempotencyKey: z.uuid(), requestId: z.uuid(),
}).strict();

// 响应结构统一在 @piano/assistant-protocol 定义，Agent 不再手写第二份。

export type StructuredActionPreviewRequest = z.infer<typeof StructuredActionPreviewRequestSchema>;
export type StructuredActionPreviewResponse = z.infer<typeof StructuredActionPreviewResponseSchema>;

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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return DashboardSummarySchema.parse(await response.json());
  }

  async getCourseAccountCandidates(
    capabilityToken: string,
    input: { studentName: string; courseName?: string; match?: 'search' },
  ): Promise<CourseAccountCandidates> {
    const studentName = z.string().trim().min(1).max(100).parse(input.studentName);
    const courseName = input.courseName === undefined ? undefined : z.string().trim().min(1).max(100).parse(input.courseName);
    const query = new URLSearchParams({ studentName });
    if (courseName) query.set('courseName', courseName);
    if (input.match) query.set('match', input.match);
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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return CourseAccountCandidatesSchema.parse(await response.json());
  }

  async getTeacherCandidates(
    capabilityToken: string,
    input: { teacherName: string; match?: 'search' },
  ): Promise<TeacherCandidates> {
    const teacherName = z.string().trim().min(1).max(100).parse(input.teacherName);
    const query = new URLSearchParams({ teacherName });
    if (input.match) query.set('match', input.match);
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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return TeacherCandidatesSchema.parse(await response.json());
  }

  async getStudentCandidates(
    capabilityToken: string,
    input: { studentName: string; match?: 'search' },
  ): Promise<StudentCandidates> {
    const studentName = z.string().trim().min(1).max(100).parse(input.studentName);
    const query = new URLSearchParams({ studentName });
    if (input.match) query.set('match', input.match);
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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return StudentCandidatesSchema.parse(await response.json());
  }

  async getLessonCandidates(
    capabilityToken: string,
    input: { studentName: string; date?: string; match?: 'search' },
  ): Promise<LessonCandidates> {
    const studentName = z.string().trim().min(1).max(100).parse(input.studentName);
    const query = new URLSearchParams({ studentName });
    if (input.match) query.set('match', input.match);
    if (input.date) query.set('date', z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(input.date));
    const url = `${this.baseUrl}/tools/lesson-candidates?${query.toString()}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: {
        authorization,
        ...createSignedInternalRequestHeaders({ secret: this.serviceSecret, method: 'GET', path: `${target.pathname}${target.search}`, securityHeaders: { authorization } }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return LessonCandidatesSchema.parse(await response.json());
  }

  async createStructuredActionPreview(
    capabilityToken: string,
    request: StructuredActionPreviewRequest,
  ): Promise<StructuredActionPreviewResponse> {
    const parsedRequest = StructuredActionPreviewRequestSchema.parse(request);
    return this.postPreviewRequest(PREVIEW_PATHS.structuredAction, capabilityToken, parsedRequest, StructuredActionPreviewResponseSchema);
  }

  async getPayrollCandidates(
    capabilityToken: string,
    input: { teacherName: string; period: string },
  ): Promise<PayrollCandidates> {
    const teacherName = z.string().trim().min(1).max(100).parse(input.teacherName);
    const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(input.period);
    const url = `${this.baseUrl}/tools/payroll-candidates?${new URLSearchParams({ teacherName, period }).toString()}`;
    const target = new URL(url);
    const authorization = `Bearer ${capabilityToken}`;
    const response = await fetch(url, {
      headers: { authorization, ...createSignedInternalRequestHeaders({ secret: this.serviceSecret, method: 'GET', path: `${target.pathname}${target.search}`, securityHeaders: { authorization } }) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return PayrollCandidatesSchema.parse(await response.json());
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
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return responseSchema.parse(await response.json());
  }
}
