import { describe, expect, it, vi } from 'vitest';
import { createModelMultiStepInterpreter, deterministicMultiStep, DialogueMultiStepPlanSchema } from '../src/graph/dialogue-multi-step.js';

describe('两步任务类型化理解', () => {
  it('单动作返回null，不消耗为多步骤任务', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: 'null' });
    await expect(createModelMultiStepInterpreter({ invoke } as never)({ userMessage: '给林悦主课交费100元', task: {} })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('只接受白名单内且恰好两步的有序计划', async () => {
    const plan = { steps: [
      { operation: 'payment.preview', fields: { studentName: '小雨', courseName: '主课', amount: '1000', channel: '微信' } },
      { operation: 'lesson.schedule', fields: { studentName: '小雨', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T15:00:00+08:00' } },
    ] };
    const invoke = vi.fn().mockResolvedValue({ content: JSON.stringify(plan) });
    await expect(createModelMultiStepInterpreter({ invoke } as never)({ userMessage: '先交费再排课', task: {} })).resolves.toEqual(plan);
  });

  it.each([
    [{ operation:'ledger-entry.reversal',fields:{studentName:'林悦',courseName:'主课',amount:'1000',kind:'交费',reason:'记错'} },{ operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'800',channel:'微信'} }],
    [{ operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2026-10',reason:'支付登记错误'} },{ operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-10',paidAt:'2026-10-21T00:00:00+08:00',channel:'银行卡'} }],
  ] as const)('接受冻结需求中的纠错两步组合', (first,second) => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[first,second]}).success).toBe(true);
  });
  it('确定性识别交费和工资纠错的有序两步并规范月份、日期和原因', () => {
    expect(deterministicMultiStep('刚才林悦主课1000元那笔记错了，应该是800元。','2026-10-21')).toEqual({steps:[
      {operation:'ledger-entry.reversal',fields:{studentName:'林悦',courseName:'主课',amount:'1000',kind:'交费',reason:'纠正错误交费登记'}},
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'800',channel:null}},
    ]});
    expect(deterministicMultiStep('王老师10月工资支付登记错了，取消那次，改成10月21日银行卡。','2026-10-21')).toEqual({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2026-10',reason:'纠正错误工资支付登记'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-10',paidAt:'2026-10-21',channel:'银行卡'}},
    ]});
  });

  it('非法组合只修复一次，第二次仍非法则有界失败', async () => {
    const invalid = { steps: [
      { operation: 'gift.preview', fields: { amount: '10' } },
      { operation: 'lesson.schedule', fields: { startsAt: '2026-10-22T15:00:00+08:00' } },
    ] };
    const invoke = vi.fn().mockResolvedValue({ content: JSON.stringify(invalid) });
    await expect(createModelMultiStepInterpreter({ invoke } as never)({ userMessage: '先赠送再排课', task: {} })).rejects.toThrow('AI_MULTI_STEP_INVALID');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(DialogueMultiStepPlanSchema.safeParse(invalid).success).toBe(false);
  });
});
