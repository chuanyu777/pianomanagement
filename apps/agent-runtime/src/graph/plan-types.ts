import { z } from 'zod';
import { operationFields, operationSchema } from './dialogue-intent.js';

const FieldOriginSchema = z.enum(['user', 'reference', 'core-default']);
const ParameterSchema = z.object({
  value: z.string().nullable(),
  rawText: z.string().max(2000).optional(),
  origin: FieldOriginSchema,
  explicit: z.boolean(),
  source: z.object({ messageId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().max(500) }).optional(),
}).strict().superRefine((parameter, context) => {
  if (parameter.source && parameter.source.end < parameter.source.start) context.addIssue({ code: 'custom', path: ['source'], message: '来源位置无效' });
  if (parameter.source && !parameter.rawText) context.addIssue({ code: 'custom', path: ['rawText'], message: '有来源位置时必须保留原文' });
});

export const PlanSubjectSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['student', 'teacher', 'course', 'account', 'lesson', 'payroll', 'ledger-entry', 'manual-entry']),
  name: z.string().min(1).max(200),
  coreId: z.string().min(1).optional(),
  source: z.object({ messageId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().max(500) }).optional(),
}).strict();

export const PlanIssueSchema = z.object({
  code: z.enum(['unsupported', 'conflict', 'missing', 'ambiguous', 'permission', 'data-changed', 'model-invalid']),
  message: z.string().min(1).max(500),
  blocking: z.boolean(),
  source: z.object({ messageId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().max(500) }).optional(),
}).strict();

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  operation: operationSchema.exclude(['unsupported']),
  subjectId: z.string().optional(),
  fields: z.record(z.string(), ParameterSchema),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(['draft', 'waiting-input', 'ready', 'previewing', 'awaiting-confirmation', 'result-unknown', 'completed', 'failed', 'cancelled', 'structured']).default('draft'),
  commandRevision: z.number().int().nonnegative().default(0),
  previewId: z.string().optional(),
  receiptId: z.string().optional(),
}).strict();

export const PlanDraftSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status: z.enum(['collecting', 'ready', 'in-progress', 'blocked', 'partial', 'completed', 'cancelled']),
  subjects: z.array(PlanSubjectSchema),
  steps: z.array(PlanStepSchema),
  issues: z.array(PlanIssueSchema),
  activeStepId: z.string().optional(),
  lastMessageId: z.string().optional(),
}).strict();

export type PlanDraft = z.infer<typeof PlanDraftSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;

export function createPlanDraftFromSteps(stepsInput: Array<{ operation: PlanStep['operation']; fields: Record<string, string | null> }>, planId: string): PlanDraft {
  const subjects: PlanDraft['subjects'] = [];
  const subjectByKey = new Map<string, string>();
  const subjectKind = (field: string): PlanDraft['subjects'][number]['kind'] => field === 'studentName' ? 'student' : field === 'teacherName' ? 'teacher' : 'course';
  const draftSteps = stepsInput.map((step, index) => {
    const subjectField = ['studentName', 'teacherName', 'courseName'].find(field => step.fields[field]);
    let subjectId: string | undefined;
    if (subjectField) {
      const key = `${subjectField}:${step.fields[subjectField]}`;
      subjectId = subjectByKey.get(key);
      if (!subjectId) {
        subjectId = `subject-${subjects.length + 1}`;
        subjectByKey.set(key, subjectId);
        subjects.push({ id: subjectId, kind: subjectKind(subjectField), name: step.fields[subjectField]! });
      }
    }
    const fields = Object.fromEntries(Object.entries(step.fields).map(([key, value]) => [key, parameter(value, { explicit: value !== null })]));
    return PlanStepSchema.parse({ id: `step-${index + 1}`, operation: step.operation, ...(subjectId ? { subjectId } : {}), fields, dependsOn: index ? [`step-${index}`] : [], status: 'draft', commandRevision: 0 });
  });
  return PlanDraftSchema.parse({ schemaVersion: 1, planId, revision: 0, status: 'collecting', subjects, steps: draftSteps, issues: [], activeStepId: draftSteps[0]?.id });
}

const SourceSchema = z.object({ messageId: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().max(500) }).strict();
const SubjectChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), subject: PlanSubjectSchema }).strict(),
  z.object({ kind: z.literal('rename'), subjectId: z.string().min(1), name: z.string().min(1).max(200), source: SourceSchema.optional() }).strict(),
  z.object({ kind: z.literal('select'), subjectId: z.string().min(1), coreId: z.string().min(1) }).strict(),
]);
const StepChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), step: PlanStepSchema }).strict(),
  z.object({ kind: z.literal('set-field'), stepId: z.string().min(1), field: z.string().min(1), parameter: ParameterSchema }).strict(),
  z.object({ kind: z.literal('clear-field'), stepId: z.string().min(1), field: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('set-subject'), stepId: z.string().min(1), subjectId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('cancel'), stepId: z.string().min(1) }).strict(),
]);

export const PlanPatchSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  turnKind: z.enum(['new', 'supplement', 'correct', 'withdraw', 'select', 'query', 'continue']),
  subjectChanges: z.array(SubjectChangeSchema).default([]),
  stepChanges: z.array(StepChangeSchema).default([]),
  issues: z.array(PlanIssueSchema).default([]),
  evidence: z.array(SourceSchema).default([]),
}).strict();
export type PlanPatch = z.infer<typeof PlanPatchSchema>;

function sourceBelongs(message: string, source: z.infer<typeof SourceSchema>): boolean {
  return source.end >= source.start && source.end <= message.length && message.slice(source.start, source.end) === source.quote;
}

