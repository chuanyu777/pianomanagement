import { describe, expect, it, vi } from 'vitest';
import { createModelMultiStepInterpreter, deterministicMultiStep, DialogueMultiStepPlanSchema, hasRequiredStepOrder } from '../src/graph/dialogue-multi-step.js';
import { createDialogueGraph } from '../src/graph/dialogue-graph.js';

function rejectedByModelReview(plan: unknown) {
  const invoke=vi.fn().mockResolvedValueOnce({content:JSON.stringify(plan)})
    .mockResolvedValueOnce({content:JSON.stringify({decision:'clarify'})});
  return createModelMultiStepInterpreter({invoke} as never);
}

describe('两步任务类型化理解', () => {
  it('多步时间由模型结合业务日期解析', async () => {
    const invoke=vi.fn().mockResolvedValueOnce({content:'null'}).mockResolvedValueOnce({content:JSON.stringify({decision:'single'})});
    await createModelMultiStepInterpreter({invoke} as never)({userMessage:'查询明天排课',task:{},businessDate:'2026-10-21'});
    expect(JSON.parse(invoke.mock.calls[0]![0][1].content).businessDate).toBe('2026-10-21');
  });
  it.each(['student.create','student.update','teacher.create','teacher.compensation.update','course.create','course.update','course-account.price','lesson.reschedule','lesson.cancel','lesson.complete','lesson.complete.reversal','lesson.complete.correction','refund.preview','manual-transaction.create','period.close','period.reopen'])('支持已实现的写操作 %s 参与计划', operation => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[{operation,fields:{}},{operation:'payment.preview',fields:{}}]}).success).toBe(true);
  });
  it.each(['unsupported'])('不能把 %s 当作计划步骤', operation => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[{operation,fields:{}},{operation:'payment.preview',fields:{}}]}).success).toBe(false);
  });
  it.each(['lessons.read','accounts.read','ledger.read','overview.read','report.monthly','payroll.read','directory.read','arrears.read','consumption.read','period.preclose.read'])('查询 %s 可以作为计划步骤', operation => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[{operation,fields:{}},{operation:'payment.preview',fields:{}}]}).success).toBe(true);
  });
  it('使用独立模型审核接受口语顺序，并对错序、否定和遗漏澄清', async () => {
    const plan = {steps:[{operation:'payment.preview',fields:{}},{operation:'gift.preview',fields:{}}]};
    for (const [message, verdict] of [['先把款收了，完事儿给点赠额','approve'],['先赠后收','clarify'],['款别收了，赠额照办','clarify'],['收款赠额还有排课都办了','clarify']] as const) {
      const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify(plan)}).mockResolvedValueOnce({content:JSON.stringify({decision:verdict})});
      const interpreter = createModelMultiStepInterpreter({invoke} as never);
      if (verdict === 'approve') await expect(interpreter({userMessage:message,task:{}})).resolves.toEqual(plan);
      else await expect(interpreter({userMessage:message,task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
      expect(invoke).toHaveBeenCalledTimes(2);
    }
  });
  it('候选为空仍需审核，遗漏动作及审核格式错误均不能转为单步', async () => {
    for (const content of ['{"decision":"clarify"}', 'null', '{"decision":"approve"}']) {
      const invoke = vi.fn().mockResolvedValueOnce({content:'null'}).mockResolvedValueOnce({content});
      await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'收款后排课',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
    }
    const invoke = vi.fn().mockResolvedValueOnce({content:'null'}).mockResolvedValueOnce({content:'{"decision":"single"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'查余额',task:{}})).resolves.toBeNull();
  });
  it('审核认为遗漏动作时图不调用单动作理解或业务预览', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:'null'}).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
    const understand = vi.fn();
    const tools = {createPaymentPreview:vi.fn(),createSingleLessonPreview:vi.fn()};
    const graph = createDialogueGraph({capability:'cap',tools:tools as never,understand,understandMultiStep:createModelMultiStepInterpreter({invoke} as never)});
    const {result} = await graph.invoke({turn:{runId:'audit',threadId:'thread',message:'收款之后安排课程',previous:{}}});
    expect(result.workspace.resultKind).toBe('clarification');
    expect(understand).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(tools.createSingleLessonPreview).not.toHaveBeenCalled();
  });
  it('长历史先脱敏再摘要，保留近期原文并恢复计划中的姓名', async () => {
    const invoke = vi.fn().mockImplementation(async (messages) => ({content:messages[0].content.includes('整理对话') ? '实体1曾更正课程。' : messages[0].content.includes('独立的琴行业务计划审核员') ? '{"decision":"approve"}' : JSON.stringify({steps:[
      {operation:'gift.preview',fields:{studentName:'实体1'}}, {operation:'lesson.schedule',fields:{studentName:'实体1'}},
    ]})}));
    const history = Array.from({length:30}, (_, i) => ({role:'user' as const,content:`林悦${i} ${'字'.repeat(2000)}`}));
    const result = await createModelMultiStepInterpreter({invoke} as never)({userMessage:'先赠送再排课',task:{references:[{values:{studentName:'林悦'}}]},history});
    const sent = JSON.parse(invoke.mock.calls.at(-1)![0][1].content as string);
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('林悦');
    expect(sent.history[0].content).toContain('实体1曾更正课程');
    expect(sent.history.at(-1).content).toBe(`实体129 ${'字'.repeat(2000)}`);
    expect(result?.steps[0]?.fields.studentName).toBe('林悦');
  });
  it('历史摘要失败时不调用多步骤识别或生成计划', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('summary unavailable'));
    const history = Array.from({length:30}, () => ({role:'user' as const,content:'字'.repeat(1000)}));
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'先赠送再排课',task:{},history})).rejects.toThrow('summary unavailable');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('支持新的相邻组合及四步有序模型计划，并限制一次最多20项', async () => {
    const steps = [
      {operation:'gift.preview',fields:{}}, {operation:'payroll.pay',fields:{}},
      {operation:'lesson.schedule',fields:{}}, {operation:'payroll.generate',fields:{}},
    ];
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({steps})}).mockResolvedValueOnce({content:'{"decision":"approve"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'先赠送再支付工资然后排课接着生成工资',task:{}})).resolves.toEqual({steps});
    expect(DialogueMultiStepPlanSchema.safeParse({steps:Array.from({length:17}, () => steps[0])}).success).toBe(true);
    expect(DialogueMultiStepPlanSchema.safeParse({steps:Array.from({length:21}, () => steps[0])}).success).toBe(false);
  });

  it('工资纠错位于后续步骤时仍须验证独立的明确年份', async () => {
    const {hasExplicitPayrollCorrectionDates} = await import('../src/graph/dialogue-multi-step.js');
    const plan = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'gift.preview',fields:{}},
      {operation:'payroll.cancel-payment',fields:{period:'2025-12'}},
      {operation:'payroll.pay',fields:{period:'2025-12',paidAt:'2026-01-05'}},
    ]});
    expect(hasExplicitPayrollCorrectionDates(plan,'先赠送，然后撤销王老师12月工资支付，再登记1月5日工资支付')).toBe(false);
  });
  it('明确排除错误收款总额和另一课程时，保留两笔真实金额与渠道', () => {
    expect(deterministicMultiStep('林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信。', '2026-10-21')).toEqual({steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'}},
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80'}},
    ]});
  });

  it.each([
    '林悦主课收1000，另外送80，不是收1000；陪练不动，两项登记渠道都选微信',
    '林悦主课收1000，另外送80，不是收01000.00；陪练不动，两项登记渠道都选微信',
    '林悦主课收1000，另外送80，不是送80；陪练不动，两项登记渠道都选微信',
    '不要给林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信',
    '不想给林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信',
    '无需给林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信',
    '林悦主课收1000，另外不要送80，不是收1080；陪练不动，两项登记渠道都选微信',
    '林悦主课收1000，另外送80，不是收1080；主课不动，两项登记渠道都选微信',
    '林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信，另外退款',
    '林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信，备注：然后排课',
    '林悦主课收1000，另外送80，不是收1080；陪练不动',
  ])('否定主动作、备注、额外动作或信息不完整时不得采用例外：%s', (message) => {
    expect(deterministicMultiStep(message, '2026-10-21')).toBeNull();
  });
  it('支持明确先赠送后交费，并拒绝顺序相反或遗漏动作', () => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'gift.preview',fields:{}},{operation:'payment.preview',fields:{}},
    ]});
    expect(hasRequiredStepOrder(plan, '先赠送再交费')).toBe(true);
    expect(hasRequiredStepOrder(plan, '先交费再赠送')).toBe(false);
    expect(hasRequiredStepOrder(plan, '先赠送再交费和排课')).toBe(false);
  });

  it('混合三步中的重复交费也必须逐项核对对象或金额', () => {
    const plan = DialogueMultiStepPlanSchema.parse({steps:[
      {operation:'payment.preview',fields:{courseName:'主课'}},
      {operation:'gift.preview',fields:{}},
      {operation:'payment.preview',fields:{courseName:'陪练'}},
    ]});
    expect(hasRequiredStepOrder(plan, '先给主课交费，再赠送，然后给陪练交费')).toBe(true);
    expect(hasRequiredStepOrder(plan, '先给陪练交费，再赠送，然后给主课交费')).toBe(false);
  });

  it.each([
    '不要给林悦主课收100元送20元',
    '不想给林悦主课收100元送20元',
    '无需给林悦主课收100元送20元',
    '林悦主课不要收100元送20元',
    '林悦主课收100元不要送20元',
    '林悦主课收100元送20元并冲正',
    '林悦主课收100元送20元并支付工资',
    '林悦主课收100元送20元并退款',
    '林悦主课收100元送20元然后开户',
    '刚才林悦主课1000元那笔记错了，应该是800元，不要冲正',
  ])('确定性快捷识别不能忽略否定或其他动作：%s', (message) => {
    expect(deterministicMultiStep(message, '2026-10-21')).toBeNull();
  });
  it.each([
    '林悦主课收100元送20元，备注：然后排课',
    '林悦主课收100元送20元，备注：不要交费',
    '刚才林悦主课1000元那笔记错了，应该是800元，备注：不要冲正',
    '王老师2026年10月工资支付登记错了，取消那次，改成2026年10月21日银行卡，备注：不要支付工资',
  ])('备注包含业务动作时确定性识别不生成计划：%s', (message) => {
    expect(deterministicMultiStep(message, '2026-10-21')).toBeNull();
  });
  it.each([
    '不要给林悦主课收100元送20元',
    '先交费再赠送，备注：然后排课',
  ])('审核拒绝包含否定或备注歧义的计划：%s', async (userMessage) => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({steps:[
      {operation:'payment.preview',fields:{}},{operation:'gift.preview',fields:{}},
    ]})}).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage,task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
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
    const model = {invoke:vi.fn().mockResolvedValueOnce({content:JSON.stringify(plan)}).mockResolvedValueOnce({content:'{"decision":"clarify"}'})};
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
    const invoke = vi.fn().mockResolvedValueOnce({ content: 'null' }).mockResolvedValueOnce({content:'{"decision":"single"}'});
    await expect(createModelMultiStepInterpreter({ invoke } as never)({ userMessage: '给林悦主课交费100元', task: {} })).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('只接受白名单内且恰好两步的有序计划', async () => {
    const plan = { steps: [
      { operation: 'payment.preview', fields: { studentName: '小雨', courseName: '主课', amount: '1000', channel: '微信' } },
      { operation: 'lesson.schedule', fields: { studentName: '小雨', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T15:00:00+08:00' } },
    ] };
    const invoke = vi.fn().mockResolvedValueOnce({ content: JSON.stringify(plan) }).mockResolvedValueOnce({content:'{"decision":"approve"}'});
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
    const understandMultiStep = rejectedByModelReview({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'纠错'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const graph = createDialogueGraph({capability:'cap',tools:{} as never,understandMultiStep,now:()=>new Date('2026-01-10T04:00:00Z')});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message,previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
  });

  it('缺少年份的工资纠错先澄清，不能查询工资或生成预览', async () => {
    const tools = {getPayrollCandidates:vi.fn(),createStructuredActionPreview:vi.fn()};
    const understandMultiStep = rejectedByModelReview({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'纠错'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const graph = createDialogueGraph({capability:'cap',tools:tools as never,understandMultiStep,now:()=>new Date('2026-01-10T04:00:00Z')});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'王老师12月工资支付登记错了，取消那次，改成1月5日银行卡。',previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
    expect(tools.getPayrollCandidates).not.toHaveBeenCalled();
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('模型为工资纠错猜测年份时也不能建立计划或生成预览', async () => {
    const tools = {getPayrollCandidates:vi.fn(),createStructuredActionPreview:vi.fn()};
    const understandMultiStep = rejectedByModelReview({steps:[
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
    const understandMultiStep = rejectedByModelReview({steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'支付登记错误'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const graph = createDialogueGraph({capability:'cap',tools:{} as never,understandMultiStep});
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'先撤销王老师2025年12月工资支付，再登记1月5日银行卡支付，备注：2026年1月5日',previous:{}}});
    expect(result.answer).toContain('年份');
    expect(result.task.multiStep).toBeUndefined();
  });

  it('非法字段只修复一次，第二次仍非法则有界失败', async () => {
    const invalid = { steps: [
      { operation: 'gift.preview', fields: { invalidField: '10' } },
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
    const invoke = vi.fn().mockResolvedValueOnce({ content: JSON.stringify({steps:[
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80'}},
      {operation:'lesson.schedule',fields:{studentName:'林悦',courseName:'主课'}},
    ]}) }).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'林悦主课赠送80元并排课',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });

  it.each([
    ['course-account.open','payment.preview'], ['course-account.open','gift.preview'],
    ['course-account.open','lesson.schedule'], ['payroll.adjust','payroll.pay'],
    ['ledger-entry.reversal','gift.preview'],
  ])('允许有序办理 %s 后的 %s', (first,second) => {
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[{operation:first,fields:{}},{operation:second,fields:{}}]}).success).toBe(true);
  });

  it('允许不同相邻组合和超过三步的计划', () => {
    const open = {operation:'course-account.open',fields:{}};
    const pay = {operation:'payment.preview',fields:{}};
    const lesson = {operation:'lesson.schedule',fields:{}};
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,pay,lesson]}).success).toBe(true);
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,lesson,pay]}).success).toBe(true);
    expect(DialogueMultiStepPlanSchema.safeParse({steps:[open,pay,lesson,pay]}).success).toBe(true);
  });

  it('三步计划不能用一个顺序词伪装为全部有序', async () => {
    const plan = {steps:[{operation:'course-account.open',fields:{}},{operation:'payment.preview',fields:{}},{operation:'lesson.schedule',fields:{}}]};
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify(plan)}).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
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
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify(plan)}).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'先开户再交费然后赠送',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });
  it.each([
    ['payment.preview','gift.preview'], ['payment.preview','lesson.schedule'], ['payment.preview','payment.preview'],
    ['ledger-entry.reversal','payment.preview'], ['payroll.cancel-payment','payroll.pay'],
  ])('原有组合 %s 到 %s 也不能猜测顺序', async (first,second) => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify({steps:[{operation:first,fields:{}},{operation:second,fields:{}}]})}).mockResolvedValueOnce({content:'{"decision":"clarify"}'});
    await expect(createModelMultiStepInterpreter({invoke} as never)({userMessage:'这两件事都办一下',task:{}})).rejects.toThrow('AI_MULTI_STEP_INVALID');
  });
});
