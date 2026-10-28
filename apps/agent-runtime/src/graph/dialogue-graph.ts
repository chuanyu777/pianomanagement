import { z } from 'zod';
import { WorkspaceDocumentSchema, protocolVersion, type WorkspaceDocument, type WorkspaceResultKind } from '@piano/assistant-protocol';
import type { CoreToolClient, PaymentPreviewRequest } from '../tools/core-tool-client.js';
import { CoreDialogueError, type DialogueReadClient, type LessonReadQuery, type LessonReadResult } from '../tools/dialogue-tools.js';
import { DialogueIntentSchema, type DialogueIntent, type UnderstandIntent } from './dialogue-intent.js';
import type { IntentParser } from './intent-parser.js';
import { refusalGuidance } from './refusal-messages.js';
import { resolveLessonDateRange } from './dialogue-calendar.js';
import { deterministicMultiStep, DialogueMultiStepPlanSchema, type DialogueMultiStepPlan, type UnderstandMultiStep } from './dialogue-multi-step.js';

const CandidateSchema = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), field: z.enum(['accountId', 'teacherId', 'lessonId', 'studentId', 'courseId', 'payrollId', 'entryId']), values: z.record(z.string(), z.string()) });
const TaskSchema = z.object({
  version: z.number().int().nonnegative().default(0),
  status: z.enum(['collecting', 'selecting', 'ready', 'awaiting_confirmation', 'completed', 'cancelled']).default('collecting'),
  operation: DialogueIntentSchema.shape.operation.default(null),
  fields: z.record(z.string(), z.string()).default({}),
  selected: z.record(z.string(), z.string()).default({}),
  candidates: z.array(CandidateSchema).default([]),
  references: z.array(CandidateSchema).default([]),
  previewId: z.string().optional(),
  executedPreviewId: z.string().optional(),
  lastRunId: z.string().optional(),
  lastUserMessage: z.string().optional(),
  answer: z.string().optional(),
  workspace: WorkspaceDocumentSchema.optional(),
  multiStep: z.object({ steps: DialogueMultiStepPlanSchema.shape.steps, currentStep: z.number().int().min(0).max(2), completedPreviewIds: z.array(z.string()) }).strict().optional(),
});
export type DialogueTask = z.infer<typeof TaskSchema>;
export type DialogueTurn = { runId: string; threadId: string; message: string; previous: unknown };
export type DialogueResult = { task: DialogueTask; answer: string; workspace: WorkspaceDocument };
type NewCoreReads = {
  readDirectory?: (capability: string) => Promise<{ students: Array<{ studentId: string; name: string; enrollmentStatus: string }>; teachers: Array<{ teacherId: string; name: string; isActive: boolean }>; courses: Array<{ courseId: string; name: string; defaultUnitPrice: string; defaultDurationMinutes: number; isActive: boolean }> }>;
  readArrearsAndFrozen?: (capability: string) => Promise<{ arrears: Array<{ studentId: string; studentName: string; courseId: string; courseName: string; paidBalance: string }>; frozenStudents: Array<{ studentId: string; name: string; reason: string }> }>;
  readMonthlyConsumption?: (capability: string, query: { period: string }) => Promise<{ period: string; totalAmount: string; courses: Array<{ id: string; name: string; amount: string }>; teachers: Array<{ id: string; name: string; amount: string }>; students: Array<{ id: string; name: string; amount: string }> }>;
  readPeriodPreclose?: (capability: string, query: { period: string }) => Promise<{ period: string; closed: boolean; pendingLessons: Array<{ lessonId: string; studentName: string; courseName: string; teacherName: string; endsAt: string }>; refundAnomalies: Array<{ refundId: string; studentName: string; issue: string }>; missingPayrollTeachers: Array<{ teacherId: string; teacherName: string }>; ledgerAnomalies: Array<{ entryId: string; kind: string; issue: string }>; reminders: Array<{ code: string; message: string; requiresHumanJudgment: true }> }>;
};
type Tools = Pick<CoreToolClient, 'getDashboardSummary' | 'getCourseAccountCandidates' | 'getTeacherCandidates' | 'getStudentCandidates' | 'getLessonCandidates' | 'getPayrollCandidates' | 'createPaymentPreview' | 'createGiftPreview' | 'createSingleLessonPreview' | 'createBatchLessonPreview' | 'createFinalRefundPreview' | 'createStructuredActionPreview'> & Pick<DialogueReadClient, 'readLessons' | 'readAccount' | 'readMonthlyReport' | 'readAccountLedger' | 'readMonthlyPayroll' | 'invalidatePreview' | 'readPreview' | 'checkActionAccess'> & NewCoreReads;
const channelNames: Record<string, PaymentPreviewRequest['channel']> = { '现金': 'CASH', '微信': 'WECHAT', '支付宝': 'ALIPAY', '银行卡': 'BANK_CARD', '其他': 'OTHER' };
const labels: Record<string, string> = { studentName: '学生', courseName: '课程', teacherName: '老师', amount: '金额', correctedUnitPrice:'正确课消金额', channel: '渠道', kind:'流水类型或收支方向',category:'收支分类',startsAt: '上课日期时间', targetStartsAt: '调整后的日期时间', occurredAt:'发生日期', feeAmount: '固定手续费', period: '业务月份', basis: '报表口径（现金、经营或对比）', baseSalary:'基本工资',commissionRate:'提成比例',bonusNote:'奖金说明',deductionNote:'代扣说明',reason: '原因', dateFrom: '查询起始日期', dateTo: '查询结束日期', name:'名称',notes:'备注',defaultUnitPrice:'课程默认单价',defaultDurationMinutes:'课程时长（分钟）',currentUnitPrice:'单节价格',isActive:'启用状态' };
const allowedFields = new Set(['studentName','courseName','teacherName','dateFrom','dateTo','date','startsAt','targetStartsAt','amount','correctedUnitPrice','channel','occurredAt','paidAt','note','feeAmount','period','basis','groupBy','kind','category','baseSalary','commissionRate','bonusAmount','bonusNote','deductionAmount','deductionNote','reason','weeks','status','name','notes','defaultUnitPrice','defaultDurationMinutes','isActive','currentUnitPrice']);
const recoveryCommands = new Set(['重试当前任务', '刷新当前结果', '重新生成预览']);

