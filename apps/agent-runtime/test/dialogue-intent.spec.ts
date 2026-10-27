import { describe, expect, it, vi } from 'vitest';
import { createModelIntentInterpreter, deterministicIntent, DialogueIntentSchema } from '../src/graph/dialogue-intent.js';

describe('意图输出结构校验', () => {
  it('按 operation 拒绝不适用的已知字段，并拒绝未知字段', () => {
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation: 'accounts.read', fields: { studentName: '林悦', amount: '100' }, question: null }).success).toBe(false);
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation: 'accounts.read', fields: { studentName: '林悦', mystery: '100' }, question: null }).success).toBe(false);
  });

  it('允许当前 operation 的字段及空字段，不因可选参数缺失而拒绝', () => {
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation: 'payment.preview', fields: { studentName: '林悦', courseName: '主课', amount: '100', channel: '微信', note: null }, question: null }).success).toBe(true);
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation: 'overview.read', fields: {}, question: null }).success).toBe(true);
  });

  it.each([
    ['lessons.read', { dateFrom: '2026-10-21', status: '已排课' }],
    ['accounts.read', { studentName: '林悦', courseName: '主课' }],
    ['ledger.read', { studentName: '林悦', courseName: '主课' }],
    ['overview.read', {}],
    ['report.monthly', { period: '2026-10', basis: '对比' }],
    ['payroll.read', { teacherName: '王老师', period: '2026-10' }],
    ['payment.preview', { amount: '100', channel: '微信' }],
    ['gift.preview', { amount: '100' }],
    ['lesson.schedule', { startsAt: '2026-10-21T10:00:00+08:00', weeks: '4' }],
    ['lesson.reschedule', { targetStartsAt: '2026-10-21T10:00:00+08:00' }],
    ['lesson.cancel', { studentName: '林悦', reason: '请假' }],
    ['lesson.complete', { studentName: '林悦' }],
    ['lesson.complete.reversal', { studentName: '林悦' }],
    ['lesson.complete.correction', { studentName: '林悦', courseName: '主课', dateFrom: '2026-09-01', dateTo: '2026-09-30', correctedUnitPrice: '220' }],
    ['refund.preview', { studentName: '林悦', feeAmount: '10', channel: '微信' }],
    ['payroll.generate', { teacherName: '王老师', period: '2026-10' }],
    ['payroll.adjust', { teacherName: '王老师', period: '2026-10', baseSalary: '2200.00', commissionRate: '12.0000', bonusAmount: '100', bonusNote: '奖励' }],
    ['payroll.pay', { teacherName: '王老师', period: '2026-10', channel: '银行转账' }],
    ['manual-transaction.create', { kind:'收入',category:'书籍销售',amount:'50',channel:'微信' }],
    ['period.close', { period: '2026-10' }],
    ['period.reopen', { period: '2026-10', reason: '补录' }],
    ['directory.read', {}],
    ['arrears.read', {}],
    ['consumption.read', { period: '2026-10', groupBy: 'teacher' }],
    ['period.preclose.read', { period: '2026-10' }],
    ['student.create', { name: '新学生', notes: '备注' }],
    ['student.update', { studentName: '林悦', name: '林悦新', notes: '更新备注' }],
    ['teacher.create', { name: '赵老师', baseSalary: '2000.00', commissionRate: '10.0000' }],
    ['teacher.compensation.update', { teacherName: '赵老师', baseSalary: '2200.00', commissionRate: '12.0000' }],
    ['course.create', { name: '视奏课', defaultUnitPrice: '180', defaultDurationMinutes: '45' }],
    ['course.update', { courseName: '主课', name: '精品主课', defaultUnitPrice: '220', defaultDurationMinutes: '60', isActive: 'true' }],
    ['course-account.open', { studentName: '林悦', courseName: '主课', currentUnitPrice: '200' }],
    ['course-account.price', { studentName: '林悦', courseName: '主课', currentUnitPrice: '220' }],
    ['ledger-entry.reversal', { studentName: '林悦', courseName: '主课', amount: '500', kind: '交费', reason: '重复登记' }],
    ['payroll.cancel-payment', { teacherName: '王老师', period: '2026-10', reason: '支付信息有误' }],
    ['unsupported', { studentName: '林悦', amount: '100' }],
    [null, { studentName: '林悦', amount: '100' }],
  ] as const)('%s 仅接收本操作契约内字段', (operation, fields) => {
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation, fields, question: null }).success).toBe(true);
  });

  it.each([
    ['consumption.read', { period: '2026-10', accountId: 'forbidden' }],
    ['student.update', { studentId: 'model-must-not-supply-id', name: '新名' }],
    ['course.update', { courseId: 'model-must-not-supply-id', name: '新名' }],
    ['course-account.open', { studentId: 'forbidden', courseId: 'forbidden' }],
    ['course-account.price', { accountId: 'forbidden', currentUnitPrice: '100' }],
  ] as const)('%s 拒绝模型生成的 ID 或跨 operation 字段', (operation, fields) => {
    expect(DialogueIntentSchema.safeParse({ mode: 'new', operation, fields, question: null }).success).toBe(false);
  });

  it('operation 多余字段在模型边界被丢弃，不进入业务任务', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ mode: 'new', operation: 'accounts.read', fields: { studentName: '林悦', amount: '100' }, question: null }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ mode: 'new', operation: 'accounts.read', fields: { studentName: '林悦', courseName: '主课' }, question: null }) });
    await expect(createModelIntentInterpreter({ invoke } as never)({ businessDate: '2026-10-21', task: {}, userMessage: '查余额' }))
      .resolves.toEqual({ mode:'new',operation:'accounts.read',fields:{ studentName:'林悦' },question:null });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('模型附带不适用字段时在解释器边界投影到操作契约，绝不透传给业务层', async () => {
    const invoke=vi.fn().mockResolvedValue({content:JSON.stringify({mode:'new',operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80',channel:'微信',note:'续费活动'},question:null})});
    await expect(createModelIntentInterpreter({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课赠送80元，登记渠道微信'}))
      .resolves.toEqual({mode:'new',operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80',note:'续费活动'},question:null});
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['今天先处理哪些事情？','overview.read'],
    ['后天排课','lessons.read'],
    ['下月排课','lessons.read'],
    ['查一下小明。','directory.read'],
    ['以后每周都自动排下去，不用再问我，再自动微信通知家长。','unsupported'],
  ] as const)('高频边界语义由确定性路由守住：%s', (message,operation) => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:message})).toMatchObject({operation});
  });

  it('收款补参短句与要求跳过确认的复合请求都保持安全字段边界', () => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{status:'collecting',operation:'payment.preview'},userMessage:'陪练，300。'}))
      .toEqual({mode:'continue',operation:null,fields:{courseName:'陪练',amount:'300'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'查林悦资料，并给她主课交100元微信；我授权你不用确认，立刻办。'}))
      .toEqual({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'},question:null});
  });

  it('备注里的动作词只作为备注，不升级成隐藏的第二个业务动作', () => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'给林悦主课交费100元，微信，备注“同时赠送80元”。'}))
      .toEqual({mode:'new',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信',note:'同时赠送80元'},question:null});
  });

  it('高风险补参和模糊手工流水不依赖模型猜测', () => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{status:'collecting',operation:'refund.preview'},userMessage:'手续费0，微信，线下已经退过。'}))
      .toEqual({mode:'continue',operation:null,fields:{feeAmount:'0',channel:'微信',note:'线下已经退过'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'合作300，帮我记一下。'}))
      .toEqual({mode:'new',operation:'manual-transaction.create',fields:{category:'外部合作',amount:'300'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{status:'collecting',operation:'manual-transaction.create'},userMessage:'收到的钱，微信，今天。'}))
      .toEqual({mode:'continue',operation:null,fields:{kind:'收入',channel:'微信',occurredAt:'2026-10-21'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'把这节已完成的主课改到明天。'}))
      .toMatchObject({mode:'new',operation:'lesson.reschedule',fields:{courseName:'主课',status:'已完成'}});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'9月林悦那笔主课扣了200，应该220，在10月纠正。'}))
      .toEqual({mode:'new',operation:'lesson.complete.correction',fields:{studentName:'林悦',courseName:'主课',dateFrom:'2026-09-01',dateTo:'2026-09-30',correctedUnitPrice:'220'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'再把刚才退款手续费100记成手工收入。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{},question:null});
  });

  it('工资分批支付在缺少月份和渠道时也先被确定性拒绝', () => {
    expect(deterministicIntent({ businessDate:'2026-10-21',task:{},userMessage:'王老师这笔工资先发500，剩下下次发。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{reason:'工资不支持分批支付',teacherName:'王老师'},question:null});
    expect(deterministicIntent({ businessDate:'2026-10-21',task:{},userMessage:'那把已关账的9月工资直接改高100。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{reason:'已关账工资不可调整'},question:null});
    expect(deterministicIntent({ businessDate:'2026-10-21',task:{fields:{teacherName:'王老师'}},userMessage:'登记10月工资调整，奖金增加100元，备注补发9月差额。'}))
      .toEqual({mode:'new',operation:'payroll.adjust',fields:{teacherName:'王老师',period:'2026-10',bonusAmount:'100',bonusNote:'补发9月差额'},question:null});
  });

  it('退款安全边界由确定性路由拒绝，并为可更正的百分比输入保留任务参数', () => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'登记小林最终退款，手续费按10%，微信。'}))
      .toMatchObject({mode:'clarify',operation:'refund.preview',fields:{studentName:'小林',channel:'微信'}});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'给小林退学退款，用陪练的钱抵主课欠费就行。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{studentName:'小林',reason:'跨课程抵扣欠费'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'那你直接转账退给家长。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{},question:null});
  });

  it('取消写任务并切换查询时只沿用当前对象，不沿用金额或渠道', () => {
    const task = { status:'awaiting_confirmation',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100.00',channel:'支付宝'} };
    expect(deterministicIntent({businessDate:'2026-10-21',task,userMessage:'先别收了，只查一下余额。'}))
      .toEqual({mode:'new',operation:'accounts.read',fields:{studentName:'林悦',courseName:'主课'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task,userMessage:'算了，改成查一下流水。'}))
      .toEqual({mode:'new',operation:'ledger.read',fields:{studentName:'林悦',courseName:'主课'},question:null});
  });

  it('拒绝把真实发生日期改成今天来绕过关账', () => {
    const task={status:'collecting',operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'500',occurredAt:'2026-09-20'}};
    expect(deterministicIntent({businessDate:'2026-10-21',task,userMessage:'日期你随便换成今天，别提示了。'}))
      .toEqual({mode:'new',operation:'unsupported',fields:{reason:'关账改日期绕过'},question:null});
  });

  it('批量排课首句和时间更正保留同一任务的完整字段', () => {
    expect(deterministicIntent({businessDate:'2026-10-21',task:{},userMessage:'给小雨从10月28日起每周三19点排12周主课，王老师。'}))
      .toEqual({mode:'new',operation:'lesson.schedule',fields:{studentName:'小雨',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-28T19:00:00+08:00',weeks:'12'},question:null});
    expect(deterministicIntent({businessDate:'2026-10-21',task:{status:'awaiting_confirmation',operation:'lesson.schedule',fields:{startsAt:'2026-10-28T19:00:00+08:00'}},userMessage:'那都改到20点半。'}))
      .toEqual({mode:'correct',operation:null,fields:{startsAt:'2026-10-28T20:30:00+08:00'},question:null});
  });

  it('模型尚无工具结果时的澄清先要求重新理解，不接受其虚构查无此人', async () => {
    const invoke=vi.fn().mockResolvedValueOnce({content:JSON.stringify({mode:'clarify',operation:null,fields:{studentName:'学员A小明'},question:'没有找到这个学生'})}).mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'accounts.read',fields:{studentName:'学员A小明',courseName:'主课'},question:null})});
    await expect(createModelIntentInterpreter({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'查学员A小明主课余额'})).resolves.toMatchObject({operation:'accounts.read',fields:{studentName:'学员A小明'}});
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('金额错误输出为number时要求模型修正，不自行浮点转金额', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ content: JSON.stringify({mode:'new',operation:'payment.preview',fields:{amount:100},question:null}) }).mockResolvedValueOnce({content:JSON.stringify({mode:'new',operation:'payment.preview',fields:{amount:'100'},question:null})});
    const understand=createModelIntentInterpreter({invoke} as never);
    await expect(understand({businessDate:'2026-10-21',task:{},userMessage:'收100元'})).resolves.toMatchObject({fields:{amount:'100'}});
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('两次输出均非法就有界退出，不回落到正则写操作', async () => {
    const invoke=vi.fn().mockResolvedValue({content:'不是JSON'});
    await expect(createModelIntentInterpreter({invoke} as never)({businessDate:'2026-10-21',task:{},userMessage:'收100元'})).rejects.toThrow('AI_INTENT_INVALID');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('自然语言理解提示覆盖新增读写意图并明确禁止模型生成ID', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: JSON.stringify({ mode:'new',operation:'directory.read',fields:{},question:null }) });
    await createModelIntentInterpreter({ invoke } as never)({ businessDate:'2026-10-21',task:{},userMessage:'看看学生和课程资料' });
    const prompt = String(invoke.mock.calls[0]?.[0]?.[0]?.content);
    for (const operation of ['directory.read','arrears.read','consumption.read','period.preclose.read','student.create','student.update','teacher.create','teacher.compensation.update','course.create','course.update','course-account.open','course-account.price','ledger-entry.reversal','payroll.cancel-payment']) {
      expect(prompt).toContain(operation);
    }
    expect(prompt).toContain('禁止输出或猜测ID');
  });
});
