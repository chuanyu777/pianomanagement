import { describe, expect, it } from 'vitest';
import { buildNameMask } from '../src/graph/privacy-mask.js';

function context(userMessage: string, task: unknown = {}) {
  return { businessDate: '2026-10-28', task, userMessage };
}

const withCandidates = {
  status: 'collecting',
  operation: 'payment.preview',
  fields: {},
  candidates: [
    { id: 'a1', label: '王小明 · 主课', field: 'accountId', values: { studentName: '王小明', courseName: '主课' } },
    { id: 'a2', label: '王小明 · 陪练', field: 'accountId', values: { studentName: '王小明', courseName: '陪练' } },
  ],
  references: [],
};

describe('name masking before a message leaves the process', () => {
  it('replaces known names in the message and in the task payload', () => {
    const mask = buildNameMask(context('给王小明主课交1000', withCandidates));

    expect(mask.maskedNameCount).toBeGreaterThan(0);
    expect(mask.maskedContext.userMessage).not.toContain('王小明');
    expect(JSON.stringify(mask.maskedContext)).not.toContain('王小明');
    expect(mask.maskedContext.userMessage).toContain('实体');
  });

  it('restores the exact original names from the model output', () => {
    const mask = buildNameMask(context('给王小明主课交1000', withCandidates));
    const restored = mask.restoreIntent({
      mode: 'new',
      operation: 'payment.preview',
      fields: { studentName: mask.maskedContext.userMessage.includes('实体1') ? '实体1' : '实体2', amount: '1000' },
      question: null,
    });

    expect(restored.fields['studentName']).toBe('王小明');
    expect(restored.fields['amount']).toBe('1000');
  });

  it('handles a name that is a prefix of another name without corrupting either', () => {
    const task = {
      candidates: [
        { id: 's1', label: '小明 · 主课', field: 'studentId', values: { studentName: '小明' } },
        { id: 's2', label: '小明光 · 主课', field: 'studentId', values: { studentName: '小明光' } },
      ],
      references: [],
    };
    const mask = buildNameMask(context('查小明光的余额', task));

    expect(mask.maskedContext.userMessage).not.toContain('小明光');
    const restored = mask.restoreIntent({
      mode: 'new',
      operation: 'accounts.read',
      fields: { studentName: mask.maskedContext.userMessage.replace(/^查|的余额$/gu, '') },
      question: null,
    });
    expect(restored.fields['studentName']).toBe('小明光');
  });

  it('leaves the context untouched when nothing is known yet', () => {
    const original = context('新增一个学生叫林小雨');
    const mask = buildNameMask(original);

    expect(mask.maskedNameCount).toBe(0);
    expect(mask.maskedContext).toBe(original);
    expect(mask.maskedContext.userMessage).toBe('新增一个学生叫林小雨');
  });
});
