import { describe, expect, it } from 'vitest';
import { MVP_DIALOGUE_CAPABILITIES, dialogueCapabilityStatus } from '../src/graph/dialogue-capabilities.js';

describe('冻结MVP对话能力目录', () => {
  it('独立覆盖需求用例中出现的全部读写能力且ID不重复', () => {
    const expected = [
      'overview.read','lessons.read','directory.read','accounts.read','ledger.read','arrears.read','consumption.read','report.monthly','payroll.read','period.preclose.read',
      'student.create','student.update','teacher.create','teacher.compensation.update','course.create','course.update','course-account.open','course-account.price',
      'course-account.payment','course-account.gift','ledger-entry.reversal','lesson.schedule.single','lesson.schedule.weekly-batch','lesson.reschedule','lesson.cancel','lesson.complete','lesson.complete.reversal','lesson.complete.correction',
      'student.final-refund','payroll.generate','payroll.adjust','payroll.pay','payroll.cancel-payment','manual-transaction.create','period.close','period.reopen',
    ].sort();
    const actual = MVP_DIALOGUE_CAPABILITIES.map(item => item.id);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual(expected);
  });

  it('不能把未接通能力伪装为可用', () => {
    expect(dialogueCapabilityStatus('student.create')).toBe('connected');
    expect(dialogueCapabilityStatus('student.update')).toBe('connected');
    expect(dialogueCapabilityStatus('course.create')).toBe('connected');
    expect(dialogueCapabilityStatus('course-account.price')).toBe('connected');
    expect(dialogueCapabilityStatus('course.update')).toBe('connected');
    expect(dialogueCapabilityStatus('course-account.open')).toBe('connected');
    expect(dialogueCapabilityStatus('directory.read')).toBe('connected');
    expect(dialogueCapabilityStatus('arrears.read')).toBe('connected');
    expect(dialogueCapabilityStatus('consumption.read')).toBe('connected');
    expect(dialogueCapabilityStatus('period.preclose.read')).toBe('connected');
    expect(dialogueCapabilityStatus('teacher.create')).toBe('connected');
    expect(dialogueCapabilityStatus('teacher.compensation.update')).toBe('connected');
    expect(dialogueCapabilityStatus('ledger-entry.reversal')).toBe('connected');
    expect(dialogueCapabilityStatus('payroll.cancel-payment')).toBe('connected');
    expect(dialogueCapabilityStatus('lesson.complete.correction')).toBe('connected');
    expect(dialogueCapabilityStatus('lessons.read')).toBe('connected');
  });
});
