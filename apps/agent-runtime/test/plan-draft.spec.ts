import { describe, expect, it } from 'vitest';
import { applySubjectNameCorrection } from '../src/graph/plan-draft.js';

describe('办理对象的姓名更正', () => {
  it('只更正指定对象，保留引用它的后续步骤及其他对象', () => {
    const plan = { revision: 1, subjects: [{ id: 's1', name: '张娇娇' }, { id: 's2', name: '李小雨' }], steps: [{ id: 'a', subjectId: 's1' }, { id: 'b', subjectId: 's1' }, { id: 'c', subjectId: 's2' }] };
    const result = applySubjectNameCorrection(plan, { subjectId: 's1', name: '王娇娇', expectedRevision: 1 });
    expect(result.subjects).toEqual([{ id: 's1', name: '王娇娇' }, { id: 's2', name: '李小雨' }]);
    expect(result.steps).toEqual(plan.steps);
    expect(result.revision).toBe(2);
    expect(plan.subjects[0]?.name).toBe('张娇娇');
  });

  it('拒绝过期版本、未知对象与空姓名', () => {
    const plan = { revision: 2, subjects: [{ id: 's1', name: '张娇娇' }], steps: [] };
    expect(() => applySubjectNameCorrection(plan, { subjectId: 's1', name: '王娇娇', expectedRevision: 1 })).toThrow();
    expect(() => applySubjectNameCorrection(plan, { subjectId: 'unknown', name: '王娇娇', expectedRevision: 2 })).toThrow();
    expect(() => applySubjectNameCorrection(plan, { subjectId: 's1', name: ' ', expectedRevision: 2 })).toThrow();
  });
});