export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
function sourceLessonTimeSuffix(message: string, operation: DialogueTask['operation']): string | null {
  let source = message;
  if (operation === 'lesson.reschedule') {
    const targetMarker = source.search(/(?:改到|调整到|调到|改为|调整为)/u);
    if (targetMarker >= 0) source = source.slice(0, targetMarker);
  }
  const matches = [...source.matchAll(/(\d{1,2})点(?:(\d{1,2})分?)?/gu)];
  const stated = matches.at(-1);
  return stated ? `${stated[1]!.padStart(2, '0')}:${(stated[2] ?? '00').padStart(2, '0')}` : null;
}
function moneyText(value: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(value);
  if (!match) throw new CoreDialogueError(400);
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}
function absoluteDecimalText(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}
function rateText(value: string): string {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?%?$/u.exec(value.trim());
  if (!match) throw new CoreDialogueError(400);
  return `${match[1]}.${(match[2] ?? '').padEnd(4, '0')}`;
}
function dateTimeText(value: string | undefined, now: Date): string {
  if (!value) return now.toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value === businessDate(now) ? now.toISOString() : `${value}T00:00:00+08:00`;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new CoreDialogueError(400);
  return parsed.toISOString();
}
function chineseNumber(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (value === '十') return 10;
  const parts = value.split('十');
  if (parts.length === 2) {
    const tens = parts[0] ? digits[parts[0]] : 1;
    const ones = parts[1] ? digits[parts[1]] : 0;
    if (tens !== undefined && ones !== undefined) return tens * 10 + ones;
  }
  return value.length === 1 ? digits[value] : undefined;
}
function normalizeRelativeLessonTime(value: string, calendarDate: string): string {
  const match = /^(今天|明天|后天)?\s*(上午|中午|下午|晚上)?\s*([零一二三四五六七八九十两\d]{1,3})(?:点|时|:)(?:([零一二三四五六七八九十两\d]{1,3})分?)?$/u.exec(value.trim());
  if (!match) return value;
  let hour = chineseNumber(match[3]!);
  const minute = match[4] ? chineseNumber(match[4]) : 0;
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return value;
  if (['下午', '晚上'].includes(match[2] ?? '') && hour < 12) hour += 12;
  if (match[2] === '中午' && hour < 11) hour += 12;
  const [year, month, day] = calendarDate.split('-').map(Number);
  const offset = match[1] === '明天' ? 1 : match[1] === '后天' ? 2 : 0;
  const target = new Date(Date.UTC(year!, month! - 1, day! + offset));
  const date = target.toISOString().slice(0, 10);
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}
function normalizeMultiStepPlan(plan: DialogueMultiStepPlan, calendarDate: string): DialogueMultiStepPlan {
  return DialogueMultiStepPlanSchema.parse({
    steps: plan.steps.map(step => step.operation === 'lesson.schedule' && step.fields.startsAt
      ? { ...step, fields: { ...step.fields, startsAt: normalizeRelativeLessonTime(step.fields.startsAt, calendarDate) } }
      : step),
  });
}
function document(title: string, text: string, blocks: WorkspaceDocument['blocks'] = [], resultKind: WorkspaceResultKind = 'query'): WorkspaceDocument {
  return WorkspaceDocumentSchema.parse({ protocolVersion, resultKind, title, blocks: [{ type: 'summary', title, text }, ...blocks], sources: [] });
}
function finish(task: DialogueTask, runId: string, answer: string, workspace: WorkspaceDocument): DialogueResult {
  const result = { ...workspace, taskVersion: task.version };
  return { task: { ...task, lastRunId: runId, answer, workspace: result }, answer, workspace: result };
}
function ask(task: DialogueTask, runId: string, question: string): DialogueResult {
  task.status = 'collecting';
  return finish(task, runId, question, document('请补充信息', question, [], 'clarification'));
}
function isExecutedReceiptQuestion(message: string): boolean {
  return /(?:这|那)?笔(?:记录|业务|操作)?.*(?:还能|可以|怎么|是否)?.*(?:打开|查看|查询|回执|结果)|(?:查看|查询|打开).*(?:原记录|回执|执行结果)/u.test(message.trim());
}
function executedReceiptText(preview: Record<string, unknown>): string {
  const display = preview.display && typeof preview.display === 'object' ? preview.display as Record<string, unknown> : {};
  const title = typeof display.title === 'string' ? display.title : '原业务';
  const summary = typeof display.summary === 'string' ? display.summary : '';
  return `${title}已执行${summary ? `：${summary}` : ''}。原回执仍可查询，不会重复办理。`;
}
function choose(task: DialogueTask, runId: string, candidates: DialogueTask['candidates'], title: string): DialogueResult | undefined {
  if (candidates.length === 0) return ask(task, runId, `没有找到${title}，请核对姓名、课程或日期。`);
  if (candidates.length === 1) {
    const item = candidates[0]!; task.selected[item.field] = item.id; Object.assign(task.fields, item.values); task.candidates = []; return undefined;
  }
  task.candidates = candidates;
  task.status = 'selecting';
  return finish(task, runId, `找到了${candidates.length}个匹配对象，请选择${title}。`, document('请选择办理对象', '选择后继续当前任务，不会立即执行。', [{ type: 'entity-picker', title, candidates: candidates.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) })) }], 'selection'));
}
function requiredFields(operation: DialogueTask['operation']): string[] {
  switch (operation) {
    case 'lessons.read': return ['dateFrom', 'dateTo'];
    case 'accounts.read': case 'gift.preview': return operation === 'accounts.read' ? ['studentName'] : ['studentName', 'courseName', 'amount'];
    case 'ledger.read': return ['studentName', 'courseName'];
    case 'report.monthly': return ['period', 'basis'];
    case 'payroll.read': return ['period'];
    case 'consumption.read': return ['period'];
    case 'period.preclose.read': return ['period'];
    case 'student.create': return ['name'];
    case 'student.update': return ['studentName'];
    case 'teacher.create': return ['name','baseSalary','commissionRate'];
    case 'teacher.compensation.update': return ['teacherName','baseSalary','commissionRate'];
    case 'course.create': return ['name','defaultUnitPrice','defaultDurationMinutes'];
    case 'course.update': return ['courseName'];
    case 'course-account.open': return ['studentName','courseName'];
    case 'course-account.price': return ['studentName','courseName','currentUnitPrice'];
    case 'payment.preview': return ['studentName', 'courseName', 'amount', 'channel'];
    case 'ledger-entry.reversal': return ['studentName','courseName','reason'];
    case 'lesson.schedule': return ['studentName', 'courseName', 'teacherName', 'startsAt'];
    case 'lesson.reschedule': return ['targetStartsAt'];
    case 'lesson.complete.correction': return ['studentName','courseName','dateFrom','dateTo','correctedUnitPrice'];
    case 'refund.preview': return ['studentName', 'feeAmount', 'channel'];
    case 'payroll.generate': return ['teacherName','period'];
    case 'payroll.adjust': return ['teacherName','period'];
    case 'payroll.pay': return ['teacherName','period','channel'];
    case 'payroll.cancel-payment': return ['teacherName','period','reason'];
    case 'manual-transaction.create': return ['kind','category','amount','channel','occurredAt'];
    case 'period.close': return ['period'];
    case 'period.reopen': return ['period','reason'];
    default: return [];
  }
}

