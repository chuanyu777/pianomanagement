import { randomUUID } from 'node:crypto';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseChatModel as BaseChatModelClass, type ChatResult } from '@langchain/core/language_models/chat_models';
import type { DialogueIntent } from '../src/graph/dialogue-intent.js';
import type { DialogueMultiStepPlan } from '../src/graph/dialogue-multi-step.js';
import { createDialogueRunExecutor } from '../src/worker/dialogue-executor.js';
import type { DialogueTaskStore } from '../src/persistence/task-store.js';
import type { AgentRunRecord } from '../src/persistence/repository.js';
import type { RunExecutionContext } from '../src/worker/run-worker.js';
import type { CoreToolClient, StructuredActionPreviewResponse } from '../src/tools/core-tool-client.js';
import type { DialogueReadClient } from '../src/tools/dialogue-tools.js';
import { vi } from 'vitest';

/**
 * These are orchestration-contract tests. They do not test natural-language
 * understanding: each test supplies an explicit, fixed intent JSON sequence.
 * The production model interpreter and dialogue executor still run unchanged.
 */

export const CAPABILITY_SUB = 'offline-audit-owner';
export const NOW = '2026-10-21T03:00:00.000Z';
export const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
export const ACCOUNT_ID_2 = '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b';
export const ACCOUNT_ID_3 = 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90';
export const STUDENT_ID = '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b';
export const TEACHER_ID = '33333333-3333-4333-8333-333333333333';
export const TEACHER_ID_3 = '9f0a3e6a-1ac9-4e41-8e64-62ca8df3a6b7';
export const LESSON_ID = '44444444-4444-4444-8444-444444444444';
export const PAYROLL_ID = '0e3b6a52-7d59-4c24-a6f8-6f7c9bdb8f11';

