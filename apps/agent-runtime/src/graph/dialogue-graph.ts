import { z } from 'zod';
import { WorkspaceDocumentSchema, protocolVersion, type WorkspaceDocument, type WorkspaceResultKind } from '@piano/assistant-protocol';
import type { CoreToolClient, PaymentPreviewRequest } from '../tools/core-tool-client.js';
import { CoreDialogueError, type DialogueReadClient, type LessonReadQuery, type LessonReadResult } from '../tools/dialogue-tools.js';
import { DialogueIntentSchema, type DialogueIntent, type UnderstandIntent } from './dialogue-intent.js';
import type { IntentParser } from './intent-parser.js';
import { refusalGuidance } from './refusal-messages.js';
import { DialogueMultiStepPlanSchema, isQueryOperation, type DialogueMultiStepPlan, type UnderstandMultiStep } from './dialogue-multi-step.js';

const CandidateSchema = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), field: z.enum(['accountId', 'teacherId', 'lessonId', 'studentId', 'courseId', 'payrollId', 'entryId']), values: z.record(z.string(), z.string()) });
const TaskSchema = z.object({
  history: z.array(z.object({role:z.enum(['user','assistant']),content:z.string()})).default([]),
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
  pendingStudentIntent: DialogueIntentSchema.optional(),
  answer: z.string().optional(),
  workspace: WorkspaceDocumentSchema.optional(),
  multiStep: z.object({ steps: DialogueMultiStepPlanSchema.shape.steps, currentStep: z.number().int().min(0), completedPreviewIds: z.array(z.string()), payrollCorrectionSource: z.string().optional(), payrollCorrectionSteps: DialogueMultiStepPlanSchema.shape.steps.optional(), payrollCorrectionReviewed:z.boolean().optional() }).strict().optional(),
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
function document(title: string, text: string, blocks: WorkspaceDocument['blocks'] = [], resultKind: WorkspaceResultKind = 'query'): WorkspaceDocument {
  return WorkspaceDocumentSchema.parse({ protocolVersion, resultKind, title, blocks: [{ type: 'summary', title, text }, ...blocks], sources: [] });
}
function withSources(workspace: WorkspaceDocument, sources: WorkspaceDocument['sources']): WorkspaceDocument {
  return WorkspaceDocumentSchema.parse({ ...workspace, sources });
}
function finish(task: DialogueTask, runId: string, answer: string, workspace: WorkspaceDocument): DialogueResult {
  const result = { ...workspace, taskVersion: task.version };
  return { task: { ...task, lastRunId: runId, answer, workspace: result }, answer, workspace: result };
}
function ask(task: DialogueTask, runId: string, question: string): DialogueResult {
  task.status = 'collecting';
  return finish(task, runId, question, document('请补充信息', question, [], 'clarification'));
}
function withCompletedSteps(task: DialogueTask, message: string): string {
  const completed = task.multiStep?.completedPreviewIds.length ?? 0;
  if (!completed) return message;
  if (task.multiStep?.steps.some(step => isQueryOperation(step.operation))) return `已有${completed}项写入经Core确认，未撤销；当前第${task.multiStep.currentStep + 1}步尚未完成。${message}`;
  return `第${completed}步已确认，未撤销；第${completed + 1}步${task.previewId ? '状态需重新查询' : '尚未生成可确认预览'}。${message}`;
}
function completePayrollCorrection(steps: DialogueMultiStepPlan['steps']): boolean {
  return steps.every((step,index) => {
    const next=steps[index+1];
    if (step.operation !== 'payroll.cancel-payment' || next?.operation !== 'payroll.pay') return true;
    const period=step.fields.period, paidAt=next.fields.paidAt;
    return typeof period === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period) && next.fields.period === period
      && typeof paidAt === 'string' && (z.iso.date().safeParse(paidAt).success || z.iso.datetime({offset:true}).safeParse(paidAt).success);
  });
}
function validPayrollCorrection(task: NonNullable<DialogueTask['multiStep']>): boolean {
  const hasCorrection=task.steps.some((step,index) => step.operation === 'payroll.cancel-payment' && task.steps[index+1]?.operation === 'payroll.pay');
  if (!hasCorrection) return true;
  if (!task.payrollCorrectionReviewed || !task.payrollCorrectionSteps) return false;
  const pairs = (steps: DialogueMultiStepPlan['steps']) => steps.flatMap((step, index) => step.operation === 'payroll.cancel-payment' && steps[index + 1]?.operation === 'payroll.pay' ? [[step, steps[index + 1]]] : []);
  if (JSON.stringify(pairs(task.steps)) !== JSON.stringify(pairs(task.payrollCorrectionSteps))) return false;
  return completePayrollCorrection(task.payrollCorrectionSteps);
}
function executedReceiptText(preview: Record<string, unknown>): string {
  const display = preview.display && typeof preview.display === 'object' ? preview.display as Record<string, unknown> : {};
  const title = typeof display.title === 'string' ? display.title : '原业务';
  const summary = typeof display.summary === 'string' ? display.summary : '';
  return `${title}已执行${summary ? `：${summary}` : ''}。原回执仍可查询，不会重复办理。`;
}
function choose(task: DialogueTask, runId: string, candidates: DialogueTask['candidates'], title: string): DialogueResult | undefined {
  if (candidates.length === 0) return ask(task, runId, title === '学生' ? '没有找到学生，请核对姓名；如果尚未建档，请由店主先新建学生，再继续办理。' : `没有找到${title}，请核对姓名、课程或日期。`);
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
  type Prepared = { previous: DialogueTask; task: DialogueTask; alreadyExecuted: boolean; multiStepPlan?: DialogueMultiStepPlan; payrollCorrectionSteps?: DialogueMultiStepPlan['steps']; forcedIntent?: DialogueIntent };
  const loadContext = async (turn: DialogueTurn): Promise<{ prepared?: Prepared; result?: DialogueResult }> => {
    const parsed = TaskSchema.safeParse(turn.previous);
    const previous = parsed.success ? parsed.data : TaskSchema.parse({});
    if (previous.status === 'completed' && previous.multiStep && previous.multiStep.currentStep >= previous.multiStep.steps.length) {
      delete previous.multiStep;
    }
    if (previous.lastRunId === turn.runId && previous.workspace && previous.answer !== undefined) return { result: { task: previous, workspace: previous.workspace, answer: previous.answer } };
    const task: DialogueTask = { ...previous, fields: { ...previous.fields }, selected: { ...previous.selected }, candidates: [...previous.candidates], references: [...previous.references], version: previous.version + 1 };
    if (!recoveryCommands.has(turn.message.trim())) task.lastUserMessage = turn.message;
    if (previous.multiStep && !['completed', 'cancelled'].includes(previous.status) && turn.message.trim() !== '取消当前办理'
      && !validPayrollCorrection(previous.multiStep)) {
      const answer = `${previous.previewId ? '当前已有确认单，状态需要先向Core核查；' : ''}这项历史工资纠错无法核实年份，请先取消当前办理，再分别写明工资所属年月和实际支付日期的年月日，重新发起。已执行的步骤不会自动撤销。`;
      return { result: finish(task, turn.runId, answer, document('请核实工资纠错年份', answer, [], 'clarification')) };
    }
    if (previous.multiStep && previous.status === 'ready' && !previous.previewId && ['继续', '开始第一步', '开始办理', ...recoveryCommands].includes(turn.message.trim())) {
      const step = previous.multiStep.steps[previous.multiStep.currentStep]!;
      return { prepared: { previous, task, alreadyExecuted: false, forcedIntent: { mode:'continue',operation:step.operation,fields:{},question:null } } };
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
          const answer = multiStep.steps.some(step => isQueryOperation(step.operation)) ? `全部${multiStep.steps.length}步已完成；写入操作均已在Core确认执行。` : `${multiStep.steps.length}步办理均已分别在Core确认执行。`;
          return { result: finish(task, turn.runId, answer, document('多步办理已完成', answer)) };
        }
        const step = multiStep.steps[multiStep.currentStep]!;
        const nextFields={...step.fields};
        task.multiStep = multiStep;
        task.operation = step.operation;
        task.status = 'ready';
        task.fields = Object.fromEntries(Object.entries(nextFields).filter((entry): entry is [string, string] => entry[1] !== null));
        task.selected = {};
        task.candidates = [];
        task.executedPreviewId = previous.previewId;
        delete task.previewId;
        const withoutOldPreview = { ...previous, executedPreviewId: previous.previewId };
        delete withoutOldPreview.previewId;
        if (turn.message.trim() === '取消当前办理') {
          return { prepared: { previous:withoutOldPreview, task, alreadyExecuted:false, forcedIntent:{ mode:'cancel',operation:null,fields:{},question:null } } };
        }
        const isContinueCommand = ['继续','继续下一步','开始办理',...recoveryCommands].includes(turn.message.trim());
        return { prepared: { previous: withoutOldPreview, task, alreadyExecuted: false, ...(isContinueCommand ? {forcedIntent: { mode:'continue' as const, operation:step.operation, fields:nextFields, question:null }} : {}) } };
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
        if (previous.pendingStudentIntent && turn.message.trim() === '继续') {
          const forcedIntent = previous.pendingStudentIntent;
          delete task.pendingStudentIntent;
          return { prepared: { previous: { ...previous, executedPreviewId: previous.previewId, status:'completed' }, task, alreadyExecuted:true, forcedIntent } };
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
    if (!prepared.previous.multiStep && input.understandMultiStep) {
      let candidate: DialogueMultiStepPlan | null;
      try {
      candidate = await input.understandMultiStep({ userMessage, businessDate:calendarDate, task: { operation:prepared.task.operation,fields:prepared.task.fields, candidates:prepared.task.candidates, references:prepared.task.references, pendingStudentIntent:prepared.previous.pendingStudentIntent, alreadyExecuted:prepared.alreadyExecuted }, history:prepared.previous.history }, signal);
      } catch (error) {
        if (error instanceof Error && error.message === 'AI_MULTI_STEP_INVALID') return { result: ask(prepared.task, turn.runId, '未能安全拆分完整的有序请求，请补充每项业务及办理顺序；涉及日期时请写明年份。当前未生成预览。') };
        throw error;
      }
      if (candidate) {
        let plan = DialogueMultiStepPlanSchema.parse(candidate);
        if (!completePayrollCorrection(plan.steps)) return { result: ask(prepared.task, turn.runId, '请重新说明工资所属月份和更正后的实际支付日期，分别写明年份、月份和日期；当前未生成预览。') };
        if (plan.steps.some((step, index) => step.operation === 'payroll.cancel-payment' && plan.steps[index + 1]?.operation === 'payroll.pay')) prepared.payrollCorrectionSteps = plan.steps;
        const mergedSteps: DialogueMultiStepPlan['steps'] = [];
        for (let index = 0; index < plan.steps.length; index++) {
          const open = plan.steps[index]!;
          if (open.operation !== 'course-account.open') { mergedSteps.push(open); continue; }
          const payment = plan.steps[index + 1];
          if (!payment || payment.operation !== 'payment.preview') return { result: ask(prepared.task, turn.runId, '请先为该学生课程缴费并确认，再重新提出赠送或排课请求；请提供学生、课程、缴费金额和渠道。当前未生成预览。') };
          const keys = ['studentName', 'courseName'] as const;
          if (keys.some(key => !open.fields[key] || !payment.fields[key] || open.fields[key] !== payment.fields[key]) || (open.fields.currentUnitPrice && payment.fields.currentUnitPrice && open.fields.currentUnitPrice !== payment.fields.currentUnitPrice)) {
            return { result: ask(prepared.task, turn.runId, '开户与缴费的学生、课程或单价无法确认一致，请明确说明同一学生、同一课程及单价；当前未生成预览。') };
          }
          mergedSteps.push({ ...payment, fields: { ...payment.fields, ...(open.fields.currentUnitPrice ? { currentUnitPrice:open.fields.currentUnitPrice } : {}) } });
          index++;
        }
        if (mergedSteps.length === 1) return { intent:{ mode:'new',operation:mergedSteps[0]!.operation,fields:mergedSteps[0]!.fields,question:null } };
        plan = DialogueMultiStepPlanSchema.parse({steps:mergedSteps});
        prepared.multiStepPlan = plan;
        const step = plan.steps[0]!;
        return { intent: { mode:'new', operation:step.operation, fields:step.fields, question:null } };
      }
    }
    const context = { businessDate: calendarDate, task: { status:prepared.task.status,operation: prepared.task.operation, fields: prepared.task.fields, candidates: prepared.task.candidates, references: prepared.task.references, pendingStudentIntent:prepared.previous.pendingStudentIntent, hasPreview: !!prepared.previous.previewId && !prepared.alreadyExecuted, alreadyExecuted: prepared.alreadyExecuted }, userMessage, history:prepared.previous.history };
    if (input.intentParser) {
      const parsed = await input.intentParser(context, signal);
      if (parsed.kind === 'parsed') return { intent: parsed.intent };
      if (parsed.kind === 'unavailable') {
        return { result: finish(prepared.task, turn.runId, '助手暂时连不上理解服务，未执行任何业务。你可以先用结构化页面办理，或稍后重试。', document('助手暂不可用', '未执行任何业务。', [{ type:'error-recovery', code:'AI_UNAVAILABLE', message:'理解服务暂不可用，未执行任何业务。', actions:['refresh','open-structured-page'] }], 'error')) };
      }
      return { result: ask(prepared.task, turn.runId, '我没太听懂这句话要办什么。可以说得更具体一点，比如"查今天的课表"、"给某位学生交费"或"排一节课"。') };
    }
    if (!input.understand) return { result: finish(prepared.task, turn.runId, 'AI暂不可用，请使用人工办理入口。', document('AI暂不可用', '未执行任何业务。', [{ type: 'error-recovery', code: 'AI_UNAVAILABLE', message: '请稍后重试，或使用人工办理入口。', actions: ['open-structured-page'] }], 'error')) };
    const understood = DialogueIntentSchema.parse(await input.understand(context, signal));
    return { intent: understood };
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
      if (alreadyExecuted && previous.pendingStudentIntent && intent.mode === 'cancel') {
        delete task.pendingStudentIntent;
        delete task.previewId;
        task.status = 'completed';
        const answer = '已取消待办理事项，学生建档已经确认，不受影响。';
        return finish(task, turn.runId, answer, document('已取消待办理事项', answer));
      }
      if (alreadyExecuted && previous.pendingStudentIntent && ['continue','correct'].includes(intent.mode)
        && (!intent.operation || intent.operation === previous.pendingStudentIntent.operation)) {
        const resumed = DialogueIntentSchema.safeParse({ ...previous.pendingStudentIntent, mode:'new', fields:{ ...previous.pendingStudentIntent.fields, ...intent.fields } });
        if (!resumed.success) return ask(task, turn.runId, '无法确定继续办理的信息，请重新说明学生、课程和需要办理的事项。');
        intent = resumed.data;
        delete task.pendingStudentIntent;
        delete task.previewId;
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
        const completedSteps = multiStep?.completedPreviewIds.length ?? 0;
        if (multiStep?.steps.some(step => isQueryOperation(step.operation)) && multiStep.currentStep > 0) {
          const answer = `已取消后续步骤。前${multiStep.currentStep}步已完成，其中${completedSteps}项写入已确认生效且未撤销；剩余${multiStep.steps.length - multiStep.currentStep}步未完成。`;
          return finish(task, turn.runId, answer, document('已取消后续步骤', answer));
        }
        if (multiStep && completedSteps > 0) {
          const remainingSteps = multiStep.steps.length - completedSteps;
          const answer = `已取消后续步骤。${multiStep.steps.length}步办理里前 ${completedSteps} 步已经确认生效，剩余 ${remainingSteps} 步没有执行，也没有做任何撤销；如需撤回已生效的部分，请单独发起对应的纠错或冲正。`;
          return finish(task, turn.runId, answer, document('已取消后续步骤', answer));
        }
        return finish(task, turn.runId, '已取消当前待办理事项，未执行业务变更。', document('已取消办理', '待办理预览已失效；已经确认的业务不受影响。'));
      }
      if (task.multiStep && intent.operation && intent.operation !== task.multiStep.steps[task.multiStep.currentStep]?.operation) {
        return ask(task, turn.runId, `当前是第${task.multiStep.currentStep + 1}步；如需结束多步办理，请取消当前办理。`);
      }
      if (intent.operation === 'receipt.read') {
        const previewId = previous.executedPreviewId ?? previous.previewId;
        if (!previewId) return ask(task, turn.runId, '当前会话没有可查看的操作回执，请说明要查哪笔记录。');
        const preview = await input.tools.readPreview(input.capability, previewId);
        if (preview.status !== 'EXECUTED') return ask(task, turn.runId, '这项操作还没有已执行回执，请先核对当前确认单。');
        task.executedPreviewId = previewId;
        task.status = 'completed';
        const answer = executedReceiptText(preview);
        return finish(task, turn.runId, answer, document('业务回执', answer));
      }
      if (intent.mode === 'clarify' && intent.operation && intent.question) return ask(task, turn.runId, intent.question);
      if (intent.mode === 'clarify' && !intent.operation) {
        return ask(task, turn.runId, '无法确定要办理的事项，请说明要办理什么或查询什么；当前尚未查询或执行任何记录。');
      }
      if (intent.mode === 'clarify') intent = { ...intent, mode: intent.operation === task.operation ? 'continue' : 'new' };
      // An unconfirmed creation is not proof that its subject exists. Keep the
      // request pending until Core reports execution when it refers to that student.
      if (previous.operation === 'student.create' && previous.previewId && !alreadyExecuted
        && intent.operation !== 'student.create' && 'studentName' in intent.fields
        && (!intent.fields.studentName || intent.fields.studentName === previous.fields.name)) {
        task.pendingStudentIntent = intent;
        const question = '上一位学生的建档尚未确认执行，请先确认建档，再说“继续”处理刚才的请求；当前未查询学生账户。';
        const workspace = previous.workspace ? { ...previous.workspace, blocks:[...previous.workspace.blocks, { type:'summary' as const, title:'等待建档确认', text:question }] } : document('等待建档确认', question, [], 'clarification');
        return finish(task, turn.runId, question, workspace);
      }
      const changed = Object.entries(intent.fields).filter(([key]) => allowedFields.has(key));
      if (intent.mode === 'new') {
        await withdrawPreviousPreview('用户切换办理事项');
        task = { ...TaskSchema.parse({}), version: task.version, operation: intent.operation, ...(task.lastUserMessage ? {lastUserMessage:task.lastUserMessage} : {}) };
      } else {
        if (intent.mode === 'correct' || changed.some(([key, value]) => (value ?? undefined) !== task.fields[key])) {
          await withdrawPreviousPreview('用户更正办理信息');
          if (alreadyExecuted) return finish(task, turn.runId, '原业务已经确认执行，不能通过修改或取消对话撤回。请查询原记录，或另行发起允许的纠错业务。', document('原业务已执行', '没有追加或撤销任何业务记录。'));
        }
        task.operation = intent.operation ?? task.operation;
        if (changed.some(([key, value]) => ['studentName','courseName','teacherName','date','dateFrom','dateTo'].includes(key) && (value ?? undefined) !== task.fields[key])) { task.selected = {}; task.candidates = []; }
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
      if (task.operation === 'course-account.open') {
        if (!task.multiStep) task.operation = 'payment.preview';
        return ask(task, turn.runId, `${task.multiStep ? '这是历史办理计划，请先取消当前办理，再重新发起缴费。' : ''}课程记录在首次缴费确认时按需建立。请提供学生、课程、缴费金额和渠道，例如“给林悦主课缴费1000元，微信”；如需指定单节价格也请一并说明。当前未生成开户预览。`);
      }
      if (task.operation === 'lessons.read' && f.date && !f.dateFrom) { f.dateFrom = f.date; f.dateTo = f.date; }
      if (!task.operation || task.operation === 'unsupported') {
        if (intent.question) return finish(task, turn.runId, intent.question, document('需要换个方式办理', intent.question, [], 'clarification'));
        return ask(task, turn.runId, '本期不支持这项自动化请求。可以改为指定周数的排课，或办理已支持的查询和预览；当前未执行业务。');
      }
      const actionTypeForAccess: Record<string,string> = { 'accounts.read':'course-account.read', 'payment.preview':'course-account.payment', 'gift.preview':'course-account.gift', 'refund.preview':'student.final-refund', 'lesson.schedule':f.weeks ? 'lesson.schedule.weekly-batch' : 'lesson.schedule.single' };
      if (!['lessons.read','overview.read','ledger.read','report.monthly','payroll.read','directory.read','arrears.read','consumption.read','period.preclose.read'].includes(task.operation)) await input.tools.checkActionAccess(input.capability, actionTypeForAccess[task.operation] ?? task.operation);
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
        const dateRangeHint = missing.includes('dateFrom') && missing.includes('dateTo') ? '请补充具体范围。' : '';
        return ask(task, turn.runId, `${retained ? `已保留：${retained}。` : ''}${dateRangeHint}还需要补充：${missing.map(field => labels[field] ?? field).join('、')}。`);
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
            : `${result.period}现金口径：实际收款${report.cashIncome}元、现金支出${report.cashExpense}元、现金净额${report.cashNet}元；经营口径：经营收入${report.operatingIncome}元、经营成本${report.operatingExpense}元、经营利润${report.operatingProfit}元。经营收入包括课消${report.lessonIncome}元、退款手续费${report.refundFeeIncome}元、其他经营收入${report.manualIncome}元；经营成本包括工资${report.payrollCost}元、赠送课消${report.giftCost}元、其他经营支出${report.manualExpense}元。现金净额与经营利润相差${report.cashOperatingGap}元；收款按到账确认，课消、赠送成本和工资按经营发生确认。`;
        task.status = 'completed';
        return finish(task, turn.runId, answer, withSources(document(`月报 · ${result.period}`, answer, [{ type: 'metric-grid', metrics: [
          { label: '现金收入', value: report.cashIncome, tone: 'positive' },
          { label: '现金支出', value: report.cashExpense, tone: 'warning' },
          { label: '现金净额', value: report.cashNet, tone: 'neutral' },
          { label: '经营收入', value: report.operatingIncome, tone: 'positive' },
          { label: '经营成本', value: report.operatingExpense, tone: 'warning' },
          { label: '课消收入', value: report.lessonIncome, tone: 'positive' },
          { label: '工资成本', value: report.payrollCost, tone: 'warning' },
          { label: '经营利润', value: report.operatingProfit, tone: 'neutral' },
        ] }]), [{ type:'report', id:result.period, label:`${result.period}月报` }]));
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
        return finish(task, turn.runId, answer, withSources(document('基础资料', answer, [
          { type:'data-table', columns:[{ key:'name',label:'学生' },{ key:'status',label:'学籍状态' }], rows:students.map(item => ({ name:item.name,status:item.enrollmentStatus })) },
          { type:'data-table', columns:[{ key:'name',label:'老师' },{ key:'status',label:'状态' }], rows:teachers.map(item => ({ name:item.name,status:item.isActive ? '启用' : '停用' })) },
          { type:'data-table', columns:[{ key:'name',label:'课程' },{ key:'status',label:'状态' }], rows:courses.map(item => ({ name:item.name,status:item.isActive ? '启用' : '停用' })) },
        ]), students.map(student => ({ type:'student', id:student.studentId, label:student.name }))));
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
      if (accountOperations.includes(task.operation) && !task.selected.accountId && !task.selected.studentId) {
        const students = await input.tools.getStudentCandidates(input.capability, { studentName:f.studentName!,match:'search' });
        const selection = choose(task, turn.runId, students.candidates.map(item => ({ id:item.studentId, label:item.name, description:`学生 ${item.studentId.slice(-8)}`, field:'studentId', values:{studentName:item.name} })), '学生');
        if (selection) return selection;
      }
      if (task.operation === 'accounts.read' && !f.courseName && !task.selected.accountId) {
        const found = await input.tools.getCourseAccountCandidates(input.capability, { studentName:f.studentName!,match:'search' });
        found.candidates = found.candidates.filter(candidate => candidate.studentId === task.selected.studentId);
        if (found.candidates.length === 0) return ask(task, turn.runId, '该学生尚无课程记录；需要缴费时，可以直接告诉我学生、课程和金额。');
        const accounts = await Promise.all(found.candidates.map(candidate => input.tools.readAccount(input.capability, { accountId:candidate.accountId })));
        const answer = accounts.map(account => `${account.courseName}：实收 ${account.paidBalance}，赠送 ${account.giftBalance}，总 ${account.totalBalance}，单价 ${account.currentUnitPrice}`).join('；');
        task.status = 'completed';
        return finish(task, turn.runId, `${f.studentName}各课程账户：${answer}。`, withSources(document(`课程账户 · ${f.studentName}`, '以下金额按课程分别读取。', [{ type:'data-table', columns:[{key:'course',label:'课程'},{key:'paid',label:'实收余额'},{key:'gift',label:'赠送余额'},{key:'total',label:'总余额'},{key:'price',label:'单节价格'}], rows:accounts.map(account => ({course:account.courseName,paid:account.paidBalance,gift:account.giftBalance,total:account.totalBalance,price:account.currentUnitPrice})) }]), accounts.map(account => ({ type:'courseAccount', id:account.accountId, label:`${account.studentName} · ${account.courseName}` }))));
      }
      if (accountOperations.includes(task.operation) && !task.selected.accountId) {
        const found = await input.tools.getCourseAccountCandidates(input.capability, { studentName: f.studentName!, courseName: f.courseName!, match: 'search' });
        let matching = found.candidates.filter(item => item.studentId === task.selected.studentId);
        if (!matching.length && (task.operation === 'gift.preview' || task.operation === 'lesson.schedule')) {
          if (!input.tools.readDirectory) return ask(task, turn.runId, '暂时无法核实课程，请稍后重试；当前未生成预览。');
          const directory = await input.tools.readDirectory(input.capability);
          const query = f.courseName!.trim().toLocaleLowerCase();
          const exact = directory.courses.filter(course => course.name.toLocaleLowerCase() === query);
          const courses = exact.length ? exact : directory.courses.filter(course => course.name.toLocaleLowerCase().includes(query));
          const choice = choose(task, turn.runId, courses.map(course => ({id:course.courseId,label:course.name,field:'courseId' as const,values:{courseName:course.name}})), '课程');
          if (choice) return choice;
          const course = courses.find(item => item.courseId === task.selected.courseId);
          if (!course?.isActive) return ask(task, turn.runId, '该课程未启用，请核对课程状态；当前未生成预览。');
          if (directory.courses.filter(item => item.name === course.name).length !== 1) return ask(task, turn.runId, '课程名称对应多个课程，暂时无法安全核实课程记录，请使用结构化页面核对。');
          const rechecked = await input.tools.getCourseAccountCandidates(input.capability, {studentName:f.studentName!,courseName:course.name,match:'search'});
          matching = rechecked.candidates.filter(item => item.studentId === task.selected.studentId && item.courseName === course.name);
          if (!matching.length) {
            const action = task.operation === 'gift.preview' ? '赠送' : '排课';
            return ask(task, turn.runId, `该学生的${f.courseName}尚无课程记录，${action}尚未办理。请先提供学生、课程、缴费金额和渠道，生成缴费预览并确认；缴费确认后请重新提出${action}请求。`);
          }
        }
        if (!matching.length && task.operation !== 'payment.preview') return ask(task, turn.runId, '没有找到该学生与所述课程的记录，请确认课程名称；如尚未缴费，可先办理缴费。');
        if(matching.length) { const result = choose(task, turn.runId, matching.map(item => ({ id: item.accountId, label: `${item.studentName} · ${item.courseName}`, description: `账户 ${item.accountId.slice(-8)}`, field: 'accountId', values: { studentName: item.studentName, courseName: item.courseName } })), '学生课程账户'); if (result) return result; }
      }
      if(task.operation==='payment.preview'&&f.currentUnitPrice&&!task.selected.studentId){
        const students=await input.tools.getStudentCandidates(input.capability,{studentName:f.studentName!,match:'search'});
        const choice=choose(task,turn.runId,students.candidates.map(student=>({id:student.studentId,label:student.name,field:'studentId' as const,values:{studentName:student.name}})),'学生');
        if(choice)return choice;
      }
      if(task.operation==='payment.preview'&&(!task.selected.accountId||f.currentUnitPrice)&&!task.selected.courseId){
        if(!input.tools.readDirectory) return ask(task,turn.runId,'暂时无法核实课程，请稍后重试；当前未生成缴费预览。');
        const directory=await input.tools.readDirectory(input.capability);
        const query=f.courseName!.trim().toLocaleLowerCase();
        const exact=directory.courses.filter(course=>course.isActive&&course.name.toLocaleLowerCase()===query);
        const courses=exact.length?exact:directory.courses.filter(course=>course.isActive&&course.name.toLocaleLowerCase().includes(query));
        const choice=choose(task,turn.runId,courses.map(course=>({id:course.courseId,label:course.name,field:'courseId' as const,values:{courseName:course.name}})),'缴费课程');
        if(choice)return choice;
      }
      if (task.operation === 'accounts.read') {
        const account = await input.tools.readAccount(input.capability, { accountId: task.selected.accountId! });
        task.status = 'completed';
        return finish(task, turn.runId, `${account.studentName}的${account.courseName}：实收 ${account.paidBalance}，赠送 ${account.giftBalance}，总 ${account.totalBalance}，单价 ${account.currentUnitPrice}。`, withSources(document(`课程账户 · ${account.studentName}`, '以下金额来自课程账户。', [{ type: 'data-table', columns: [{ key: 'course', label: '课程' },{ key: 'paid', label: '实收余额' },{ key: 'gift', label: '赠送余额' },{ key: 'total', label: '总余额' },{ key: 'price', label: '单节价格' }], rows: [{ course: account.courseName, paid: account.paidBalance, gift: account.giftBalance, total: account.totalBalance, price: account.currentUnitPrice }] }]), [{ type:'courseAccount', id:account.accountId, label:`${account.studentName} · ${account.courseName}` }]));
      }
      if (task.operation === 'ledger.read') {
        const result = await input.tools.readAccountLedger(input.capability, { accountId: task.selected.accountId! });
        const entries = result.entries.filter(entry => {
          const occurredBusinessDate = businessDate(new Date(entry.occurredAt));
          return (!f.dateFrom || occurredBusinessDate >= f.dateFrom) && (!f.dateTo || occurredBusinessDate <= f.dateTo);
        });
        const account = await input.tools.readAccount(input.capability, { accountId:task.selected.accountId! });
        const kindLabels: Record<string,string> = { PAYMENT:'交费',GIFT:'赠送',LESSON_CONSUMPTION:'课消',PAYMENT_REVERSAL:'交费冲正',GIFT_REVERSAL:'赠送冲正',LESSON_CONSUMPTION_REVERSAL:'课消冲正',LESSON_CONSUMPTION_CORRECTION:'课消纠正',REFUND_PAID:'退款',REFUND_GIFT_CLEARING:'赠送清零' };
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
        return finish(task, turn.runId, answer, withSources(document(`课程流水 · ${f.studentName}`, answer, [{ type:'ledger-detail', accountId:result.accountId, entries:entries.map(entry => ({ id:entry.entryId,occurredAt:entry.occurredAt,description:`${kindLabels[entry.kind] ?? entry.kind}${entry.operator ? ` · ${entry.operator}` : ''}${entry.note ? ` · ${entry.note}` : ''}`,paidDelta:entry.paidDelta,giftDelta:entry.giftDelta })) }]), entries.map(entry => ({ type:'ledgerEntry', id:entry.entryId, label:`${businessDate(new Date(entry.occurredAt))} · ${kindLabels[entry.kind] ?? entry.kind}` }))));
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
      if (task.operation === 'student.update') {
        if (!task.selected.studentId) {
          const found = await input.tools.getStudentCandidates(input.capability, { studentName:f.studentName!,match:'search' });
          const result = choose(task, turn.runId, found.candidates.map(item => ({ id:item.studentId,label:item.name,field:'studentId',values:{ studentName:item.name } })), '学生');
          if (result) return result;
        }
      }
      if (task.operation === 'course.update') {
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
        const preview = task.operation === 'payment.preview' ? await input.tools.createPaymentPreview(input.capability, task.selected.courseId ? { ...keys,studentId:task.selected.studentId!,courseId:task.selected.courseId,amount,channel:channel!,occurredAt:dateTimeText(f.occurredAt,now),...(f.currentUnitPrice ? {currentUnitPrice:moneyText(f.currentUnitPrice)} : {}),...(f.note ? {note:f.note} : {}) } : { ...base, channel: channel! }) : await input.tools.createGiftPreview(input.capability, base);
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
            candidates = result.candidates
              .filter(item => !f.courseName || item.courseName === f.courseName)
              .filter(item => !f.startsAt || (Number.isFinite(Date.parse(f.startsAt)) && Date.parse(item.startsAt) === Date.parse(f.startsAt)))
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
          const eligible = found.candidates.filter(item => item.teacherId === task.selected.teacherId && (task.operation !== 'payroll.cancel-payment' || item.status === 'PAID'));
          if (!eligible.length) return ask(task, turn.runId, task.operation === 'payroll.cancel-payment' ? '该老师该月份没有已支付工资记录，请核对老师和月份；未生成预览。' : '没有找到该老师该月份的工资记录，请核对月份；如尚未生成，请先生成工资。未生成预览。');
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
      const message = withCompletedSteps(task, error instanceof CoreDialogueError ? error.message : error instanceof z.ZodError ? '业务参数不完整或不合法，请核对后再试' : 'AI处理暂时失败，请稍后重试。未确认的业务不会自动执行。');
      const recovery: WorkspaceDocument['blocks'][number] = { type: 'error-recovery', code: error instanceof CoreDialogueError ? `CORE_${error.status}` : error instanceof z.ZodError ? 'CORE_400' : 'AI_PROCESS_FAILED', message, actions: ['refresh', 'open-structured-page'] };
      const workspace = task.previewId && task.workspace ? { ...task.workspace, resultKind: 'error' as const, blocks: [...task.workspace.blocks, recovery] } : document('暂时无法完成', message, [recovery], 'error');
      return finish(task, turn.runId, message, workspace);
    }
  };
  const failure = (turn: DialogueTurn, task: DialogueTask, error: unknown) => {
    const message = withCompletedSteps(task, error instanceof CoreDialogueError
      ? (refusalGuidance(error.code, error.status) ?? error.message)
      : 'AI处理暂时失败，请稍后重试。未确认的业务不会自动执行。');
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
        task.multiStep = { steps:plan.steps,currentStep:0,completedPreviewIds:[], ...(prepared.payrollCorrectionSteps ? { payrollCorrectionSteps:prepared.payrollCorrectionSteps, payrollCorrectionReviewed:true } : {}) };
        task.status = 'ready';
        const names: Record<DialogueMultiStepPlan['steps'][number]['operation'], string> = {
          'receipt.read':'查看回执', 'lessons.read':'查询课表', 'accounts.read':'查询账户', 'ledger.read':'查询流水', 'overview.read':'查询经营概况', 'report.monthly':'查询月报',
          'payroll.read':'查询工资', 'directory.read':'查询基础资料', 'arrears.read':'查询欠费', 'consumption.read':'查询课消', 'period.preclose.read':'查询关账预检',
          'student.create':'学生建档', 'student.update':'修改学生资料', 'teacher.create':'新增教师', 'teacher.compensation.update':'修改教师薪酬',
          'course.create':'新增课程', 'course.update':'修改课程', 'course-account.open':'开课程账户', 'course-account.price':'修改课程账户单价',
          'payment.preview':'交费', 'gift.preview':'赠送', 'ledger-entry.reversal':'冲正原流水', 'lesson.schedule':'排课',
          'lesson.reschedule':'调课', 'lesson.cancel':'取消课程', 'lesson.complete':'确认上课', 'lesson.complete.reversal':'撤销上课确认',
          'lesson.complete.correction':'上课纠错', 'refund.preview':'退学退款', 'payroll.cancel-payment':'撤销原工资支付',
          'payroll.generate':'生成工资', 'payroll.adjust':'调整工资', 'payroll.pay':'登记工资支付', 'manual-transaction.create':'登记收支',
          'period.close':'关账', 'period.reopen':'重新开账',
        };
        const name = (operation: DialogueMultiStepPlan['steps'][number]['operation']) => names[operation];
        const describe = (step: typeof first) => `${name(step.operation)}${step.fields.courseName ? `（${step.fields.courseName}` : '（'}${step.fields.amount ? `${moneyText(step.fields.amount)}元` : ''}${step.fields.startsAt ? `，${step.fields.startsAt}` : ''}${step.fields.channel ? `，${step.fields.channel}` : ''}）${[step.fields.studentName && `学生：${step.fields.studentName}`,step.fields.teacherName && `老师：${step.fields.teacherName}`,step.fields.currentUnitPrice && `单价${moneyText(step.fields.currentUnitPrice)}元`,step.fields.weeks && `周数：${step.fields.weeks}`,step.fields.reason && `原因：${step.fields.reason}`,step.fields.period && `月份：${step.fields.period}`,step.fields.paidAt && `支付日期：${step.fields.paidAt}`,step.fields.baseSalary && `底薪${moneyText(step.fields.baseSalary)}元`,step.fields.commissionRate && `提成比例${step.fields.commissionRate}`,step.fields.bonusAmount && `奖金${moneyText(step.fields.bonusAmount)}元`,step.fields.bonusNote && `奖金说明：${step.fields.bonusNote}`,step.fields.deductionAmount && `代扣${moneyText(step.fields.deductionAmount)}元`,step.fields.deductionNote && `代扣说明：${step.fields.deductionNote}`].filter(Boolean).join('、')}`;
        const untouched = first.fields.courseName === second.fields.courseName && first.operation === 'payment.preview' && second.operation === 'gift.preview' ? '其他课程（如陪练）不会改动。' : '';
        const stepsText = plan.steps.map((step,index) => `第${['一','二','三'][index] ?? index + 1}步${describe(step)}`).join('；');
        const answer = plan.steps.some(step => isQueryOperation(step.operation))
          ? `已拆为按顺序办理的${plan.steps.length}步：${stepsText}。${untouched}查询完成后可继续；写入须分别确认。回复“开始第一步”后才开始处理，当前尚未执行业务变更。`
          : `已拆为按顺序分别确认的${plan.steps.length}步：${stepsText}。${untouched}回复“开始第一步”后才生成第一步预览，当前尚未执行。`;
        return { result: finish(task, turn.runId, answer, document('多步办理计划', answer, [], 'clarification')) };
      }
      const result = await process(turn, prepared, intent);
      const task = result.task;
      if (task.multiStep && task.status === 'completed' && isQueryOperation(task.operation)
        && task.operation === task.multiStep.steps[task.multiStep.currentStep]?.operation && result.workspace.resultKind === 'query') {
        const currentStep = task.multiStep.currentStep + 1;
        task.multiStep = { ...task.multiStep, currentStep };
        if (currentStep < task.multiStep.steps.length) {
          const next = task.multiStep.steps[currentStep]!;
          task.operation = next.operation;
          task.fields = Object.fromEntries(Object.entries(next.fields).filter((entry): entry is [string, string] => entry[1] !== null));
          task.selected = {};
          task.candidates = [];
          task.references = [];
          task.status = 'ready';
          const answer = `${result.answer} 第${currentStep}步查询完成，回复“继续”处理下一步。`;
          return { result: finish(task, turn.runId, answer, { ...result.workspace, blocks:[...result.workspace.blocks, { type:'summary', title:'查询完成', text:'回复“继续”处理下一步。' }] }) };
        }
        const answer = `${result.answer} 查询完成，计划中的写入均须经Core确认。`;
        return { result: finish(task, turn.runId, answer, result.workspace) };
      }
      return { result };
    } catch (error) {
      return { result: failure(turn, prepared.task, error).result };
    }
  };

  return {
    invoke: async (state: { turn: DialogueTurn }, config?: { signal?: AbortSignal }) => {
      const previous = TaskSchema.safeParse(state.turn.previous);
      const outcome = await runTurn(state.turn, config?.signal ?? new AbortController().signal);
      if (!previous.success || previous.data.lastRunId !== state.turn.runId) {
        outcome.result.task.history = [...(previous.success ? previous.data.history : []), {role:'user',content:state.turn.message}, {role:'assistant',content:outcome.result.answer}];
      }
      return outcome;
    },
  };
}

function lessonReferences(lessons: LessonReadResult['lessons']): DialogueTask['references'] {
  return lessons.map(item => ({ id: item.lessonId, label: `${item.studentName} · ${item.courseName}`, description: `${formatTime(item.startsAt)} · ${item.teacherName} · ${item.statusLabel}`, field: 'lessonId', values: { studentName: item.studentName, courseName: item.courseName, status:item.statusLabel } }));
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
