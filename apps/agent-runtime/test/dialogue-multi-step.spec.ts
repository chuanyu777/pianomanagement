import { describe, expect, it, vi } from 'vitest';
import { createModelMultiStepInterpreter, deterministicMultiStep, DialogueMultiStepPlanSchema, hasRequiredStepOrder } from '../src/graph/dialogue-multi-step.js';
import { createDialogueGraph } from '../src/graph/dialogue-graph.js';

describe('两步任务类型化理解', () => {
  it('校验动作本身及其顺序，不能仅凭连接词接受模型计划', () => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[{operation:'payment.preview',fields:{}},{operation:'lesson.schedule',fields:{}}]});
    expect(hasRequiredStepOrder(plan, '先交费再排课')).toBe(true);
    expect(hasRequiredStepOrder(plan, '先排课再交费')).toBe(false);
    expect(hasRequiredStepOrder(plan, '先赠送再排课')).toBe(false);
    expect(hasRequiredStepOrder(plan, '先不要交费再排课')).toBe(false);
  });

  it('两个同类动作必须按指令中的课程对应，而非交换顺序', () => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'payment.preview',fields:{courseName:'主课'}},
      {operation:'payment.preview',fields:{courseName:'陪练'}},
    ]});
    expect(hasRequiredStepOrder(plan, '先给主课交费，再给陪练交费')).toBe(true);
    expect(hasRequiredStepOrder(plan, '先给陪练交费，再给主课交费')).toBe(false);
    expect(hasRequiredStepOrder(plan, '先交费再交费')).toBe(false);
    const amounts = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'payment.preview',fields:{amount:'1'}},
      {operation:'payment.preview',fields:{amount:'10'}},
    ]});
    expect(hasRequiredStepOrder(amounts, '先交费10元再交费100元')).toBe(false);
  });

  it('顺序颠倒的模型结果走上层澄清，不创建业务预览', async () => {
    const plan = {steps:[{operation:'payment.preview',fields:{}},{operation:'lesson.schedule',fields:{}}]};
    const model = {invoke:vi.fn().mockResolvedValue({content:JSON.stringify(plan)})};
    const tools = {createPaymentPreview:vi.fn(),createSingleLessonPreview:vi.fn()};
    const graph = createDialogueGraph({capability:'cap',tools:tools as never,understandMultiStep:createModelMultiStepInterpreter(model as never)});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'先排课再交费',previous:{}}});
    expect(result.answer).toContain('补充每项业务及办理顺序');
    expect(result.task.multiStep).toBeUndefined();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(tools.createSingleLessonPreview).not.toHaveBeenCalled();
  });

  it('三步逐项匹配，无法分辨工资调整还是支付时拒绝猜测', () => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'course-account.open',fields:{}},{operation:'payment.preview',fields:{}},{operation:'lesson.schedule',fields:{}},
    ]});
    expect(hasRequiredStepOrder(plan, '先开户，再交费，然后排课')).toBe(true);
    expect(hasRequiredStepOrder(plan, '先排课，再交费，然后开户')).toBe(false);
    for (const operation of ['payroll.adjust','payroll.pay'] as const) {
      const payroll = DialogueMultiStepPlanSchema.parse({steps:[{operation:'payroll.generate',fields:{}},{operation,fields:{}}]});
      expect(hasRequiredStepOrder(payroll, '先生成王老师10月工资，再办理工资')).toBe(false);
    }
  });

  it.each([
    ['ledger-entry.reversal','payment.preview','先冲正交费再登记交费'],
    ['ledger-entry.reversal','gift.preview','先冲正赠送再赠送'],
    ['payroll.cancel-payment','payroll.pay','先撤销工资支付再登记工资支付'],
    ['payroll.generate','payroll.adjust','先生成工资再调整工资'],
    ['payroll.generate','payroll.pay','先生成工资再支付工资'],
  ])('明确动作组合 %s 到 %s 保持可用', (first, second, message) => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[{operation:first,fields:{}},{operation:second,fields:{}}]});
    expect(hasRequiredStepOrder(plan, message)).toBe(true);
  });
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
    expect(deterministicMultiStep('王老师2026年10月工资支付登记错了，取消那次，改成2026年10月21日银行卡。','2026-10-21')).toEqual({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2026-10',reason:'纠正错误工资支付登记'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-10',paidAt:'2026-10-21',channel:'银行卡'}},
    ]});
  });

  it('工资纠错不从业务当前日推测工资月份或支付日期的年份', () => {
    const plan = deterministicMultiStep('王老师12月工资支付登记错了，取消那次，改成1月5日银行卡。', '2026-01-10');
    expect(plan?.steps[0]?.fields.period).toBeNull();
    expect(plan?.steps[1]?.fields.paidAt).toBeNull();
    expect(deterministicMultiStep('王老师2025年12月工资支付登记错了，取消那次，改成2026年1月5日银行卡。', '2026-01-10')).toEqual({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'纠正错误工资支付登记'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
  });

  it.each([
    '王老师2025年12月工资支付登记错了，取消那次，改成1月5日银行卡。',
    '王老师12月工资支付登记错了，取消那次，改成2026年1月5日银行卡。',
    '王老师2025年12月工资支付登记错了，取消那次，改成2026年2月30日银行卡。',
  ])('工资月份和支付日期必须各自明确且有效：%s', async (message) => {
    const graph = createDialogueGraph({capability:'cap',tools:{} as never,now:()=>new Date('2026-01-10T04:00:00Z')});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message,previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
  });

  it('缺少年份的工资纠错先澄清，不能查询工资或生成预览', async () => {
    const tools = {getPayrollCandidates:vi.fn(),createStructuredActionPreview:vi.fn()};
    const graph = createDialogueGraph({capability:'cap',tools:tools as never,now:()=>new Date('2026-01-10T04:00:00Z')});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'王老师12月工资支付登记错了，取消那次，改成1月5日银行卡。',previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
    expect(tools.getPayrollCandidates).not.toHaveBeenCalled();
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('模型为工资纠错猜测年份时也不能建立计划或生成预览', async () => {
    const tools = {getPayrollCandidates:vi.fn(),createStructuredActionPreview:vi.fn()};
    const understandMultiStep = vi.fn().mockResolvedValue({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2026-12',reason:'支付登记错误'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const graph = createDialogueGraph({capability:'cap',tools:tools as never,understandMultiStep,now:()=>new Date('2026-01-10T04:00:00Z')});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'先撤销王老师12月工资支付，再登记1月5日银行卡支付',previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
    expect(tools.getPayrollCandidates).not.toHaveBeenCalled();
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('不能把备注中的日期当成纠错后的支付日期', async () => {
    const understandMultiStep = vi.fn().mockResolvedValue({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'支付登记错误'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const graph = createDialogueGraph({capability:'cap',tools:{} as never,understandMultiStep});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'先撤销王老师2025年12月工资支付，再登记1月5日银行卡支付，备注：2026年1月5日',previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
  });

  it('非法组合只修复一次，第二次仍非法则有界失败', async () => {
    const invalid = { steps: [
      { operation: 'gift.preview', fields: { amount: '10' } },
      { operation: 'payroll.pay', fields: { period: '2026-10' } },
    ] };
    const invoke = vi.fn().mockResolvedValue({ content: JSON.stringify(invalid) });
    await expect(createModelMultiStepInterpreter({ invoke } as never)({ userMessage: '先赠送再付工资', task: {} })).rejects.toThrow('AI_MULTI_STEP_INVALID');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(DialogueMultiStepPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it.each([
    ['gift.preview', 'lesson.schedule'],
    ['payroll.generate', 'payroll.adjust'],
    ['payroll.generate', 'payroll.pay'],
  ])('支持显式有序的 %s 到 %s', (first, second) => {
    expect(DialogueMultiStepPlanSchema.safeParse({ steps:[{operation:first,fields:{}},{operation:second,fields:{}}] }).success).toBe(true);
  });

  it('新组合缺少明确先后顺序时不接受模型猜测', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: JSON.stringify({steps:[
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80'}},
      {operation:'lesson.schedule',fields:{studentName:'林悦',courseName:'主课'}},
    ]}) });
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'林悦主课赠送80元并排课',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });

  it.each([
    ['course-account.open','payment.preview'], ['course-account.open','gift.preview'],
    ['course-account.open','lesson.schedule'], ['payroll.adjust','payroll.pay'],
    ['ledger-entry.reversal','gift.preview'],
  ])('允许有序办理 %s 后的 %s', (first,second) => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[{operation:first,fields:{}},{operation:second,fields:{}}]}).success).toBe(true);
  });

  it('允许有明确顺序的三步链，但拒绝未授权相邻组合和超过三步', () => {
    const open = {operation:'course-account.open',fields:{}};
    const pay = {operation:'payment.preview',fields:{}};
    const lesson = {operation:'lesson.schedule',fields:{}};
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,pay,lesson]}).success).toBe(true);
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,lesson,pay]}).success).toBe(false);
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,pay,lesson,pay]}).success).toBe(false);
  });

  it('三步计划不能用一个顺序词伪装为全部有序', async () => {
    const plan = {steps:[{operation:'course-account.open',fields:{}},{operation:'payment.preview',fields:{}},{operation:'lesson.schedule',fields:{}}]};
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify(plan)});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'先开户再交费和排课',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });

  it('确定性识别不得把含后续排课的请求截断成单纯交费赠送', () => {
    expect(deterministicMultiStep('林悦主课收100元送20元然后排课','2026-10-21')).toBeNull();
  });
  it('交费赠送的支付渠道只从办理指令读取，不从备注猜测', () => {
    const withoutChannel = deterministicMultiStep('林悦主课收100元送20元，备注：客户提到现金','2026-10-21');
    expect(withoutChannel?.steps[0]?.fields.channel).toBeNull();
    const withChannel = deterministicMultiStep('林悦主课微信收100元送20元，备注：客户提到现金','2026-10-21');
    expect(withChannel?.steps[0]?.fields.channel).toBe('微信');
  });
  it('模型不得把有两个先后连接词的请求压缩成两步', async () => {
    const plan = {steps:[{operation:'payment.preview',fields:{}},{operation:'gift.preview',fields:{}}]};
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify(plan)});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'先开户再交费然后赠送',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });
  it.each([
    ['payment.preview','gift.preview'], ['payment.preview','lesson.schedule'], ['payment.preview','payment.preview'],
    ['ledger-entry.reversal','payment.preview'], ['payroll.cancel-payment','payroll.pay'],
  ])('原有组合 %s 到 %s 也不能猜测顺序', async (first,second) => {
    const invoke = vi.fn().mockResolvedValue({content:JSON.stringify({steps:[{operation:first,fields:{}},{operation:second,fields:{}}]})});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'这两件事都办一下',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });
});