const lessons = [
  { lessonId: '77777777-7777-4777-8777-777777777777', startsAt: '2026-10-20T01:00:00.000Z', endsAt: '2026-10-20T02:00:00.000Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', statusLabel: '已完成' },
  { lessonId: '88888888-8888-4888-8888-888888888888', startsAt: '2026-10-21T01:00:00.000Z', endsAt: '2026-10-21T02:00:00.000Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' },
  { lessonId: '99999999-9999-4999-8999-999999999999', startsAt: '2026-10-21T05:00:00.000Z', endsAt: '2026-10-21T05:45:00.000Z', studentName: '林悦', courseName: '陪练', teacherName: '李老师', statusLabel: '待上课' },
  { lessonId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', startsAt: '2026-10-21T07:00:00.000Z', endsAt: '2026-10-21T08:00:00.000Z', studentName: '小雨', courseName: '主课', teacherName: '李老师', statusLabel: '已取消' },
  { lessonId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', startsAt: '2026-10-22T01:00:00.000Z', endsAt: '2026-10-22T02:00:00.000Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' },
  { lessonId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', startsAt: '2026-10-23T01:00:00.000Z', endsAt: '2026-10-23T02:00:00.000Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' },
];
const businessDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

function capability(threadId: string, runId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: CAPABILITY_SUB, role: 'OWNER', threadId, runId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `audit.${payload}.signature`;
}

class FixedJsonModel extends BaseChatModelClass {
  #plans: DialogueIntent[];
  #multiStepPlans: DialogueMultiStepPlan[];
  #index = 0;
  #multiStepIndex = 0;
  #remaining = 0;

  constructor(plans: DialogueIntent[], multiStepPlans: DialogueMultiStepPlan[] = []) { super({}); this.#plans = plans; this.#multiStepPlans = multiStepPlans; }

  _llmType(): string { return 'audit-fixed-json'; }

  async _generate(_messages: BaseMessage[], _options: this['ParsedCallOptions']): Promise<ChatResult> {
    const isMultiStepProbe = _messages.some(message => typeof message.content === 'string' && message.content.includes('两步任务识别节点'));
    if (isMultiStepProbe) {
      const plan = this.#multiStepPlans[this.#multiStepIndex];
      if (plan) this.#multiStepIndex += 1;
      const content = JSON.stringify(plan ?? null);
      return { generations: [{ text: content, message: new AIMessage(content) }] };
    }
    const plan = this.#plans[Math.min(this.#index, this.#plans.length - 1)];
    if (!plan) throw new Error('AUDIT_INTENT_PLAN_EXHAUSTED');
    if (this.#remaining === 0) this.#remaining = plan.mode === 'clarify' ? 2 : 1;
    this.#remaining -= 1;
    if (this.#remaining === 0) this.#index += 1;
    const content = JSON.stringify(plan);
    return { generations: [{ text: content, message: new AIMessage(content) }] };
  }
}

class MemoryTaskStore implements DialogueTaskStore {
  #states = new Map<string, unknown>();
  #actors = new Map<string, string>();

  async withTask<T>(input: { threadId: string; runId: string; actorKey: string }, work: (state: unknown) => Promise<{ state: unknown; result: T }>): Promise<T> {
    const previousActor = this.#actors.get(input.threadId);
    if (previousActor && previousActor !== input.actorKey) throw new Error('任务访问范围不匹配');
    this.#actors.set(input.threadId, input.actorKey);
    const outcome = await work(this.#states.get(input.threadId));
    this.#states.set(input.threadId, outcome.state);
    return outcome.result;
  }

  state(threadId: string): unknown { return this.#states.get(threadId); }
  close(): Promise<void> { return Promise.resolve(); }
}

function preview(actionType: string, command: Record<string, unknown> = {}): StructuredActionPreviewResponse {
  return {
    previewId: randomUUID(), actionType, command, display: { title: '操作预览', summary: '确认后才会执行。' },
    riskLevel: actionType.includes('payment') || actionType.includes('gift') || actionType.includes('refund') || actionType === 'student.final-refund' ? 'L2' : 'L1',
    expiresAt: '2026-10-21T03:05:00.000Z', auditEventId: randomUUID(),
  };
}

export type AuditToolOverrides = Partial<Record<keyof CoreToolClient | keyof DialogueReadClient, unknown>> & Partial<Record<'readDirectory' | 'readArrearsAndFrozen' | 'readMonthlyConsumption' | 'readPeriodPreclose', unknown>>;

export function createAuditHarness(plans: DialogueIntent[], overrides: AuditToolOverrides = {}, multiStepPlans: DialogueMultiStepPlan[] = []) {
  const calls = {
    getDashboardSummary: vi.fn(async () => ({ role:'OWNER' as const,businessDate: '2026-10-21', period: '2026-10', highlights: ['已结束未确认课程 1 节', '欠费学生：周宁（主课）', '冻结学生：赵一（超过31天未完成课程）', '待支付工资 2 笔', '本月经营收入 2670.00 元', '现金收入 3370.00 元，现金支出 3750.00 元，现金净额 -380.00 元', '经营利润 190.00 元'], todayLessons: { total: 3, scheduled: 1, completed: 1, cancelled: 1 }, todayEndedUnconfirmedCount:1,todayLessonItems: lessons.slice(1, 4), monthlyOperatingIncome: '2670.00', frozenStudentCount: 1, studentsWithNegativeBalanceCount: 1, unpaidPayrollCount: 2 })),
    getCourseAccountCandidates: vi.fn(async (_capability: string, query: { studentName: string; courseName?: string }) => {
      const candidates = [
        { accountId: ACCOUNT_ID, studentName: query.studentName, courseName: '主课' },
        { accountId: ACCOUNT_ID_3, studentName: query.studentName, courseName: '陪练' },
      ];
      return { candidates: query.courseName ? candidates.filter(item => item.courseName === query.courseName) : candidates };
    }),
    getTeacherCandidates: vi.fn(async () => ({ candidates: [{ teacherId: TEACHER_ID, name: '王老师' }] })),
    getStudentCandidates: vi.fn(async () => ({ candidates: [{ studentId: STUDENT_ID, name: '小林' }] })),
    getLessonCandidates: vi.fn(async () => ({ candidates: [{ lessonId: LESSON_ID, studentName: '林悦', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T01:00:00.000Z', status: 'SCHEDULED' }] })),
    getPayrollCandidates: vi.fn(async () => ({ candidates: [{ payrollId: PAYROLL_ID, teacherId: TEACHER_ID, teacherName: '王老师', period: '2026-10', status: 'GENERATED' }] })),
    createPaymentPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => ({ ...preview('course-account.payment', request), actionType: 'course-account.payment', display: { title: '课程交费', summary: '交费 ¥100.00', beforeBalance: { accountId: ACCOUNT_ID, paidBalance: '500.00', giftBalance: '80.00', totalBalance: '580.00' }, afterBalance: { accountId: ACCOUNT_ID, paidBalance: '600.00', giftBalance: '80.00', totalBalance: '680.00' } }, auditEventId: randomUUID() })),
    createGiftPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => ({ ...preview('course-account.gift', request), actionType: 'course-account.gift', display: { title: '课程赠送', summary: '赠送 ¥80.00', beforeBalance: { accountId: ACCOUNT_ID, paidBalance: '500.00', giftBalance: '80.00', totalBalance: '580.00' }, afterBalance: { accountId: ACCOUNT_ID, paidBalance: '500.00', giftBalance: '160.00', totalBalance: '660.00' } }, auditEventId: randomUUID() })),
    createSingleLessonPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => ({ ...preview('lesson.schedule.single', request), actionType: 'lesson.schedule.single', command: { accountId: request.accountId, teacherId: request.teacherId, startsAt: request.startsAt, endsAt: '2026-10-22T16:00:00.000Z' }, display: { title: '单节排课', summary: '确认后创建课程。' } })),
    createBatchLessonPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => ({ ...preview('lesson.schedule.weekly-batch', request), actionType: 'lesson.schedule.weekly-batch', command: { accountId: request.accountId, teacherId: request.teacherId, firstStartsAt: request.firstStartsAt, weeks: request.weeks, note: null }, display: { title: '批量排课', summary: '确认后创建课程。', lessons: [], conflicts: [] }, resourceVersions: {}, auditEventId: randomUUID() })),
    createFinalRefundPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => ({ ...preview('student.final-refund', request), actionType: 'student.final-refund', command: { studentId: request.studentId, feeAmount: request.feeAmount, channel: request.channel, occurredAt: NOW, note: request.note ?? null }, display: { title: '最终退学退款', summary: '确认后登记退款。', studentId: STUDENT_ID, studentName: '小林', studentStatusBefore: 'ENROLLED', studentStatusAfter: 'WITHDRAWN', totalPaidRefund: '500.00', feeAmount: String(request.feeAmount), feePercentage: '10.00', actualRefundAmount: '400.00', courses: [] }, resourceVersions: {}, auditEventId: randomUUID() })),
    createStructuredActionPreview: vi.fn(async (_capability: string, request: Record<string, unknown>) => preview(String(request.actionType), request.command as Record<string, unknown>)),
  };
  const readCalls = {
    readLessons: vi.fn(async (_capability: string, query: Record<string, unknown>) => ({ lessons: lessons.filter(item => { const day = businessDay.format(new Date(item.startsAt)); return (!query.dateFrom || day >= String(query.dateFrom)) && (!query.dateTo || day <= String(query.dateTo)) && (!query.teacherName || item.teacherName === query.teacherName) }), total: lessons.length })),
    readAccount: vi.fn(async (_capability: string, query: { accountId: string }) => query.accountId === ACCOUNT_ID_3
      ? ({ accountId: ACCOUNT_ID_3, studentName: '林悦', courseName: '陪练', paidBalance: '120.00', giftBalance: '20.00', totalBalance: '140.00', currentUnitPrice: '80.00' })
      : ({ accountId: ACCOUNT_ID, studentName: '林悦', courseName: '主课', paidBalance: '500.00', giftBalance: '80.00', totalBalance: '580.00', currentUnitPrice: '200.00' })),
    readDirectory: vi.fn(async () => ({
      students: [
        { studentId: STUDENT_ID, name: '小明', enrollmentStatus: 'STUDYING' },
        { studentId: ACCOUNT_ID_2, name: '小明', enrollmentStatus: 'STUDYING' },
      ],
      teachers: [{ teacherId: TEACHER_ID, name: '王老师', isActive: true }],
      courses: [
        { courseId: '55555555-5555-4555-8555-555555555555', name: '主课', defaultUnitPrice: '200.00', defaultDurationMinutes: 60, isActive: true },
        { courseId: '66666666-6666-4666-8666-666666666666', name: '陪练', defaultUnitPrice: '80.00', defaultDurationMinutes: 45, isActive: true },
      ],
    })),
    readArrearsAndFrozen: vi.fn(async () => ({
      arrears: [{ studentId: STUDENT_ID, studentName: '周宁', courseId: ACCOUNT_ID, courseName: '主课', paidBalance: '-10.00' }],
      frozenStudents: [{ studentId: ACCOUNT_ID_2, name: '赵一', reason: '连续31天未完成课程' }],
    })),
    readMonthlyConsumption: vi.fn(async () => ({
      period: '2026-10',
      totalAmount: '480.00',
      courses: [
        { id: '55555555-5555-4555-8555-555555555555', name: '主课', amount: '400.00' },
        { id: '66666666-6666-4666-8666-666666666666', name: '陪练', amount: '80.00' },
      ],
      teachers: [{ id: TEACHER_ID, name: '王老师', amount: '480.00' }],
      students: [{ id: STUDENT_ID, name: '林悦', amount: '480.00' }],
    })),
    readPeriodPreclose: vi.fn(async () => ({
      period: '2026-10',
      closed: false,
      pendingLessons: [{ lessonId: LESSON_ID, studentName: '林悦', courseName: '主课', teacherName: '王老师', endsAt: '2026-10-21T02:00:00.000Z' }],
      refundAnomalies: [],
      missingPayrollTeachers: [{ teacherId: TEACHER_ID, teacherName: '王老师' }],
      ledgerAnomalies: [],
      reminders: [{ code: 'CLOSING_SEVERITY_UNSPECIFIED', message: '关账异常的阻断与提示等级尚未定义，请由店主逐项判断。', requiresHumanJudgment: true as const }],
    })),
    readMonthlyReport: vi.fn(async () => ({ period:'2026-10', report:{ periodStart:'2026-10-01T00:00:00.000Z',cashIncome:'3370.00',cashExpense:'3750.00',cashNet:'-380.00',lessonIncome:'2500.00',refundFeeIncome:'150.00',manualIncome:'20.00',operatingIncome:'2670.00',payrollCost:'2200.00',giftCost:'180.00',manualExpense:'100.00',operatingExpense:'2480.00',operatingProfit:'190.00',cashOperatingGap:'570.00' } })),
    readAccountLedger: vi.fn(async () => ({ accountId:ACCOUNT_ID,entries:[
      { entryId:'a1111111-1111-4111-8111-111111111111',occurredAt:'2026-10-01T02:00:00.000Z',kind:'PAYMENT',amount:'500.00',paidDelta:'500.00',giftDelta:'0.00',note:'交费',operator:'店主' },
      { entryId:'a2222222-2222-4222-8222-222222222222',occurredAt:'2026-10-02T02:00:00.000Z',kind:'GIFT',amount:'80.00',paidDelta:'0.00',giftDelta:'80.00',note:'续费活动',operator:'店主' },
      { entryId:'a3333333-3333-4333-8333-333333333333',occurredAt:'2026-10-10T02:00:00.000Z',kind:'LESSON_CONSUMPTION',amount:'200.00',paidDelta:'-120.00',giftDelta:'-80.00',note:'课消 200.00',operator:'店主' },
    ] })),
    readMonthlyPayroll: vi.fn(async () => ({ period:'2026-10',payrolls:[] })),
    invalidatePreview: vi.fn(async () => ({})),
    readPreview: vi.fn(async () => ({ status: 'PENDING' })),
    checkActionAccess: vi.fn(async () => ({ allowed: true as const })),
  };
  const toolObject = { ...calls, ...readCalls, ...overrides } as unknown as CoreToolClient;
  const tasks = new MemoryTaskStore();
  const executor = createDialogueRunExecutor({ tasks, coreTools: toolObject, reads: toolObject as unknown as DialogueReadClient, model: new FixedJsonModel(plans, multiStepPlans) as unknown as BaseChatModel, now:()=>new Date(NOW), runTimeoutMs: 10_000 });
  const threadIds = new Map<string, string>();
  const messages = new Map<string, string[]>();
  const workspaces = new Map<string, unknown>();

  async function run(label: string, userMessage: string) {
    const threadId = threadIds.get(label) ?? randomUUID();
    threadIds.set(label, threadId);
    const runId = randomUUID();
    const run: AgentRunRecord = { runId, threadId, status: 'running', userMessage, capability: capability(threadId, runId) };
    const context: RunExecutionContext = {
      run,
      signal: AbortSignal.timeout(10_000),
      appendEvent: async event => { if (event.type === 'workspace.replace') workspaces.set(threadId, event.document); return { eventId: randomUUID(), event, createdAt: NOW }; },
      appendMessage: async input => { const list = messages.get(threadId) ?? []; list.push(input.content); messages.set(threadId, list); },
      updateRunWithEvent: async () => run,
    };
    try { await executor(context); return { answer: messages.get(threadId)?.at(-1) ?? '', workspace: workspaces.get(threadId), state: tasks.state(threadId) }; }
    catch (error) { return { error, answer: messages.get(threadId)?.at(-1) ?? '', workspace: workspaces.get(threadId), state: tasks.state(threadId) }; }
  }
  return { run, calls, readCalls, tasks };
}

export function intent(input: DialogueIntent): DialogueIntent { return input; }

export function newIntent(operation: DialogueIntent['operation'] | (string & {}), fields: Record<string, string | null> = {}, mode: DialogueIntent['mode'] = 'new'): DialogueIntent {
  // Allow an audit fixture to name a not-yet-wired production operation. The
  // serialized model response still passes through the production Zod parser.
  return { mode, operation: operation as DialogueIntent['operation'], fields, question: null };
}
