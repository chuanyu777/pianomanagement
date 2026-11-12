import { describe, expect, it } from 'vitest';
import { applyPlanPatch, parameter, PlanDraftSchema, skipPlanStep, type PlanDraft } from '../src/graph/plan-types.js';

const base: PlanDraft = PlanDraftSchema.parse({
  schemaVersion: 1, planId: 'p1', revision: 1, status: 'collecting', subjects: [{ id: 'student-1', kind: 'student', name: '张娇娇' }],
  steps: [{ id: 'pay-1', operation: 'payment.preview', subjectId: 'student-1', fields: { studentName: parameter('张娇娇'), amount: parameter('2400') }, dependsOn: [], status: 'draft', commandRevision: 0 }], issues: [],
});

describe('计划草稿补充和更正', () => {
  it('按版本和对象引用更正姓名，并使受影响预览回到草稿', () => {
    const result = applyPlanPatch(base, {
      baseRevision: 1, turnKind: 'correct',
      subjectChanges: [{ kind: 'rename', subjectId: 'student-1', name: '王娇娇', source: { messageId: 'm2', start: 0, end: 3, quote: '姓是王' } }],
      stepChanges: [{ kind: 'set-field', stepId: 'pay-1', field: 'channel', parameter: parameter('微信') }], issues: [], evidence: [{ messageId: 'm2', start: 0, end: 3, quote: '姓是王' }],
    }, { messageId: 'm2', message: '姓是王' });
    expect(result.revision).toBe(2);
    expect(result.subjects[0]?.name).toBe('王娇娇');
    expect(result.steps[0]?.fields.channel?.value).toBe('微信');
    expect(result.steps[0]?.commandRevision).toBe(1);
    expect(result.steps[0]?.previewId).toBeUndefined();
  });

  it('拒绝过期版本、无效字段、已完成步骤和不属于本轮的原话依据', () => {
    expect(() => applyPlanPatch(base, { baseRevision: 0, turnKind: 'supplement', subjectChanges: [], stepChanges: [], issues: [], evidence: [] }, { messageId: 'm2', message: '' })).toThrow();
    expect(() => applyPlanPatch(base, { baseRevision: 1, turnKind: 'supplement', subjectChanges: [], stepChanges: [{ kind: 'set-field', stepId: 'pay-1', field: 'grossSalary', parameter: parameter('1') }], issues: [], evidence: [] }, { messageId: 'm2', message: '' })).toThrow();
    const done = PlanDraftSchema.parse({ ...base, steps: [{ ...base.steps[0], status: 'completed' }] });
    expect(() => applyPlanPatch(done, { baseRevision: 1, turnKind: 'correct', subjectChanges: [], stepChanges: [{ kind: 'set-field', stepId: 'pay-1', field: 'amount', parameter: parameter('1') }], issues: [], evidence: [] }, { messageId: 'm2', message: '' })).toThrow();
    expect(() => applyPlanPatch(base, { baseRevision: 1, turnKind: 'correct', subjectChanges: [], stepChanges: [], issues: [], evidence: [{ messageId: 'm1', start: 0, end: 1, quote: '姓' }] }, { messageId: 'm2', message: '姓是王' })).toThrow();
  });

  it('只能按顺序跳过当前步骤，并保留后续步骤', () => {
    const two = PlanDraftSchema.parse({ ...base, steps: [
      { ...base.steps[0], id: 'pay-1' },
      { ...base.steps[0], id: 'lesson-1', operation: 'lesson.schedule', fields: {}, dependsOn: ['pay-1'] },
    ], activeStepId: 'pay-1' });
    const result = skipPlanStep(two, 'pay-1');
    expect(result.revision).toBe(2);
    expect(result.steps[0]?.status).toBe('cancelled');
    expect(result.steps[1]?.status).toBe('ready');
    expect(result.activeStepId).toBe('lesson-1');
    expect(() => skipPlanStep(result, 'pay-1')).toThrow();
    expect(() => skipPlanStep(result, 'missing')).toThrow();
  });
});