function assertFieldAllowed(operation: PlanStep['operation'], field: string): void {
  if (!(operationFields[operation] as readonly string[]).includes(field)) throw new Error(`字段 ${field} 不适用于 ${operation}`);
}

function bumpStep(step: PlanStep): PlanStep {
  return { ...step, commandRevision: step.commandRevision + 1, previewId: undefined, status: 'draft' };
}

export function applyPlanPatch(planInput: PlanDraft, patchInput: PlanPatch, input: { messageId: string; message: string }): PlanDraft {
  const plan = PlanDraftSchema.parse(planInput);
  const patch = PlanPatchSchema.parse(patchInput);
  if (patch.baseRevision !== plan.revision) throw new Error('办理计划版本已变化，请重新读取后再修改');
  for (const evidence of patch.evidence) {
    if (evidence.messageId !== input.messageId || !sourceBelongs(input.message, evidence)) throw new Error('办理依据不属于当前消息');
  }
  for (const change of patch.subjectChanges) {
    if (change.kind !== 'add' && !plan.subjects.some(subject => subject.id === change.subjectId)) throw new Error('办理对象不存在');
    if (change.kind === 'add' && plan.subjects.some(subject => subject.id === change.subject.id)) throw new Error('办理对象编号重复');
    if (change.kind === 'rename' && change.source && (change.source.messageId !== input.messageId || !sourceBelongs(input.message, change.source))) throw new Error('姓名依据不属于当前消息');
  }
  const subjects = [...plan.subjects];
  for (const change of patch.subjectChanges) {
    if (change.kind === 'add') subjects.push(change.subject);
    else if (change.kind === 'rename') {
      const subject = subjects.find(item => item.id === change.subjectId)!;
      subject.name = change.name.trim();
    } else {
      const subject = subjects.find(item => item.id === change.subjectId)!;
      subject.coreId = change.coreId;
    }
  }
  const steps = plan.steps.map(step => ({ ...step, fields: { ...step.fields }, dependsOn: [...step.dependsOn] }));
  const findStep = (id: string): PlanStep => {
    const step = steps.find(item => item.id === id);
    if (!step) throw new Error('办理步骤不存在');
    return step;
  };
  for (const change of patch.stepChanges) {
    if (change.kind === 'add') {
      if (steps.some(step => step.id === change.step.id)) throw new Error('办理步骤编号重复');
      for (const field of Object.keys(change.step.fields)) assertFieldAllowed(change.step.operation, field);
      if (change.step.subjectId && !subjects.some(subject => subject.id === change.step.subjectId)) throw new Error('步骤引用的对象不存在');
      steps.push(change.step);
      continue;
    }
    const step = findStep(change.stepId);
    if (['completed', 'cancelled'].includes(step.status)) throw new Error('已完成或已取消的步骤不能改草稿');
    if (change.kind === 'set-field') {
      assertFieldAllowed(step.operation, change.field);
      steps[steps.indexOf(step)] = bumpStep({ ...step, fields: { ...step.fields, [change.field]: change.parameter } });
    } else if (change.kind === 'clear-field') {
      const fields = { ...step.fields };
      delete fields[change.field];
      steps[steps.indexOf(step)] = bumpStep({ ...step, fields });
    } else if (change.kind === 'set-subject') {
      if (!subjects.some(subject => subject.id === change.subjectId)) throw new Error('步骤引用的对象不存在');
      steps[steps.indexOf(step)] = bumpStep({ ...step, subjectId: change.subjectId });
    } else {
      steps[steps.indexOf(step)] = { ...step, status: 'cancelled', previewId: undefined };
    }
  }
  const issues = patch.issues.map(issue => issue.source && (issue.source.messageId !== input.messageId || !sourceBelongs(input.message, issue.source)) ? (() => { throw new Error('问题依据不属于当前消息'); })() : issue);
  const activeStep = steps.find(step => !['completed', 'cancelled'].includes(step.status));
  return PlanDraftSchema.parse({ ...plan, revision: plan.revision + 1, subjects, steps, issues, activeStepId: activeStep?.id, lastMessageId: input.messageId, status: issues.some(issue => issue.blocking) ? 'blocked' : activeStep ? 'ready' : 'completed' });
}

/** Skip only the current unfinished step; completed steps and future steps cannot be skipped out of order. */
export function skipPlanStep(planInput: PlanDraft, stepId: string): PlanDraft {
  const plan = PlanDraftSchema.parse(planInput);
  const active = plan.steps.find(step => !['completed', 'cancelled'].includes(step.status));
  if (!active) throw new Error('办理计划已经没有可跳过的步骤');
  if (active.id !== stepId) throw new Error('只能按顺序跳过当前步骤');
  const cancelled = plan.steps.map(step => step.id === stepId ? { ...step, status: 'cancelled' as const, previewId: undefined } : step);
  const next = cancelled.find(step => !['completed', 'cancelled'].includes(step.status));
  const steps = cancelled.map(step => next && step.id === next.id ? { ...step, status: 'ready' as const } : step);
  return PlanDraftSchema.parse({
    ...plan,
    revision: plan.revision + 1,
    steps,
    activeStepId: next?.id,
    status: next ? 'partial' : 'completed',
  });
}

export function parameter(value: string | null, input: { origin?: z.infer<typeof FieldOriginSchema>; explicit?: boolean; rawText?: string; source?: z.infer<typeof SourceSchema> } = {}): z.infer<typeof ParameterSchema> {
  return ParameterSchema.parse({ value, origin: input.origin ?? 'user', explicit: input.explicit ?? true, ...(input.rawText ? { rawText: input.rawText } : {}), ...(input.source ? { source: input.source } : {}) });
}
