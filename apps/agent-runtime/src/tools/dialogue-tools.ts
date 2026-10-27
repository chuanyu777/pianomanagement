import type { components, paths } from '@piano/generated-core-client/generated/core-api';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';

export type LessonReadResult = components['schemas']['InternalLessonsResponse'];
export type AccountReadResult = components['schemas']['InternalCourseAccountResponse'];
export type LessonReadQuery = NonNullable<paths['/api/internal/tools/lessons']['get']['parameters']['query']>;
export type MonthlyReportReadResult = components['schemas']['InternalMonthlyReportResponse'];
export type AccountLedgerReadResult = components['schemas']['InternalCourseAccountLedgerResponse'];
export type MonthlyPayrollReadResult = components['schemas']['InternalMonthlyPayrollResponse'];
export type DirectoryReadResult = {
  students: Array<{ studentId: string; name: string; enrollmentStatus: string }>;
  teachers: Array<{ teacherId: string; name: string; isActive: boolean }>;
  courses: Array<{ courseId: string; name: string; defaultUnitPrice: string; defaultDurationMinutes: number; isActive: boolean }>;
};
export type ArrearsAndFrozenReadResult = {
  arrears: Array<{ studentId: string; studentName: string; courseId: string; courseName: string; paidBalance: string }>;
  frozenStudents: Array<{ studentId: string; name: string; reason: string }>;
};
export type MonthlyConsumptionReadResult = {
  period: string;
  totalAmount: string;
  courses: Array<{ id: string; name: string; amount: string }>;
  teachers: Array<{ id: string; name: string; amount: string }>;
  students: Array<{ id: string; name: string; amount: string }>;
};
export type PeriodPrecloseReadResult = {
  period: string;
  closed: boolean;
  pendingLessons: Array<{ lessonId: string; studentName: string; courseName: string; teacherName: string; endsAt: string }>;
  refundAnomalies: Array<{ refundId: string; studentName: string; issue: string }>;
  missingPayrollTeachers: Array<{ teacherId: string; teacherName: string }>;
  ledgerAnomalies: Array<{ entryId: string; kind: string; issue: string }>;
  reminders: Array<{ code: string; message: string; requiresHumanJudgment: true }>;
};

export class CoreDialogueError extends Error {
  constructor(readonly status: number, message?: string, readonly code?: string) {
    super(message ?? (status === 403 ? '当前账号无权执行此操作' : status === 409 ? '当前业务状态不允许此操作，请重新核对' : status === 404 ? '没有找到对应业务记录' : status === 400 ? '业务参数不完整或不合法，请核对后再试' : '业务服务暂时不可用，请稍后重试'));
    this.name = 'CoreDialogueError';
  }

  static async fromResponse(response: Response): Promise<CoreDialogueError> {
    if (response.status >= 500) return new CoreDialogueError(response.status);
    const body = await response.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
    const raw = Array.isArray(body?.message) ? body.message.join('；') : body?.message;
    const message = typeof raw === 'string' && raw.length > 0 && raw.length <= 500 ? raw : undefined;
    const code = typeof body?.code === 'string' && body.code.length <= 100 ? body.code : undefined;
    return new CoreDialogueError(response.status, message, code);
  }
}

export class DialogueReadClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number, private readonly secret: string) {}

  readLessons(capability: string, query: LessonReadQuery): Promise<LessonReadResult> {
    return this.request('GET', '/tools/lessons', capability, query);
  }
  readAccount(capability: string, query: { accountId: string }): Promise<AccountReadResult> {
    return this.request('GET', '/tools/course-account-detail', capability, query);
  }
  readMonthlyReport(capability: string, query: { period: string }): Promise<MonthlyReportReadResult> {
    return this.request('GET', '/tools/monthly-report', capability, query);
  }
  readAccountLedger(capability: string, query: { accountId: string }): Promise<AccountLedgerReadResult> {
    return this.request('GET', '/tools/course-account-ledger', capability, query);
  }
  readMonthlyPayroll(capability: string, query: { period: string }): Promise<MonthlyPayrollReadResult> {
    return this.request('GET', '/tools/monthly-payroll', capability, query);
  }
  readDirectory(capability: string): Promise<DirectoryReadResult> {
    return this.request('GET', '/tools/directory', capability);
  }
  readArrearsAndFrozen(capability: string): Promise<ArrearsAndFrozenReadResult> {
    return this.request('GET', '/tools/arrears-frozen', capability);
  }
  readMonthlyConsumption(capability: string, query: { period: string }): Promise<MonthlyConsumptionReadResult> {
    return this.request('GET', '/tools/monthly-consumption', capability, query);
  }
  readPeriodPreclose(capability: string, query: { period: string }): Promise<PeriodPrecloseReadResult> {
    return this.request('GET', '/tools/period-preclose', capability, query);
  }
  checkActionAccess(capability: string, actionType: string): Promise<{ allowed: true }> {
    return this.request('GET', '/assistant-actions/access', capability, { actionType });
  }
  invalidatePreview(capability: string, previewId: string, reason: string): Promise<unknown> {
    return this.request('POST', `/assistant-actions/previews/${encodeURIComponent(previewId)}/invalidate`, capability, undefined, { reason });
  }
  readPreview(capability: string, previewId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/assistant-actions/previews/${encodeURIComponent(previewId)}`, capability);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, capability: string, query?: object, body?: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/u, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const authorization = `Bearer ${capability}`;
    const response = await fetch(url, {
      method,
      headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}), ...createSignedInternalRequestHeaders({ secret: this.secret, method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}), securityHeaders: { authorization } }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await CoreDialogueError.fromResponse(response);
    return await response.json() as T;
  }
}