export function createDialogueGraph(input: { tools: Tools; capability: string; understand?: UnderstandIntent; intentParser?: IntentParser; understandMultiStep?: UnderstandMultiStep; now?: () => Date }) {
  type Prepared = { previous: DialogueTask; task: DialogueTask; alreadyExecuted: boolean; multiStepPlan?: DialogueMultiStepPlan; forcedIntent?: DialogueIntent };
  const loadContext = async (turn: DialogueTurn): Promise<{ prepared?: Prepared; result?: DialogueResult }> => {
    const parsed = TaskSchema.safeParse(turn.previous);
    const previous = parsed.success ? parsed.data : TaskSchema.parse({});
    if (previous.lastRunId === turn.runId && previous.workspace && previous.answer !== undefined) return { result: { task: previous, workspace: previous.workspace, answer: previous.answer } };
    const task: DialogueTask = { ...previous, fields: { ...previous.fields }, selected: { ...previous.selected }, candidates: [...previous.candidates], references: [...previous.references], version: previous.version + 1 };
    if (!recoveryCommands.has(turn.message.trim())) task.lastUserMessage = turn.message;
    if (previous.multiStep && previous.status === 'ready' && !previous.previewId && ['继续', '开始第一步', '开始办理'].includes(turn.message.trim())) {
      const step = previous.multiStep.steps[previous.multiStep.currentStep]!;
      return { prepared: { previous, task, alreadyExecuted: false, forcedIntent: { mode:'continue',operation:step.operation,fields:step.fields,question:null } } };
    }
    if (previous.multiStep && previous.status === 'awaiting_confirmation' && previous.previewId) {
      const preview = await input.tools.readPreview(input.capability, previous.previewId);
      if(['STALE','CANCELLED','EXPIRED'].includes(String(preview.status))){
        delete task.previewId;
        const withoutOldPreview={...previous};
        delete withoutOldPreview.previewId;
        withoutOldPreview.status='collecting';
        task.status='collecting';
        return {prepared:{previous:withoutOldPreview,task,alreadyExecuted:false}};
      }
      if (preview.status !== 'EXECUTED') {
        if (turn.message.trim() !== '取消当前办理') {
          return { result: finish(task, turn.runId, '当前步骤尚未在Core确认执行，暂不生成下一步预览。请先在浏览器确认当前预览，或取消整个办理。', previous.workspace ?? document('等待当前步骤确认', '下一步尚未生成。')) };
        }
      } else {
        const multiStep = { ...previous.multiStep, completedPreviewIds: [...previous.multiStep.completedPreviewIds, previous.previewId], currentStep: previous.multiStep.currentStep + 1 };
        if (multiStep.currentStep >= multiStep.steps.length) {
          task.multiStep = multiStep;
          task.executedPreviewId = previous.previewId;
          task.status = 'completed';
          return { result: finish(task, turn.runId, '两步办理均已分别在Core确认执行。', document('两步办理已完成', '两步业务均已由浏览器分别确认。')) };
        }
        const step = multiStep.steps[multiStep.currentStep]!;
        const nextFields={...step.fields};
        if((step.operation==='payment.preview'||step.operation==='payroll.pay')&&!nextFields.channel){
          const channel=['现金','微信','支付宝','银行卡','其他'].find(value=>turn.message.includes(value));
          if(channel)nextFields.channel=channel;
        }
        const sameAccount = previous.fields.studentName === step.fields.studentName && previous.fields.courseName === step.fields.courseName;
        task.multiStep = multiStep;
        task.operation = step.operation;
        task.fields = Object.fromEntries(Object.entries(nextFields).filter((entry): entry is [string, string] => entry[1] !== null));
        task.selected = sameAccount ? { accountId: previous.selected.accountId ?? '' } : {};
        if (!task.selected.accountId) delete task.selected.accountId;
        task.candidates = [];
        delete task.previewId;
        const withoutOldPreview = { ...previous };
        delete withoutOldPreview.previewId;
        return { prepared: { previous: withoutOldPreview, task, alreadyExecuted: false, forcedIntent: { mode:'continue', operation:step.operation, fields:nextFields, question:null } } };
      }
    }
    if (!previous.multiStep && previous.status === 'awaiting_confirmation' && previous.previewId) {
      const preview = await input.tools.readPreview(input.capability, previous.previewId);
      if (['STALE', 'CANCELLED', 'EXPIRED'].includes(String(preview.status))) {
        delete task.previewId;
        const withoutOldPreview = { ...previous };
        delete withoutOldPreview.previewId;
        withoutOldPreview.status = 'collecting';
        task.status = 'collecting';
        return { prepared: { previous: withoutOldPreview, task, alreadyExecuted: false } };
      }
      if (preview.status === 'EXECUTED') {
        task.executedPreviewId = previous.previewId;
        task.status = 'completed';
        if (isExecutedReceiptQuestion(turn.message)) {
          const answer = executedReceiptText(preview);
          return { result: finish(task, turn.runId, answer, document('业务回执', answer)) };
        }
        return { prepared: { previous: { ...previous, executedPreviewId: previous.previewId, status:'completed' }, task, alreadyExecuted: true } };
      }
    }
    const alreadyExecuted = !!previous.executedPreviewId;
    return { prepared: { previous, task, alreadyExecuted } };
  };
  const understandTurn = async (turn: DialogueTurn, prepared: Prepared, signal?: AbortSignal): Promise<{ intent?: DialogueIntent; result?: DialogueResult }> => {
    if (prepared.forcedIntent) return { intent: prepared.forcedIntent };
    if (/^选择候选:[^:]+:\d+$/u.test(turn.message)) return { intent: { mode:'continue', operation: prepared.task.operation, fields: {}, question:null } };
    if (turn.message.trim() === '取消当前办理') return { intent: { mode:'cancel', operation:null, fields:{}, question:null } };
    const userMessage = recoveryCommands.has(turn.message.trim()) ? prepared.previous.lastUserMessage : turn.message;
    if (!userMessage) return { result: ask(prepared.task, turn.runId, '没有可重试的请求，请重新说明要办理的事项。') };
    const calendarDate = businessDate(input.now?.() ?? new Date());
    const boundedPlan = !prepared.previous.multiStep ? deterministicMultiStep(userMessage, calendarDate) : null;
    if (boundedPlan) {
      prepared.multiStepPlan = normalizeMultiStepPlan(boundedPlan, calendarDate);
      const step = prepared.multiStepPlan.steps[0]!;
      return { intent:{ mode:'new',operation:step.operation,fields:step.fields,question:null } };
    }
    if (!prepared.previous.multiStep && input.understandMultiStep) {
      const candidate = await input.understandMultiStep({ userMessage, task: { operation:prepared.task.operation,fields:prepared.task.fields } }, signal);
      if (candidate) {
        const plan = normalizeMultiStepPlan(DialogueMultiStepPlanSchema.parse(candidate), calendarDate);
        prepared.multiStepPlan = plan;
        const step = plan.steps[0]!;
        return { intent: { mode:'new', operation:step.operation, fields:step.fields, question:null } };
      }
    }
    const context = { businessDate: calendarDate, task: { status:prepared.task.status,operation: prepared.task.operation, fields: prepared.task.fields, candidates: prepared.task.candidates, references: prepared.task.references, hasPreview: !!prepared.previous.previewId && !prepared.alreadyExecuted, alreadyExecuted: prepared.alreadyExecuted }, userMessage };
    if (input.intentParser) {
      const parsed = await input.intentParser(context, signal);
      if (parsed.kind === 'parsed') return { intent: parsed.intent };
      if (parsed.kind === 'unavailable') {
        return { result: finish(prepared.task, turn.runId, '助手暂时连不上理解服务，未执行任何业务。你可以先用结构化页面办理，或稍后重试。', document('助手暂不可用', '未执行任何业务。', [{ type:'error-recovery', code:'AI_UNAVAILABLE', message:'理解服务暂不可用，未执行任何业务。', actions:['refresh','open-structured-page'] }], 'error')) };
      }
      return { result: ask(prepared.task, turn.runId, '我没太听懂这句话要办什么。可以说得更具体一点，比如"查今天的课表"、"给某位学生交费"或"排一节课"。') };
    }
    if (!input.understand) return { result: finish(prepared.task, turn.runId, 'AI暂不可用，请使用人工办理入口。', document('AI暂不可用', '未执行任何业务。', [{ type: 'error-recovery', code: 'AI_UNAVAILABLE', message: '请稍后重试，或使用人工办理入口。', actions: ['open-structured-page'] }], 'error')) };
    return { intent: DialogueIntentSchema.parse(await input.understand(context, signal)) };
  };
  const process = async (turn: DialogueTurn, prepared: Prepared, intent: DialogueIntent): Promise<DialogueResult> => {
    const { previous } = prepared;
    let alreadyExecuted = prepared.alreadyExecuted;
    let { task } = prepared;
    const now = input.now?.() ?? new Date();
    const withdrawPreviousPreview = async (reason: string): Promise<void> => {
      if (!previous.previewId || task.previewId !== previous.previewId) return;
      try {
        await input.tools.invalidatePreview(input.capability, previous.previewId, reason);
      } catch (error) {
        if (!(error instanceof CoreDialogueError && error.status === 409)) throw error;
        const preview = await input.tools.readPreview(input.capability, previous.previewId);
        if (preview.status !== 'EXECUTED') throw error;
        alreadyExecuted = true;
        task.executedPreviewId = previous.previewId;
      }
      delete task.previewId;
    };
    try {
      const selection = /^选择候选:([^:]+):(\d+)$/u.exec(turn.message);
      if (selection) {
        if (Number(selection[2]) !== previous.version) return ask(task, turn.runId, '选择卡已失效，请根据当前候选重新选择。');
        const selected = task.candidates.find(item => item.id === selection[1]);
        if (!selected) return ask(task, turn.runId, '该对象不在当前授权候选中，请重新选择。');
        task.selected[selected.field] = selected.id; Object.assign(task.fields, selected.values); task.candidates = [];
      }
      if (alreadyExecuted && ['continue','correct','cancel'].includes(intent.mode)) return finish(task, turn.runId, '原业务已经确认执行，不能通过修改或取消对话撤回。请查询原记录，或另行发起允许的纠错业务。', document('原业务已执行', '没有追加或撤销任何业务记录。'));
      if (intent.mode === 'cancel') {
        await withdrawPreviousPreview('用户取消办理');
        if (alreadyExecuted) {
          task.status = 'completed';
          return finish(task, turn.runId, '原业务已经确认执行，不能通过修改或取消对话撤回。请查询原记录，或另行发起允许的纠错业务。', document('原业务已执行', '没有追加或撤销任何业务记录。'));
        }
        const executedPreviewId = task.executedPreviewId;
        const multiStep = task.multiStep;
        task = { ...TaskSchema.parse({}), version: task.version };
        if (executedPreviewId) task.executedPreviewId = executedPreviewId;
        if (multiStep) task.multiStep = multiStep;
        task.status = 'cancelled';
        return finish(task, turn.runId, '已取消当前待办理事项，未执行业务变更。', document('已取消办理', '待办理预览已失效；已经确认的业务不受影响。'));
      }
      if (task.multiStep && intent.operation && intent.operation !== task.multiStep.steps[task.multiStep.currentStep]?.operation) {
        return ask(task, turn.runId, `当前是第${task.multiStep.currentStep + 1}步；如需结束两步办理，请取消当前办理。`);
      }
      if (intent.mode === 'clarify' && !intent.operation) {
        const protectedAction = accessProbeForAmbiguousRequest(turn.message);
        if (protectedAction) await input.tools.checkActionAccess(input.capability, protectedAction);
        return ask(task, turn.runId, '请说明希望先查询或办理哪一项业务；当前尚未查询或执行任何记录。');
      }
      const clarificationQuestion=intent.mode==='clarify'&&intent.operation==='refund.preview'&&/%/u.test(turn.message)
        ? '退款手续费必须填写固定金额；百分比只在预览中根据固定金额换算显示，不能按百分比直接办理。请提供固定手续费金额。'
        : null;
      if (intent.mode === 'clarify') intent = { ...intent, mode: intent.operation === task.operation ? 'continue' : 'new' };
      if (previous.status === 'collecting' && previous.operation && intent.operation === previous.operation && intent.mode === 'new') {
        intent = { ...intent, mode:'continue' };
      }
      const changed = Object.entries(intent.fields).filter(([key]) => allowedFields.has(key));
      if (intent.mode === 'new') {
        await withdrawPreviousPreview('用户切换办理事项');
        const explicitlyRefersToPreviousLesson = /(?:这节|那节|它|刚才|上述|上面)(?:课)?/u.test(turn.message);
        task = { ...TaskSchema.parse({}), version: task.version, operation: intent.operation, ...(task.lastUserMessage ? {lastUserMessage:task.lastUserMessage} : {}), references: previous.operation === 'lessons.read' && explicitlyRefersToPreviousLesson ? previous.references : [] };
      } else {
        if (intent.mode === 'correct') await withdrawPreviousPreview('用户更正办理信息');
        task.operation = intent.operation ?? task.operation;
        if (intent.mode === 'correct' || changed.some(([key]) => ['studentName','courseName','teacherName','date','dateFrom','dateTo'].includes(key))) { task.selected = {}; task.candidates = []; }
      }
      for (const [key, value] of changed) { if (value === null) delete task.fields[key]; else task.fields[key] = value; }
      if (intent.mode === 'new' && previous.operation === 'accounts.read' && intent.operation === 'payment.preview' && previous.selected.accountId && previous.fields.studentName === task.fields.studentName && previous.fields.courseName === task.fields.courseName) {
        task.selected.accountId = previous.selected.accountId;
      }
      if (intent.fields.selectionId) {
        const candidate = [...previous.candidates, ...previous.references].find(item => item.id === intent.fields.selectionId);
        if (!candidate) return ask(task, turn.runId, '该对象不在当前授权候选中，请重新选择。');
        task.selected[candidate.field] = candidate.id; Object.assign(task.fields, candidate.values); task.candidates = [];
      }
      const f = task.fields;
      if (task.operation === 'lessons.read') {
        const resolved = resolveLessonDateRange(turn.message, businessDate(now));
        if (resolved.kind === 'ambiguous') return ask(task, turn.runId, '请补充具体范围，例如开始日期和结束日期。');
        if (resolved.kind === 'resolved') {
          f.dateFrom = resolved.dateFrom;
          f.dateTo = resolved.dateTo;
          delete f.date;
        }
      }
      if (task.operation === 'lessons.read' && f.date && !f.dateFrom) { f.dateFrom = f.date; f.dateTo = f.date; }
      if (!task.operation || task.operation === 'unsupported') {
        if (intent.question) return finish(task, turn.runId, intent.question, document('需要换个方式办理', intent.question, [], 'clarification'));
        if (/退款手续费.*(?:手工收入|收入)/u.test(turn.message)) return finish(task, turn.runId, '退款手续费由最终退款业务自动形成经营收入，不能再重复登记为手工收入。当前未生成任何预览。', document('不能重复登记退款手续费', '退款手续费应随最终退款自动入账；本次未写入任何业务数据。'));
        if (/退款.*手续费.*\d+(?:\.\d+)?%/u.test(turn.message)) return finish(task, turn.runId, '退款手续费必须填写固定金额；百分比只在预览中根据固定金额换算显示，不能按百分比直接办理。当前未生成任何预览。', document('请填写固定手续费', '请提供固定手续费金额；当前未写入任何业务数据。'));
        if (task.fields.reason==='跨课程抵扣欠费'||/退款.*(?:抵|冲).*(?:欠费)|(?:主课|陪练).*抵.*(?:主课|陪练).*欠费/u.test(turn.message)) return finish(task, turn.runId, '不同课程账户不能相互抵扣欠费；请先分别处理各课程余额。当前未生成退款预览。', document('不能跨课程抵扣', '各课程金额独立核算，当前未写入任何业务数据。'));
        if(task.fields.reason==='关账改日期绕过')return finish(task,turn.runId,'不能通过修改真实业务日期绕过关账。请填写实际发生日期；已关账月份如需补录，应先按规定重开账期。当前未生成任何预览。',document('不能绕过关账','系统保留真实业务日期，当前未写入任何业务数据。'));
        if (task.fields.reason==='工资不支持分批支付') return finish(task, turn.runId, '系统不支持工资分批支付；工资只能按工资记录的实发金额一次登记，当前未生成任何部分支付预览。', document('不支持工资分批支付', '请按工资记录的实发金额一次登记；本次未写入任何业务数据。'));
        if (task.fields.reason==='已关账工资不可调整') return finish(task, turn.runId, '已关账月份的工资不能直接修改；如需补发差额，请按当前开放月份登记经确认的工资调整，原历史工资保持不变。当前未生成预览。', document('不能修改已关账工资', '9月历史工资未修改，也未生成可执行预览。'));
        if (/直接.*(?:转账|打款).*退给/u.test(turn.message)) return finish(task, turn.runId, '系统不代替店主向家长转账；退款申请和实际付款在线下完成后，系统仅登记最终退款。当前未生成任何预览。', document('退款在线下办理', '系统只登记，不执行银行或第三方转账。'));
        return ask(task, turn.runId, '本期不支持这项自动化请求。可以改为指定周数的排课，或办理已支持的查询和预览；当前未执行业务。');
      }
      const actionTypeForAccess: Record<string,string> = { 'accounts.read':'course-account.read', 'payment.preview':'course-account.payment', 'gift.preview':'course-account.gift', 'refund.preview':'student.final-refund', 'lesson.schedule':f.weeks ? 'lesson.schedule.weekly-batch' : 'lesson.schedule.single' };
      if (!['lessons.read','overview.read','ledger.read','report.monthly','payroll.read','directory.read','arrears.read','consumption.read','period.preclose.read'].includes(task.operation)) await input.tools.checkActionAccess(input.capability, actionTypeForAccess[task.operation] ?? task.operation);
      if(clarificationQuestion)return ask(task,turn.runId,clarificationQuestion);
      if (['lesson.reschedule','lesson.cancel'].includes(task.operation) && !task.selected.lessonId && !f.studentName && (f.status === '已完成' || f.status === '已取消')) {
        const date = businessDate(now);
        const result = await input.tools.readLessons(input.capability, { dateFrom:date,dateTo:date,...(f.courseName ? {courseName:f.courseName}:{}), statusText:f.status });
        const choice = choose(task, turn.runId, lessonReferences(result.lessons), '要操作的课程');
        if (choice) return choice;
        if (f.status === '已完成') {
          return finish(task, turn.runId, `该课程已完成，不能普通${task.operation === 'lesson.reschedule' ? '调课' : '取消'}。店主如需纠错，应另行发起“撤销上课确认”，系统不会代为撤销。`, document('课程状态不允许此操作', '已完成课程不能直接调课或取消，当前未生成操作预览。'));
        }
        return finish(task, turn.runId, '该课程已取消，不能再次调课或取消。', document('课程状态不允许此操作', '已取消课程不能再次调课或取消，当前未生成操作预览。'));
      }
      if (task.operation === 'lesson.complete.correction' && !task.selected.lessonId && f.studentName && f.courseName && f.dateFrom && f.dateTo) {
        const result = await input.tools.readLessons(input.capability, { dateFrom:f.dateFrom,dateTo:f.dateTo,studentName:f.studentName,courseName:f.courseName,statusText:'已完成' });
        const choice = choose(task, turn.runId, lessonReferences(result.lessons), '要纠正的已完成课程');
        if (choice) return choice;
      }
      const missing = requiredFields(task.operation).filter(field => !f[field]);
      if (missing.length) {
        const retained = [f.studentName && `学生${f.studentName}`, f.courseName && `课程${f.courseName}`, f.teacherName && `老师${f.teacherName}`, f.amount && `金额${f.amount}`].filter(Boolean).join('、');
        return ask(task, turn.runId, `${retained ? `已保留：${retained}。` : ''}还需要补充：${missing.map(field => labels[field] ?? field).join('、')}。`);
      }
      if (task.operation === 'student.update' && !f.name && !f.phone && !f.notes) return ask(task, turn.runId, '请说明要修改学生姓名、电话或备注中的哪一项。');
      if (task.operation === 'course.update' && !f.name && !f.defaultUnitPrice && !f.defaultDurationMinutes && !f.isActive) return ask(task, turn.runId, '请说明要修改课程名称、默认单价、时长或启用状态中的哪一项。');
      if (task.operation === 'payroll.adjust') {
        if (!f.baseSalary && !f.commissionRate && !f.bonusAmount && !f.deductionAmount) return ask(task, turn.runId, '请说明要调整当月基本工资、提成比例、奖金或代扣中的哪一项及其数值。');
        if (f.bonusAmount && f.bonusAmount !== '0' && f.bonusAmount !== '0.00' && !f.bonusNote) return ask(task, turn.runId, '奖金大于零时请补充奖金说明。');
        if (f.deductionAmount && f.deductionAmount !== '0' && f.deductionAmount !== '0.00' && !f.deductionNote) return ask(task, turn.runId, '代扣大于零时请补充代扣说明。');
      }
      if (task.operation === 'manual-transaction.create' && f.channel === '其他' && !f.note) return ask(task, turn.runId, '渠道选择其他时，请补充渠道备注。');
      task.status = 'ready';

      if (task.operation === 'overview.read') {
        const summary = await input.tools.getDashboardSummary(input.capability);
        const ownerSummary = summary.role === 'OWNER' || summary.period !== undefined;
        const preclose = ownerSummary && summary.period && input.tools.readPeriodPreclose
          ? await input.tools.readPeriodPreclose(input.capability, { period:summary.period }) : undefined;
        const precloseIssueCount = preclose ? preclose.pendingLessons.length + preclose.refundAnomalies.length + preclose.missingPayrollTeachers.length + preclose.ledgerAnomalies.length : 0;
        const highlights = ownerSummary
          ? [
            `已结束未确认课程 ${summary.todayEndedUnconfirmedCount ?? 0} 节`,
            `欠费学生 ${summary.studentsWithNegativeBalanceCount ?? 0} 人`,
            `冻结学生 ${summary.frozenStudentCount ?? 0} 人`,
            `${summary.period} 待支付工资 ${summary.unpaidPayrollCount ?? 0} 笔`,
            `关账前异常 ${precloseIssueCount} 项${preclose?.reminders.length ? '（需人工判断）' : ''}`,
          ] : summary.highlights;
        task.status = 'completed';
        return finish(task, turn.runId, highlights.join('；'), document(`经营概况 · ${summary.businessDate}`, highlights.join('；')));
      }
      if (task.operation === 'report.monthly') {
        const result = await input.tools.readMonthlyReport(input.capability, { period: f.period! });
        const report = result.report;
        const answer = f.basis === '现金'
          ? `${result.period}实际收款${report.cashIncome}元，现金支出${report.cashExpense}元，现金净额${report.cashNet}元。`
          : f.basis === '经营'
            ? `${result.period}经营收入${report.operatingIncome}元（课消${report.lessonIncome}元、退款手续费${report.refundFeeIncome}元、其他经营收入${report.manualIncome}元），经营成本${report.operatingExpense}元（工资${report.payrollCost}元、赠送课消${report.giftCost}元、其他经营支出${report.manualExpense}元），经营利润${report.operatingProfit}元。`
            : `${result.period}现金口径：实际收款${report.cashIncome}元、现金支出${report.cashExpense}元、现金净额${report.cashNet}元；经营口径：经营收入${report.operatingIncome}元、经营成本${report.operatingExpense}元、经营利润${report.operatingProfit}元。现金净额与经营利润相差${report.cashOperatingGap}元，主要因为收款按到账确认，而课消、赠送成本和工资按经营发生确认。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document(`月报 · ${result.period}`, answer, [{ type: 'metric-grid', metrics: [
          { label: '现金收入', value: report.cashIncome, tone: 'positive' },
          { label: '现金支出', value: report.cashExpense, tone: 'warning' },
          { label: '现金净额', value: report.cashNet, tone: 'neutral' },
          { label: '经营收入', value: report.operatingIncome, tone: 'positive' },
          { label: '经营成本', value: report.operatingExpense, tone: 'warning' },
          { label: '课消收入', value: report.lessonIncome, tone: 'positive' },
          { label: '工资成本', value: report.payrollCost, tone: 'warning' },
          { label: '经营利润', value: report.operatingProfit, tone: 'neutral' },
        ] }]));
      }
      if (task.operation === 'payroll.read') {
        const result = await input.tools.readMonthlyPayroll(input.capability, { period: f.period! });
        const payrolls = f.teacherName ? result.payrolls.filter(item => item.teacherName === f.teacherName) : result.payrolls;
        const answer = `${result.period}共${payrolls.length}条工资记录。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document(`工资 · ${result.period}`, answer, [{ type: 'data-table', columns: [
          { key:'teacher',label:'老师' },{ key:'revenue',label:'课消业绩' },{ key:'base',label:'底薪' },{ key:'commission',label:'提成' },{ key:'bonus',label:'奖金' },{ key:'deduction',label:'代扣' },{ key:'gross',label:'应发' },{ key:'net',label:'实发' },{ key:'status',label:'状态' },
        ], rows: payrolls.map(item => ({ teacher:item.teacherName,revenue:item.courseRevenue,base:item.baseSalary,commission:`${item.commissionAmount}（${item.commissionRate}%）`,bonus:item.bonusAmount,deduction:item.deductionAmount,gross:item.grossSalary,net:item.netSalary,status:item.status==='UNPAID'?'未支付':item.status==='PAID'?'已支付':item.status })) }]));
      }
      if (task.operation === 'directory.read') {
        if (!input.tools.readDirectory) return ask(task, turn.runId, '基础资料目录读取尚未接入当前Agent，只能通过学生、课程结构化页面查询；未读取或修改任何资料。');
        const result = await input.tools.readDirectory(input.capability);
        const students = f.studentName ? result.students.filter(item => item.name.includes(f.studentName!)) : result.students;
        const teachers = f.teacherName ? result.teachers.filter(item => item.name.includes(f.teacherName!)) : result.teachers;
        const courses = f.courseName ? result.courses.filter(item => item.name.includes(f.courseName!)) : result.courses;
        if (f.studentName && students.length > 1) {
          return choose(task, turn.runId, students.map(item => ({ id:item.studentId,label:item.name,description:`学籍状态：${item.enrollmentStatus}`,field:'studentId' as const,values:{studentName:item.name} })), `${f.studentName}的同名学生资料`)!;
        }
        const duplicateStudents = [...new Set(students.map(item => item.name).filter((name, index, names) => names.indexOf(name) !== index))];
        const studentText = students.map(item => `${item.name}（${item.enrollmentStatus}）`).join('、') || '无学生';
        const teacherText = teachers.map(item => `${item.name}（${item.isActive ? '启用' : '停用'}）`).join('、') || '无老师';
        const courseText = courses.map(item => `${item.name} ${item.defaultDurationMinutes}分钟，默认${item.defaultUnitPrice}元`).join('；') || '无课程';
        const answer = `学生：${studentText}${duplicateStudents.length ? `；同名：${duplicateStudents.join('、')}` : ''}。老师：${teacherText}。课程：${courseText}。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document('基础资料', answer, [
          { type:'data-table', columns:[{ key:'name',label:'学生' },{ key:'status',label:'学籍状态' }], rows:students.map(item => ({ name:item.name,status:item.enrollmentStatus })) },
          { type:'data-table', columns:[{ key:'name',label:'老师' },{ key:'status',label:'状态' }], rows:teachers.map(item => ({ name:item.name,status:item.isActive ? '启用' : '停用' })) },
          { type:'data-table', columns:[{ key:'name',label:'课程' },{ key:'status',label:'状态' }], rows:courses.map(item => ({ name:item.name,status:item.isActive ? '启用' : '停用' })) },
        ]));
      }
      if (task.operation === 'arrears.read') {
        if (!input.tools.readArrearsAndFrozen) return ask(task, turn.runId, '欠费与冻结名单读取尚未接入当前Agent；未读取业务记录。');
        const result = await input.tools.readArrearsAndFrozen(input.capability);
        const arrearsText = result.arrears.map(item => `${item.studentName} ${item.courseName}实收${item.paidBalance}元`).join('；') || '无欠费课程账户';
        const frozenText = result.frozenStudents.map(item => `${item.name}（${item.reason}）`).join('；') || '无冻结学生';
        const answer = `欠费：${arrearsText}。冻结：${frozenText}。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document('课程欠费与冻结学生', answer, [
          { type:'data-table', columns:[{ key:'student',label:'学生' },{ key:'course',label:'课程' },{ key:'balance',label:'实收余额' }], rows:result.arrears.map(item => ({ student:item.studentName,course:item.courseName,balance:item.paidBalance })) },
          { type:'data-table', columns:[{ key:'student',label:'冻结学生' },{ key:'reason',label:'原因' }], rows:result.frozenStudents.map(item => ({ student:item.name,reason:item.reason })) },
        ]));
      }
      if (task.operation === 'consumption.read') {
        if (!input.tools.readMonthlyConsumption) return ask(task, turn.runId, '月度课消读取尚未接入当前Agent；未读取业务记录。');
        const result = await input.tools.readMonthlyConsumption(input.capability, { period:f.period! });
        const groupBy = f.groupBy ?? 'course';
        const group = groupBy === 'teacher' ? result.teachers : groupBy === 'student' ? result.students : result.courses;
        const groupLabel = groupBy === 'teacher' ? '老师' : groupBy === 'student' ? '学生' : '课程';
        const answer = `${result.period}${groupLabel}课消：${group.map(item => `${item.name} ${item.amount}元`).join('；') || '无记录'}；合计${result.totalAmount}元。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document(`月度课消 · ${result.period}`, answer, [{ type:'data-table', columns:[{ key:'name',label:groupLabel },{ key:'amount',label:'课消金额' }], rows:group.map(item => ({ name:item.name,amount:item.amount })) }]));
      }
      if (task.operation === 'period.preclose.read') {
        if (!input.tools.readPeriodPreclose) return ask(task, turn.runId, '关账预检读取尚未接入当前Agent；未读取业务记录。');
        const result = await input.tools.readPeriodPreclose(input.capability, { period:f.period! });
        const pendingText = result.pendingLessons.map(item => `${item.studentName}/${item.courseName}/${item.teacherName}`).join('、') || '无';
        const payrollText = result.missingPayrollTeachers.map(item => item.teacherName).join('、') || '无';
        const answer = `${result.period}${result.closed ? '已关账' : '未关账'}；待上课：${pendingText}；缺工资老师：${payrollText}；退款异常${result.refundAnomalies.length}项、流水异常${result.ledgerAnomalies.length}项。提醒需人工判断，不代表自动阻断关账。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document(`关账预检 · ${result.period}`, answer, [
          { type:'data-table', columns:[{ key:'student',label:'学生' },{ key:'course',label:'课程' },{ key:'teacher',label:'老师' },{ key:'endsAt',label:'下课时间' }], rows:result.pendingLessons.map(item => ({ student:item.studentName,course:item.courseName,teacher:item.teacherName,endsAt:formatTime(item.endsAt) })) },
          { type:'data-table', columns:[{ key:'student',label:'退款异常学生' },{ key:'issue',label:'异常' }], rows:result.refundAnomalies.map(item => ({ student:item.studentName,issue:item.issue })) },
          { type:'data-table', columns:[{ key:'teacher',label:'缺工资老师' }], rows:result.missingPayrollTeachers.map(item => ({ teacher:item.teacherName })) },
          { type:'data-table', columns:[{ key:'kind',label:'流水类型' },{ key:'issue',label:'异常' }], rows:result.ledgerAnomalies.map(item => ({ kind:item.kind,issue:item.issue })) },
          ...(result.reminders.length ? [{ type:'data-table' as const, columns:[{ key:'message',label:'人工检查提醒' }], rows:result.reminders.map(item => ({ message:`${item.message}（需人工判断）` })) }] : []),
        ]));
      }
      if (task.operation === 'lessons.read') {
        const filters = Object.fromEntries(Object.entries(f).flatMap(([key, value]) => key === 'status' ? [['statusText', value]] : ['dateFrom','dateTo','studentName','courseName','teacherName'].includes(key) ? [[key, value]] : [])) as LessonReadQuery;
        const { lessons } = await input.tools.readLessons(input.capability, filters);
        task.references = lessonReferences(lessons);
        const range = f.dateFrom === f.dateTo ? f.dateFrom : `${f.dateFrom} 至 ${f.dateTo}`;
        const details = lessons.map(lesson => `${lesson.studentName}/${lesson.courseName}/${lesson.teacherName}/${lesson.statusLabel}`).join('；');
        const answer = lessons.length === 0 ? `${range}没有排课。` : `${range}共${lessons.length}节课：${details}。`;
        const workspace = document(`排课 · ${range}`, answer, [{ type: 'data-table', columns: [{ key: 'time', label: '上课时间' }, { key: 'student', label: '学生' }, { key: 'course', label: '课程' }, { key: 'teacher', label: '老师' }, { key: 'status', label: '状态' }], rows: lessons.map(lesson => ({ time: `${formatTime(lesson.startsAt)} — ${formatTime(lesson.endsAt)}`, student: lesson.studentName, course: lesson.courseName, teacher: lesson.teacherName, status: lesson.statusLabel })) }]);
        workspace.sources = lessons.map(lesson => ({ type: 'lesson', id: lesson.lessonId, label: `${lesson.studentName} · ${formatTime(lesson.startsAt)}` }));
        task.status = 'completed';
        return finish(task, turn.runId, answer, workspace);
      }
      const accountOperations = ['accounts.read', 'ledger.read', 'payment.preview', 'gift.preview', 'ledger-entry.reversal', 'lesson.schedule', 'course-account.price'];
      if (task.operation === 'accounts.read' && !f.courseName) {
        const found = await input.tools.getCourseAccountCandidates(input.capability, { studentName:f.studentName!,match:'search' });
        if (found.candidates.length === 0) return ask(task, turn.runId, '没有找到该学生的课程账户，请核对学生姓名。');
        const accounts = await Promise.all(found.candidates.map(candidate => input.tools.readAccount(input.capability, { accountId:candidate.accountId })));
        const answer = accounts.map(account => `${account.courseName}：实收 ${account.paidBalance}，赠送 ${account.giftBalance}，总 ${account.totalBalance}，单价 ${account.currentUnitPrice}`).join('；');
        task.status = 'completed';
        return finish(task, turn.runId, `${f.studentName}各课程账户：${answer}。`, document(`课程账户 · ${f.studentName}`, '以下金额按课程分别读取。', [{ type:'data-table', columns:[{key:'course',label:'课程'},{key:'paid',label:'实收余额'},{key:'gift',label:'赠送余额'},{key:'total',label:'总余额'},{key:'price',label:'单节价格'}], rows:accounts.map(account => ({course:account.courseName,paid:account.paidBalance,gift:account.giftBalance,total:account.totalBalance,price:account.currentUnitPrice})) }]));
      }
      if (accountOperations.includes(task.operation) && !task.selected.accountId) {
        const found = await input.tools.getCourseAccountCandidates(input.capability, { studentName: f.studentName!, courseName: f.courseName!, match: 'search' });
        const result = choose(task, turn.runId, found.candidates.map(item => ({ id: item.accountId, label: `${item.studentName} · ${item.courseName}`, description: `账户 ${item.accountId.slice(-8)}`, field: 'accountId', values: { studentName: item.studentName, courseName: item.courseName } })), '学生课程账户'); if (result) return result;
      }
      if (task.operation === 'accounts.read') {
        const account = await input.tools.readAccount(input.capability, { accountId: task.selected.accountId! });
        task.status = 'completed';
        return finish(task, turn.runId, `${account.studentName}的${account.courseName}：实收 ${account.paidBalance}，赠送 ${account.giftBalance}，总 ${account.totalBalance}，单价 ${account.currentUnitPrice}。`, document(`课程账户 · ${account.studentName}`, '以下金额来自课程账户。', [{ type: 'data-table', columns: [{ key: 'course', label: '课程' },{ key: 'paid', label: '实收余额' },{ key: 'gift', label: '赠送余额' },{ key: 'total', label: '总余额' },{ key: 'price', label: '单节价格' }], rows: [{ course: account.courseName, paid: account.paidBalance, gift: account.giftBalance, total: account.totalBalance, price: account.currentUnitPrice }] }]));
      }
      if (task.operation === 'ledger.read') {
        const result = await input.tools.readAccountLedger(input.capability, { accountId: task.selected.accountId! });
        const entries = result.entries.filter(entry => {
          const occurredBusinessDate = businessDate(new Date(entry.occurredAt));
          return (!f.dateFrom || occurredBusinessDate >= f.dateFrom) && (!f.dateTo || occurredBusinessDate <= f.dateTo);
        });
        const account = await input.tools.readAccount(input.capability, { accountId:task.selected.accountId! });
        const kindLabels: Record<string,string> = { PAYMENT:'交费',GIFT:'赠送',LESSON_CONSUMPTION:'课消',PAYMENT_REVERSAL:'交费冲正',GIFT_REVERSAL:'赠送冲正',LESSON_CONSUMPTION_REVERSAL:'课消冲正',REFUND:'退款',GIFT_CLEARING:'赠送清零' };
        const entryText = entries.map(entry => {
          const label = kindLabels[entry.kind] ?? entry.kind;
          const amount = entry.amount;
          const split = entry.kind === 'LESSON_CONSUMPTION' && entry.paidDelta !== '0.00' && entry.giftDelta !== '0.00'
            ? `（赠送${absoluteDecimalText(entry.giftDelta)}元、实收${absoluteDecimalText(entry.paidDelta)}元）`
            : '';
          return `${businessDate(new Date(entry.occurredAt))} ${label} ${amount}元${split}${entry.operator ? `（经办人 ${entry.operator}）` : ''}`;
        }).join('；');
        const rangeText = f.dateFrom ? `${f.dateFrom.slice(0,7)} ` : '';
        const answer = `${rangeText}${f.studentName}的${f.courseName}流水：${entryText || '无记录'}；当前实收 ${account.paidBalance}，赠送 ${account.giftBalance}。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, document(`课程流水 · ${f.studentName}`, answer, [{ type:'ledger-detail', accountId:result.accountId, entries:entries.map(entry => ({ id:entry.entryId,occurredAt:entry.occurredAt,description:`${entry.kind}${entry.operator ? ` · ${entry.operator}` : ''}${entry.note ? ` · ${entry.note}` : ''}`,paidDelta:entry.paidDelta,giftDelta:entry.giftDelta })) }]));
      }
      if (task.operation === 'ledger-entry.reversal' && !task.selected.entryId) {
        const ledger = await input.tools.readAccountLedger(input.capability, { accountId:task.selected.accountId! });
        const expectedKind = f.kind?.includes('赠送') ? 'GIFT' : f.kind?.includes('交费') || f.kind?.includes('收款') ? 'PAYMENT' : undefined;
        const expectedAmount = f.amount ? moneyText(f.amount) : undefined;
        const eligible = ledger.entries.filter(entry => {
          if (entry.kind !== 'PAYMENT' && entry.kind !== 'GIFT') return false;
          if (expectedKind && entry.kind !== expectedKind) return false;
          const amount = entry.kind === 'PAYMENT' ? entry.paidDelta : entry.giftDelta;
          if (expectedAmount && amount !== expectedAmount) return false;
          const date = businessDate(new Date(entry.occurredAt));
          return (!f.date && !f.dateFrom || date >= (f.date ?? f.dateFrom!)) && (!f.dateTo || date <= f.dateTo);
        });
        const result = choose(task, turn.runId, eligible.map(entry => ({
          id:entry.entryId,
          label:`${businessDate(new Date(entry.occurredAt))} · ${entry.kind === 'PAYMENT' ? '交费' : '赠送'} · ${entry.kind === 'PAYMENT' ? entry.paidDelta : entry.giftDelta}元`,
          description:entry.note ?? `经办人 ${entry.operator}`,
          field:'entryId' as const,
          values:{},
        })), '要冲正的原流水');
        if (result) return result;
      }
      if (task.operation === 'student.update' || task.operation === 'course-account.open') {
        if (!task.selected.studentId) {
          const found = await input.tools.getStudentCandidates(input.capability, { studentName:f.studentName!,match:'search' });
          const result = choose(task, turn.runId, found.candidates.map(item => ({ id:item.studentId,label:item.name,field:'studentId',values:{ studentName:item.name } })), '学生');
          if (result) return result;
        }
      }
      if (task.operation === 'course.update' || task.operation === 'course-account.open') {
        if (!task.selected.courseId) {
          if (!input.tools.readDirectory) return ask(task, turn.runId, '当前Agent没有安全的课程ID候选读取能力，无法识别该课程；未生成预览。');
          const directory = await input.tools.readDirectory(input.capability);
          const query = f.courseName!.trim().toLocaleLowerCase();
          const courses = directory.courses.filter(item => item.name.toLocaleLowerCase().includes(query));
          const result = choose(task, turn.runId, courses.map(item => ({ id:item.courseId,label:item.name,field:'courseId',values:{ courseName:item.name } })), '课程');
          if (result) return result;
        }
      }
      if (task.operation === 'teacher.compensation.update' && !task.selected.teacherId) {
        const found = await input.tools.getTeacherCandidates(input.capability, { teacherName:f.teacherName!,match:'search' });
        const result = choose(task, turn.runId, found.candidates.map(item => ({ id:item.teacherId,label:item.name,field:'teacherId',values:{ teacherName:item.name } })), '老师');
        if (result) return result;
      }
      if (task.operation === 'student.update' && !task.selected.studentId) return ask(task, turn.runId, '没有从Core候选中取得学生ID，无法安全修改资料。');
      const keys = { idempotencyKey: turn.runId, requestId: turn.runId };
      if (task.operation === 'payment.preview' || task.operation === 'gift.preview') {
        const amount = moneyText(f.amount!);
        const base = { ...keys, accountId: task.selected.accountId!, amount, occurredAt: dateTimeText(f.occurredAt, now), ...(f.note ? { note: f.note } : {}) };
        const channel = channelNames[f.channel ?? ''] ?? Object.values(channelNames).find(value => value === f.channel);
        if (task.operation === 'payment.preview' && !channel) return ask(task, turn.runId, '请选择实际收款渠道：现金、微信、支付宝、银行卡或其他。');
        if (channel === channelNames['其他'] && !f.note) return ask(task, turn.runId, '渠道选择其他时，请补充渠道备注。');
        await withdrawPreviousPreview('生成替代预览');
        const preview = task.operation === 'payment.preview' ? await input.tools.createPaymentPreview(input.capability, { ...base, channel: channel! }) : await input.tools.createGiftPreview(input.capability, base);
        task.previewId = preview.previewId;
        task.status = 'awaiting_confirmation';
        const display = preview.display;
        return finish(task, turn.runId, '已生成预览，尚未登记。请核对后点击确认。', document(`${task.operation === 'payment.preview' ? '交费' : '赠送'}预览 · ${f.studentName}`, display.summary, [{ type: 'data-table', columns: [{ key: 'field', label: '项目' },{ key: 'value', label: '内容' }], rows: [{ field: '课程', value: f.courseName! }, { field: '金额', value: amount }, ...(channel ? [{ field: '渠道', value: f.channel! }] : []), { field: '实收余额', value: `${display.beforeBalance.paidBalance} → ${display.afterBalance.paidBalance}` }, { field: '赠送余额', value: `${display.beforeBalance.giftBalance} → ${display.afterBalance.giftBalance}` }] }, actionBlock(preview, 'L2')], 'preview'));
      }
      if (task.operation === 'lesson.schedule') {
        if (!task.selected.teacherId) {
          const found = await input.tools.getTeacherCandidates(input.capability, { teacherName: f.teacherName!, match: 'search' });
          const result = choose(task, turn.runId, found.candidates.map(item => ({ id: item.teacherId, label: item.name, description: `教师 ${item.teacherId.slice(-8)}`, field: 'teacherId', values: { teacherName: item.name } })), '授课老师'); if (result) return result;
        }
        await withdrawPreviousPreview('生成替代预览');
        const common = { ...keys, accountId: task.selected.accountId!, teacherId: task.selected.teacherId!, ...(f.note ? { note: f.note } : {}) };
        const preview = f.weeks ? await input.tools.createBatchLessonPreview(input.capability, { ...common, firstStartsAt: f.startsAt!, weeks: Number(f.weeks) }) : await input.tools.createSingleLessonPreview(input.capability, { ...common, startsAt: f.startsAt! });
        task.previewId = preview.previewId;
        task.status = 'awaiting_confirmation';
        return finish(task, turn.runId, '已生成排课预览，尚未创建课程。', document('排课预览', preview.display.summary, [{ type: 'data-table', columns: [{ key: 'field', label: '项目' },{ key: 'value', label: '内容' }], rows: [{ field: '学生 / 课程', value: `${f.studentName} / ${f.courseName}` }, { field: '老师', value: f.teacherName! }, { field: '首节时间', value: formatTime(f.startsAt!) }] }, actionBlock(preview, 'L1')], 'preview'));
      }
      if (task.operation.startsWith('lesson.')) {
        if (!task.selected.lessonId) {
          let candidates = task.references;
          if (f.studentName) {
            const result = await input.tools.getLessonCandidates(input.capability, { studentName: f.studentName, match: 'search', ...(f.date || f.dateFrom ? { date: f.date ?? f.dateFrom! } : {}) });
            const timeSuffix = sourceLessonTimeSuffix(turn.message, task.operation);
            candidates = result.candidates
              .filter(item => !f.courseName || item.courseName === f.courseName)
              .filter(item => !timeSuffix || formatTime(item.startsAt).endsWith(timeSuffix))
              .map(item => ({ id: item.lessonId, label: `${item.studentName} · ${item.courseName}`, description: `${formatTime(item.startsAt)} · ${item.teacherName} · ${item.status}`, field: 'lessonId', values: { studentName: item.studentName, courseName: item.courseName } }));
          }
          const result = choose(task, turn.runId, candidates, '要操作的课程'); if (result) return result;
        }
        const preview = await input.tools.createStructuredActionPreview(input.capability, { ...keys, actionType: task.operation, command: { lessonId: task.selected.lessonId, ...(f.targetStartsAt ? { targetStartsAt: f.targetStartsAt } : {}), ...(f.correctedUnitPrice ? { correctedUnitPrice:moneyText(f.correctedUnitPrice) } : {}), ...(f.reason || f.note ? { reason: f.reason ?? f.note } : {}) } });
        task.previewId = preview.previewId;
        task.status = 'awaiting_confirmation';
        return finish(task, turn.runId, '已生成操作预览，尚未执行。请核对后确认。', structuredDocument(preview));
      }
      if (task.operation === 'refund.preview') {
        if (!task.selected.studentId) {
          const found = await input.tools.getStudentCandidates(input.capability, { studentName: f.studentName!, match: 'search' });
          const result = choose(task, turn.runId, found.candidates.map(item => ({ id: item.studentId, label: item.name, field: 'studentId', values: { studentName: item.name } })), '退款学生'); if (result) return result;
        }
        const channel = channelNames[f.channel ?? '']; if (!channel) return ask(task, turn.runId, '请补充实际退款渠道。');
        await withdrawPreviousPreview('生成替代预览');
        const preview = await input.tools.createFinalRefundPreview(input.capability, { ...keys, studentId: task.selected.studentId!, feeAmount: moneyText(f.feeAmount!), channel, occurredAt: f.occurredAt ?? now.toISOString(), ...(f.note ? { note: f.note } : {}) });
        task.previewId = preview.previewId;
        task.status = 'awaiting_confirmation';
        return finish(task, turn.runId, `已生成${f.studentName}的最终退学退款预览，尚未登记退款。`, document('最终退学退款', preview.display.summary, [{ type: 'metric-grid', metrics: [{ label: '应退本金', value: preview.display.totalPaidRefund, tone: 'neutral' },{ label: '固定手续费', value: `${preview.display.feeAmount}（${preview.display.feePercentage}%）`, tone: 'warning' },{ label: '实际退款', value: preview.display.actualRefundAmount, tone: 'warning' }] }, { type: 'alert-list', alerts: preview.display.courses.map(course => ({ severity: 'warning', title: course.courseName, detail: `实收退款${course.paidRefundAmount}，赠送清零${course.giftClearingAmount}；确认后退学。` })) }, actionBlock(preview, 'L2')], 'preview'));
      }
      if (task.operation.startsWith('payroll.')) {
        if (!task.selected.teacherId) {
          const found = await input.tools.getTeacherCandidates(input.capability, { teacherName: f.teacherName!, match: 'search' });
          const result = choose(task, turn.runId, found.candidates.map(item => ({ id: item.teacherId, label: item.name, field: 'teacherId', values: { teacherName: item.name } })), '工资老师'); if (result) return result;
        }
        if ((task.operation === 'payroll.adjust' || task.operation === 'payroll.pay' || task.operation === 'payroll.cancel-payment') && !task.selected.payrollId) {
          const found = await input.tools.getPayrollCandidates(input.capability, { teacherName: f.teacherName!, period: f.period! });
          const eligible = task.operation === 'payroll.cancel-payment' ? found.candidates.filter(item => item.status === 'PAID') : found.candidates;
          const result = choose(task, turn.runId, eligible.map(item => ({ id: item.payrollId, label: `${item.teacherName} · ${item.period}`, description:item.status, field: 'payrollId', values: {} })), task.operation === 'payroll.cancel-payment' ? '已支付工资记录' : '工资记录'); if (result) return result;
        }
      }
      const actionType = task.operation;
      await withdrawPreviousPreview('生成替代预览');
      let command: Record<string, unknown>;
      switch (task.operation) {
        case 'student.create': command = { name:f.name, ...(f.phone ? { phone:f.phone } : {}), ...(f.notes ? { notes:f.notes } : {}) }; break;
        case 'student.update': command = { studentId:task.selected.studentId, ...(f.name ? { name:f.name } : {}), ...(f.phone !== undefined ? { phone:f.phone } : {}), ...(f.notes !== undefined ? { notes:f.notes } : {}) }; break;
        case 'teacher.create': command = { name:f.name, baseSalary:moneyText(f.baseSalary!), commissionRate:rateText(f.commissionRate!) }; break;
        case 'teacher.compensation.update': command = { teacherId:task.selected.teacherId, baseSalary:moneyText(f.baseSalary!), commissionRate:rateText(f.commissionRate!) }; break;
        case 'course.create': command = { name:f.name, defaultUnitPrice:moneyText(f.defaultUnitPrice!), defaultDurationMinutes:Number(f.defaultDurationMinutes) }; break;
        case 'course.update': command = { courseId:task.selected.courseId, ...(f.name ? { name:f.name } : {}), ...(f.defaultUnitPrice ? { defaultUnitPrice:moneyText(f.defaultUnitPrice) } : {}), ...(f.defaultDurationMinutes ? { defaultDurationMinutes:Number(f.defaultDurationMinutes) } : {}), ...(f.isActive ? { isActive:f.isActive === 'true' } : {}) }; break;
        case 'course-account.open': command = { studentId:task.selected.studentId, courseId:task.selected.courseId, ...(f.currentUnitPrice ? { currentUnitPrice:moneyText(f.currentUnitPrice) } : {}) }; break;
        case 'course-account.price': command = { accountId:task.selected.accountId, currentUnitPrice:moneyText(f.currentUnitPrice!) }; break;
        case 'ledger-entry.reversal': {
          const account = await input.tools.readAccount(input.capability, { accountId:task.selected.accountId! });
          command = { entryId:task.selected.entryId, accountVersion:account.version, occurredAt:now.toISOString(), reason:f.reason, ...(f.note ? { note:f.note } : {}) };
          break;
        }
        case 'payroll.generate': command = { teacherId:task.selected.teacherId,period:f.period }; break;
        case 'payroll.adjust': command = { payrollId:task.selected.payrollId, ...(f.baseSalary ? {baseSalary:moneyText(f.baseSalary)}:{}), ...(f.commissionRate ? {commissionRate:rateText(f.commissionRate)}:{}), ...(f.bonusAmount ? {bonusAmount:moneyText(f.bonusAmount),bonusNote:f.bonusNote}:{}), ...(f.deductionAmount ? {deductionAmount:moneyText(f.deductionAmount),deductionNote:f.deductionNote}:{}) }; break;
        case 'payroll.pay': command = { payrollId:task.selected.payrollId,channel:channelNames[f.channel!] ?? f.channel,paidAt:dateTimeText(f.paidAt,now),...(f.note ? {note:f.note}:{}) }; break;
        case 'payroll.cancel-payment': command = { payrollId:task.selected.payrollId, reason:f.reason, ...(f.note ? { note:f.note } : {}) }; break;
        case 'manual-transaction.create': command = { kind:f.kind,category:f.category,amount:moneyText(f.amount!),channel:channelNames[f.channel!] ?? f.channel,occurredAt:dateTimeText(f.occurredAt,now),...(f.note ? {note:f.note}:{}) }; break;
        case 'period.close': command = { period:f.period }; break;
        case 'period.reopen': command = { period:f.period,reason:f.reason }; break;
        default: command = { ...f, ...task.selected, ...(f.channel ? { channel: channelNames[f.channel] ?? f.channel } : {}) };
      }
      const preview = await input.tools.createStructuredActionPreview(input.capability, { ...keys, actionType, command });
      task.previewId = preview.previewId;
      task.status = 'awaiting_confirmation';
      const previewSubject = task.operation === 'student.create' ? `学生${f.name}`
        : task.operation === 'teacher.create' ? `教师${f.name}（不会创建登录账号）`
        : task.operation === 'manual-transaction.create' ? `${f.category}${moneyText(f.amount!)}元`
          : f.studentName ?? f.teacherName ?? f.courseName ?? '';
      return finish(task, turn.runId, `已生成${previewSubject ? `${previewSubject}的` : ''}操作预览，尚未执行。`, structuredDocument(preview));
    } catch (error) {
      const message = error instanceof CoreDialogueError ? error.message : error instanceof z.ZodError ? '业务参数不完整或不合法，请核对后再试' : 'AI处理暂时失败，请稍后重试。未确认的业务不会自动执行。';
      const recovery: WorkspaceDocument['blocks'][number] = { type: 'error-recovery', code: error instanceof CoreDialogueError ? `CORE_${error.status}` : error instanceof z.ZodError ? 'CORE_400' : 'AI_PROCESS_FAILED', message, actions: ['refresh', 'open-structured-page'] };
      const workspace = task.previewId && task.workspace ? { ...task.workspace, resultKind: 'error' as const, blocks: [...task.workspace.blocks, recovery] } : document('暂时无法完成', message, [recovery], 'error');
      return finish(task, turn.runId, message, workspace);
    }
  };
  const failure = (turn: DialogueTurn, task: DialogueTask, error: unknown) => {
    const message = error instanceof CoreDialogueError
      ? (refusalGuidance(error.code, error.status) ?? error.message)
      : 'AI处理暂时失败，请稍后重试。未确认的业务不会自动执行。';
    const recovery: WorkspaceDocument['blocks'][number] = { type:'error-recovery', code: error instanceof CoreDialogueError ? `CORE_${error.status}` : 'AI_PROCESS_FAILED', message, actions:['refresh','open-structured-page'] };
    const workspace = task.previewId && task.workspace ? { ...task.workspace, resultKind: 'error' as const, blocks:[...task.workspace.blocks, recovery] } : document('暂时无法完成', message, [recovery], 'error');
    return { result: finish(task, turn.runId, message, workspace) };
  };
  const runTurn = async (turn: DialogueTurn, signal?: AbortSignal): Promise<{ result: DialogueResult }> => {
    let prepared: Prepared;
    try {
      const loaded = await loadContext(turn);
      if (loaded.result) return { result: loaded.result };
      if (!loaded.prepared) throw new Error('对话上下文缺失');
      prepared = loaded.prepared;
    } catch (error) {
      const parsed = TaskSchema.safeParse(turn.previous);
      const previous = parsed.success ? parsed.data : TaskSchema.parse({});
      return { result: failure(turn, { ...previous, version: previous.version + 1 }, error).result };
    }

    let intent: DialogueIntent;
    try {
      const understood = await understandTurn(turn, prepared, signal);
      if (understood.result) return { result: understood.result };
      if (!understood.intent) throw new Error('意图缺失');
      intent = understood.intent;
    } catch (error) {
      return { result: failure(turn, prepared.task, error).result };
    }

    try {
      if (prepared.multiStepPlan) {
        const plan = prepared.multiStepPlan;
        const first = plan.steps[0]!;
        const second = plan.steps[1]!;
        const task = prepared.task;
        task.operation = first.operation;
        task.fields = Object.fromEntries(Object.entries(first.fields).filter((entry): entry is [string,string] => entry[1] !== null));
        task.multiStep = { steps:plan.steps,currentStep:0,completedPreviewIds:[] };
        task.status = 'ready';
        const name = (operation: string) => operation === 'payment.preview' ? '交费'
          : operation === 'gift.preview' ? '赠送'
            : operation === 'lesson.schedule' ? '排课'
              : operation === 'ledger-entry.reversal' ? '冲正原流水'
                : operation === 'payroll.cancel-payment' ? '撤销原工资支付' : '重新登记工资支付';
        const describe = (step: typeof first) => `${name(step.operation)}${step.fields.courseName ? `（${step.fields.courseName}` : '（'}${step.fields.amount ? `${moneyText(step.fields.amount)}元` : ''}${step.fields.startsAt ? `，${step.fields.startsAt}` : ''}${step.fields.channel ? `，${step.fields.channel}` : ''}）`;
        const untouched = first.fields.courseName === second.fields.courseName && first.operation === 'payment.preview' && second.operation === 'gift.preview' ? '其他课程（如陪练）不会改动。' : '';
        const statedTotal = /(?:收|合计)(\d+(?:\.\d{1,2})?)元/u.exec(turn.message)?.[1];
        const totalText = statedTotal && first.operation === 'payment.preview' && second.operation === 'payment.preview' ? `原请求总额${moneyText(statedTotal)}元；` : '';
        const answer = `已拆为按顺序分别确认的两步：${totalText}第一步${describe(first)}；第二步${describe(second)}。${untouched}回复“开始第一步”后才生成第一步预览，当前尚未执行。`;
        return { result: finish(task, turn.runId, answer, document('两步办理计划', answer, [], 'clarification')) };
      }
      return { result: await process(turn, prepared, intent) };
    } catch (error) {
      return { result: failure(turn, prepared.task, error).result };
    }
  };

  return {
    invoke: async (state: { turn: DialogueTurn }, config?: { signal?: AbortSignal }) =>
      runTurn(state.turn, config?.signal ?? new AbortController().signal),
  };
}

function lessonReferences(lessons: LessonReadResult['lessons']): DialogueTask['references'] {
  return lessons.map(item => ({ id: item.lessonId, label: `${item.studentName} · ${item.courseName}`, description: `${formatTime(item.startsAt)} · ${item.teacherName} · ${item.statusLabel}`, field: 'lessonId', values: { studentName: item.studentName, courseName: item.courseName, status:item.statusLabel } }));
}

function accessProbeForAmbiguousRequest(message: string): string | undefined {
  if (/撤销.*(?:上课确认|课消)|撤回.*(?:上课确认|课消)/u.test(message)) return 'lesson.complete.reversal';
  if (/退费|退款/u.test(message)) return 'student.final-refund';
  if (/交费|收款/u.test(message)) return 'course-account.payment';
  if (/赠送/u.test(message)) return 'course-account.gift';
  if (/工资/u.test(message)) return 'payroll.generate';
  if (/关账/u.test(message)) return 'period.close';
  return undefined;
}
function actionBlock(preview: { previewId: string; actionType: string; expiresAt: string; display: { title?: string | undefined }; riskLevel?: 'L1' | 'L2' | undefined }, expectedRisk: 'L1' | 'L2'): WorkspaceDocument['blocks'][number] {
  if (!preview.riskLevel || preview.riskLevel !== expectedRisk) throw new Error('CORE_RISK_METADATA_INVALID');
  return { type: 'action-preview', previewId: preview.previewId, actionType: preview.actionType, title: preview.display.title ?? '核对操作', schemaVersion: `${preview.actionType}.v1`, riskLevel: preview.riskLevel, expiresAt: preview.expiresAt };
}
function structuredDocument(preview: Awaited<ReturnType<CoreToolClient['createStructuredActionPreview']>>): WorkspaceDocument {
  const labels: Record<string, string> = { studentName:'学生',courseName:'课程',teacherName:'老师',startsAt:'上课时间',endsAt:'下课时间',previousStartsAt:'原上课时间',previousEndsAt:'原下课时间',unitPrice:'单节价格',paidBalanceBefore:'原实收余额',giftBalanceBefore:'原赠送余额',paidConsumed:'扣减实收',giftConsumed:'扣减赠送',paidBalanceAfter:'调整后实收余额',giftBalanceAfter:'调整后赠送余额',period:'月份',amount:'金额',baseSalary:'底薪',commissionAmount:'提成',grossSalary:'应发',netSalary:'实发',reason:'原因' };
  const rows = Object.entries(labels).flatMap(([key, field]) => typeof preview.display[key] === 'string' ? [{ field, value: key.endsWith('At') ? formatTime(preview.display[key]) : preview.display[key] }] : []);
  if (!preview.riskLevel) throw new Error('CORE_RISK_METADATA_MISSING');
  return document(preview.display.title ?? '操作预览', preview.display.summary ?? '请核对对象与变更，确认后才生效。', [{ type: 'data-table', columns: [{ key: 'field', label:'项目' },{ key:'value',label:'内容' }], rows }, actionBlock(preview, preview.riskLevel)], 'preview');
}
