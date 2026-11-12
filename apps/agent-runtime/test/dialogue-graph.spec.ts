import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDialogueGraph, type DialogueResult } from '../src/graph/dialogue-graph.js';
import { CoreDialogueError } from '../src/tools/dialogue-tools.js';
import type { DialogueIntent } from '../src/graph/dialogue-intent.js';
import type { DialogueMultiStepPlan } from '../src/graph/dialogue-multi-step.js';
import { createIntentParser } from '../src/graph/intent-parser.js';

const accountId = '49fbcf47-c616-468a-a058-cdca1ee66025';
const lessonId = 'f77d8168-5d57-4e81-9c32-11e22e42b81c';
const teacherId = 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90';
function intent(operation: DialogueIntent['operation'], fields: Record<string, string | null>, mode: DialogueIntent['mode'] = 'new'): DialogueIntent { return { mode, operation, fields, question: null }; }
function setup(intents: DialogueIntent[], multiStep?: DialogueMultiStepPlan | null, initial?: unknown, intentParser?: ReturnType<typeof createIntentParser>) {
  const tools = {
    checkActionAccess: vi.fn().mockResolvedValue({ allowed: true }),
    getDashboardSummary: vi.fn().mockResolvedValue({ businessDate:'2026-10-21', highlights:['今日正常'] }),
    readLessons: vi.fn().mockResolvedValue({ lessons: [{ lessonId, accountId, teacherId, startsAt: '2026-10-22T01:00:00Z', endsAt: '2026-10-22T02:00:00Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', status: 'SCHEDULED', statusLabel:'待上课' }] }),
    readAccount: vi.fn().mockResolvedValue({ accountId, version:3, studentName: '林悦', courseName: '主课', currentUnitPrice: '200.00', paidBalance: '500.00', giftBalance: '80.00', totalBalance: '580.00' }),
    readAccountLedger: vi.fn().mockResolvedValue({ accountId, entries: [{ entryId:'entry-1',occurredAt:'2026-10-20T03:00:00.000Z',kind:'PAYMENT',amount:'500.00',paidDelta:'500.00',giftDelta:'0.00',note:null,operator:'owner' }] }),
    readMonthlyReport: vi.fn().mockResolvedValue({ period:'2026-10', report:{ periodStart:'2026-10-01T00:00:00.000Z',cashIncome:'1000.00',cashExpense:'300.00',cashNet:'700.00',lessonIncome:'800.00',refundFeeIncome:'20.00',manualIncome:'30.00',operatingIncome:'850.00',payrollCost:'500.00',giftCost:'50.00',manualExpense:'10.00',operatingExpense:'560.00',operatingProfit:'290.00',cashOperatingGap:'-410.00' } }),
    readMonthlyPayroll: vi.fn().mockResolvedValue({ period:'2026-10', payrolls:[{ payrollId:'payroll-1',teacherId,teacherName:'王老师',courseRevenue:'1000.00',baseSalary:'2000.00',commissionRate:'10.0000',commissionAmount:'100.00',bonusAmount:'100.00',bonusNote:'奖励',deductionAmount:'50.00',deductionNote:'代扣',grossSalary:'2200.00',netSalary:'2150.00',status:'UNPAID' }] }),
    readDirectory: vi.fn().mockResolvedValue({ students:[{ studentId:'student-core-1',name:'林悦',enrollmentStatus:'STUDYING' }], teachers:[{ teacherId,name:'王老师',isActive:true }], courses:[{ courseId:'course-core-1',name:'主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60,isActive:true }] }),
    readArrearsAndFrozen: vi.fn().mockResolvedValue({ arrears:[{ studentId:'student-core-1',studentName:'林悦',courseId:'course-core-1',courseName:'主课',paidBalance:'-20.00' }], frozenStudents:[{ studentId:'student-core-2',name:'陈晨',reason:'连续31天未完成课程' }] }),
    readMonthlyConsumption: vi.fn().mockResolvedValue({ period:'2026-10',totalAmount:'300.00',courses:[{ id:'course-core-1',name:'主课',amount:'300.00' }],teachers:[{ id:teacherId,name:'王老师',amount:'300.00' }],students:[{ id:'student-core-1',name:'林悦',amount:'300.00' }] }),
    readPeriodPreclose: vi.fn().mockResolvedValue({ period:'2026-10',closed:false,pendingLessons:[{ lessonId,studentName:'林悦',courseName:'主课',teacherName:'王老师',endsAt:'2026-10-21T03:00:00Z' }],refundAnomalies:[],missingPayrollTeachers:[],ledgerAnomalies:[],reminders:[{ code:'REVIEW',message:'请人工检查',requiresHumanJudgment:true }] }),
    getCourseAccountCandidates: vi.fn().mockResolvedValue({ candidates: [{ accountId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' }] }),
    getStudentCandidates: vi.fn().mockResolvedValue({ candidates:[{ studentId:'student-core-1',name:'林悦' }] }),
    getTeacherCandidates: vi.fn().mockResolvedValue({ candidates:[{ teacherId,name:'王老师' }] }),
    getPayrollCandidates: vi.fn().mockResolvedValue({ candidates:[{ payrollId:'49fbcf47-c616-468a-a058-cdca1ee66026',teacherId,teacherName:'王老师',period:'2026-10',status:'UNPAID' }] }),
    invalidatePreview: vi.fn().mockResolvedValue({ status: 'CANCELLED' }),
    readPreview: vi.fn().mockResolvedValue({ status: 'PENDING' }),
    createPaymentPreview: vi.fn().mockImplementation(async (_capability, command) => ({ previewId: crypto.randomUUID(), actionType: 'course-account.payment', riskLevel: 'L2', command, display: { title: '交费', summary: '核对交费', beforeBalance: { paidBalance: '500.00', giftBalance: '80.00' }, afterBalance: { paidBalance: command.amount === '100.00' ? '600.00' : '1500.00', giftBalance: '80.00' } }, expiresAt: '2026-10-21T04:00:00Z' })),
    createGiftPreview: vi.fn().mockImplementation(async (_capability, command) => ({ previewId: crypto.randomUUID(), actionType:'course-account.gift', riskLevel:'L2', command, display:{ title:'赠送',summary:'核对赠送',beforeBalance:{paidBalance:'500.00',giftBalance:'80.00'},afterBalance:{paidBalance:'500.00',giftBalance:'100.00'} },expiresAt:'2026-10-21T04:00:00Z' })),
    createSingleLessonPreview: vi.fn().mockImplementation(async (_capability, command) => ({ previewId:crypto.randomUUID(),actionType:'lesson.schedule.single',riskLevel:'L1',command,display:{title:'排课',summary:'核对排课'},expiresAt:'2026-10-21T04:00:00Z' })),
    createStructuredActionPreview: vi.fn().mockResolvedValue({ previewId: crypto.randomUUID(), actionType: 'lesson.complete', riskLevel: 'L2', display: { title: '确认上课', studentName: '林悦', startsAt: '2026-10-20T01:00:00Z', endsAt: '2026-10-20T02:00:00Z' }, expiresAt: '2026-10-21T04:00:00Z' }),
    getLessonCandidates: vi.fn().mockResolvedValue({ candidates: [{ lessonId, studentName: '林悦', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-20T01:00:00Z', status: 'SCHEDULED' }] }),
  };
  const understand = vi.fn(); for (const item of intents) understand.mockResolvedValueOnce(item);
  const createGraph = () => createDialogueGraph({ capability: 'cap', tools: tools as unknown as Parameters<typeof createDialogueGraph>[0]['tools'], understand, ...(intentParser ? {intentParser} : {}), ...(multiStep !== undefined ? { understandMultiStep: multiStep === null ? vi.fn().mockRejectedValue(new Error('AI_MULTI_STEP_INVALID')) : vi.fn().mockResolvedValue(multiStep) } : {}), now: () => new Date('2026-10-21T03:00:00Z') });
  let graph = createGraph();
  let state: unknown = initial ?? {};
  const run = async (message: string, runId = crypto.randomUUID()): Promise<DialogueResult> => {
    const { result } = await graph.invoke({ turn: { runId, threadId: 'task', message, previous: state } }); state = result.task; return result;
  };
  const restart = () => { state = JSON.parse(JSON.stringify(state)); graph = createGraph(); };
  return { tools, understand, run, restart };
}
describe('模型驱动的持续业务任务', () => {
  it('多步骤计划清楚展示待建档学生姓名', async () => {
    const flow = setup([], {steps:[{operation:'student.create',fields:{name:'张小飞'}},{operation:'payment.preview',fields:{studentName:'张小飞',courseName:'主课',amount:'2400',channel:'微信'}}]});
    const result = await flow.run('为张小飞建档并缴费2400元微信');
    expect(result.answer).toMatch(/学生建档[^；]*张小飞/u);
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('多步骤计划未确认前可跨轮更正姓名并保留原金额渠道', async () => {
    const flow = setup([intent('payment.preview', { studentName: '王娇娇' }, 'correct')], { steps: [
      { operation: 'payment.preview', fields: { studentName: '张娇娇', courseName: '主课', amount: '2400', channel: '微信' } },
      { operation: 'lesson.schedule', fields: { studentName: '张娇娇', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T09:00:00+08:00' } },
    ] });
    await flow.run('今天收了张娇娇主课2400元微信，然后排明天9点王老师主课');
    const corrected = await flow.run('说错了，姓是王');
    expect(corrected.task.planDraft?.revision).toBe(1);
    expect(corrected.task.planDraft?.subjects[0]?.name).toBe('王娇娇');
    expect(corrected.task.multiStep?.steps[0]?.fields.studentName).toBe('王娇娇');
    expect(corrected.task.multiStep?.steps[0]?.fields.amount).toBe('2400');
    expect(corrected.task.multiStep?.steps[0]?.fields.channel).toBe('微信');
    await flow.run('开始第一步');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ amount: '2400.00', channel: 'WECHAT' }));
  });
  it('跨四轮补齐同一笔新生缴费，不新建第二笔业务', async () => {
    const flow = setup([
      intent('payment.preview', { studentName: '王娇娇' }, 'correct'),
      intent('payment.preview', { channel: '微信' }, 'continue'),
      intent('payment.preview', { courseName: '主课', currentUnitPrice: '230' }, 'continue'),
    ], { steps: [
      { operation: 'student.create', fields: { name: '张娇娇' } },
      { operation: 'payment.preview', fields: { studentName: '张娇娇', amount: '2400', channel: null, courseName: null, currentUnitPrice: null } },
    ] });
    await flow.run('今天收了一个叫张娇娇的新生缴费2400元');
    const corrected = await flow.run('说错了，姓是王');
    expect(corrected.answer).toContain('更新当前办理计划');
    expect(corrected.task.planDraft?.subjects[0]?.name).toBe('王娇娇');
    await flow.run('缴费通过微信');
    const completedDraft = await flow.run('缴费是主课，然后单节收费230元');
    expect(completedDraft.task.multiStep?.steps[1]?.fields).toMatchObject({ studentName: '王娇娇', amount: '2400', channel: '微信', courseName: '主课', currentUnitPrice: '230' });
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('计划包含不支持动作时保留问题并阻止任何预览', async () => {
    const flow = setup([intent('payment.preview', {}, 'continue'), intent('payment.preview', { studentName: '王娇娇' }, 'correct')], { steps: [
      { operation: 'payment.preview', fields: { studentName: '张娇娇', courseName: '主课', amount: '2400', channel: '微信' } },
      { operation: 'lesson.schedule', fields: { studentName: '张娇娇', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T09:00:00+08:00' } },
    ], issues: [{ code: 'unsupported', message: '自动发送微信通知不支持', blocking: true }] });
    const result = await flow.run('收款、排课并自动通知家长');
    expect(result.workspace.resultKind).toBe('clarification');
    expect(result.answer).toContain('自动发送微信通知不支持');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.tools.createSingleLessonPreview).not.toHaveBeenCalled();
    expect(result.task.planDraft?.status).toBe('blocked');
    expect(result.task.planDraft?.issues[0]?.message).toContain('自动发送微信通知不支持');
    expect(result.workspace.blocks.some(block => block.type === 'task-plan')).toBe(true);
    const next = await flow.run('开始第一步');
    expect(next.answer).toContain('仍有未解决问题');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    const corrected = await flow.run('说错了姓是王');
    expect(corrected.answer).toContain('仍有未解决问题');
    expect(corrected.task.planDraft?.issues[0]?.message).toContain('自动发送微信通知不支持');
  });
  it('批量计划可以明确跳过当前行，但不能越过未处理的前一行', async () => {
    const flow = setup([], { steps: [
      { operation: 'payment.preview', fields: { studentName: '林悦', courseName: '主课', amount: '100', channel: '微信' } },
      { operation: 'payment.preview', fields: { studentName: '陈晨', courseName: '主课', amount: '200', channel: '微信' } },
    ] });
    await flow.run('给林悦和陈晨分别缴费');
    const outOfOrder = await flow.run('跳过第2步');
    expect(outOfOrder.answer).toContain('只能按顺序跳过当前步骤');
    const skipped = await flow.run('跳过第1步');
    expect(skipped.answer).toContain('已跳过第1步');
    expect(skipped.task.planDraft?.steps[0]?.status).toBe('cancelled');
    expect(skipped.task.planDraft?.activeStepId).toBe('step-2');
  });
  it('批量当前行失败后显示需处理，并允许重试或跳过', async () => {
    const flow = setup([], { steps: [
      { operation: 'payment.preview', fields: { studentName: '林悦', courseName: '主课', amount: '100', channel: '微信' } },
      { operation: 'payment.preview', fields: { studentName: '陈晨', courseName: '主课', amount: '200', channel: '微信' } },
    ] });
    flow.tools.createPaymentPreview.mockRejectedValueOnce(new CoreDialogueError(503));
    await flow.run('给林悦和陈晨分别缴费');
    const failed = await flow.run('开始第一步');
    expect(failed.task.planDraft?.steps[0]?.status).toBe('failed');
    expect(failed.task.planDraft?.activeStepId).toBe('step-1');
    const skipped = await flow.run('跳过第1步');
    expect(skipped.task.planDraft?.steps[0]?.status).toBe('cancelled');
    expect(skipped.task.planDraft?.steps[1]?.status).toBe('ready');
  });
  it('多步查询完成后可以自然开始新的查询', async () => {
    const steps = [{operation:'lessons.read',fields:{dateFrom:'2026-10-21',dateTo:'2026-10-21'}},{operation:'arrears.read',fields:{}}];
    const flow = setup([intent('overview.read',{})], undefined, {status:'completed',operation:'arrears.read',multiStep:{steps,currentStep:2,completedPreviewIds:[]}});
    const result = await flow.run('看看今天经营怎么样');
    expect(result.workspace.resultKind).toBe('query');
    expect(flow.tools.getDashboardSummary).toHaveBeenCalled();
    expect(result.task.multiStep).toBeUndefined();
  });
  it('多步确认后可查询刚执行的回执，不重复生成预览', async () => {
    const previous={status:'awaiting_confirmation',operation:'payment.preview',previewId:'first',multiStep:{currentStep:0,completedPreviewIds:[],steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},
      {operation:'receipt.read',fields:{}},
    ]}};
    const flow=setup([],undefined,previous);
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED',display:{title:'交费',summary:'100.00'}});
    const result=await flow.run('继续');
    expect(result.answer).toContain('100.00');
    expect(result.task.multiStep?.currentStep).toBe(2);
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('前一步确认后，下一步的口语补参由模型理解', async () => {
    const previous={status:'awaiting_confirmation',operation:'gift.preview',previewId:'first',multiStep:{currentStep:0,completedPreviewIds:[],steps:[
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}},
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100'}},
    ]}};
    const flow=setup([intent('payment.preview',{channel:'现金'},'continue')],undefined,previous);
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await flow.run('用现钞');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({amount:'100.00',channel:'CASH'}));
  });
  it('工资纠错的相对年份由模型结合业务日期理解，不被字面年份规则拒绝', async () => {
    const flow=setup([], {steps:[{operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'登记错误'}},{operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'微信'}}]});
    const result=await flow.run('去年十二月的工资支付登记错了，撤销后改成今年一月五日微信');
    expect(result.task.multiStep?.steps).toHaveLength(2);
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('排课查询采用模型结合上下文解析的日期，不让关键词重新覆盖', async () => {
    const flow = setup([intent('lessons.read',{dateFrom:'2026-10-21',dateTo:'2026-10-21'})]);
    await flow.run('不是昨天，查今天的排课');
    expect(flow.tools.readLessons).toHaveBeenCalledWith('cap',expect.objectContaining({dateFrom:'2026-10-21',dateTo:'2026-10-21'}));
  });
  it('模型对学生指代提出澄清时直接展示问题，不查询或生成预览', async () => {
    const flow = setup([{mode:'clarify',operation:'payment.preview',fields:{amount:'100',channel:'微信'},question:'无法确定是哪位学生，请说姓名。'}]);
    const result = await flow.run('给他缴费100元微信');
    expect(result.answer).toContain('无法确定');
    expect(flow.tools.getStudentCandidates).not.toHaveBeenCalled();
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('用户否定自动通知并要求查询时，不能被关键词直接判为不支持', async () => {
    const flow = setup([intent('overview.read',{})]);
    const result = await flow.run('不要永久自动通知，只查当前经营概况');
    expect(result.workspace.resultKind).toBe('query');
    expect(flow.tools.getDashboardSummary).toHaveBeenCalled();
  });
  it('计划中间的开户和同一课程缴费合并，保留前后步骤', async () => {
    const person = {studentName:'林悦',courseName:'主课'};
    const flow = setup([], {steps:[{operation:'student.create',fields:{name:'林悦'}},{operation:'course-account.open',fields:{...person,currentUnitPrice:'180'}},{operation:'payment.preview',fields:{...person,amount:'100',channel:'微信'}},{operation:'gift.preview',fields:{...person,amount:'20'}}]});
    const result = await flow.run('先建档再开户然后缴费接着赠送');
    expect(result.task.multiStep?.steps).toEqual([
      {operation:'student.create',fields:{name:'林悦'}},
      {operation:'payment.preview',fields:{...person,currentUnitPrice:'180',amount:'100',channel:'微信'}},
      {operation:'gift.preview',fields:{...person,amount:'20'}},
    ]);
  });
  it.each(['student.create','student.update','teacher.create','teacher.compensation.update','course.create','course.update','course-account.price','payment.preview','gift.preview','ledger-entry.reversal','lesson.schedule','lesson.reschedule','lesson.cancel','lesson.complete','lesson.complete.reversal','lesson.complete.correction','refund.preview','payroll.generate','payroll.adjust','payroll.pay','payroll.cancel-payment','manual-transaction.create','period.close','period.reopen'])('%s 的确认单只有 EXECUTED 才推进', async operation => {
    const steps = [{operation,fields:{}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}}];
    const flow = setup([], undefined, {status:'awaiting_confirmation',operation,previewId:'first',multiStep:{steps,currentStep:0,completedPreviewIds:[]}});
    for (const status of ['PENDING','CONFIRMING','UNKNOWN']) {
      flow.tools.readPreview.mockResolvedValueOnce({status});
      const result = await flow.run('继续');
      expect(result.task.multiStep?.currentStep).toBe(0);
      expect(result.task.multiStep?.completedPreviewIds).toEqual([]);
      expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    }
    flow.tools.readPreview.mockResolvedValueOnce({status:'EXECUTED'});
    const result = await flow.run('继续');
    expect(result.task.multiStep?.completedPreviewIds).toEqual(['first']);
    expect(result.task.status).toBe('awaiting_confirmation');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('查询完成后保留查询结果，继续才生成写入预览，未确认不推进', async () => {
    const flow = setup([], {steps:[{operation:'accounts.read',fields:{studentName:'林悦',courseName:'主课'}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},{operation:'overview.read',fields:{}}]} as never);
    await flow.run('先查询林悦主课余额再缴费100元微信然后查看概况');
    const query = await flow.run('开始第一步');
    expect(query.workspace.resultKind).toBe('query');
    expect(query.answer).toContain('500.00');
    expect(query.task.multiStep?.currentStep).toBe(1);
    expect(query.task.multiStep?.completedPreviewIds).toEqual([]);
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    flow.restart();
    const payment = await flow.run('继续');
    expect(payment.task.status).toBe('awaiting_confirmation');
    await flow.run('继续');
    expect(flow.tools.getDashboardSummary).not.toHaveBeenCalled();
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const final = await flow.run('继续');
    expect(final.task.status).toBe('completed');
    expect(final.task.multiStep?.completedPreviewIds).toEqual([payment.task.previewId]);
    expect(final.answer).not.toContain('均已分别在Core确认执行');
  });
  it('查询失败不推进、不创建后续预览', async () => {
    const flow = setup([], {steps:[{operation:'overview.read',fields:{}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}}]} as never);
    flow.tools.getDashboardSummary.mockRejectedValueOnce(new Error('unavailable'));
    await flow.run('先查概况再缴费');
    const failed = await flow.run('开始第一步');
    expect(failed.task.multiStep?.currentStep).toBe(0);
    expect(failed.workspace.resultKind).toBe('error');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('开户合并后使用原步骤核查工资纠错年份并可重启继续', async () => {
    const person = {studentName:'林悦',courseName:'主课'};
    const flow = setup([], {steps:[{operation:'course-account.open',fields:person},{operation:'payment.preview',fields:{...person,amount:'100',channel:'微信'}},{operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'纠错'}},{operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}}]});
    await flow.run('先给林悦主课开户，再缴费100元微信，然后撤销王老师2025年12月工资支付，再登记2026年1月5日银行卡工资支付');
    flow.restart();
    const first = await flow.run('开始第一步');
    expect(first.task.status).toBe('awaiting_confirmation');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('建档和缴费各自确认后才推进，计划名称与实际操作一致', async () => {
    const flow = setup([], {steps:[{operation:'student.create',fields:{name:'林悦'}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}}]} as never);
    const planned = await flow.run('先给林悦建档再给林悦主课缴费100元微信');
    expect(planned.answer).toContain('建档');
    expect(planned.answer).not.toContain('登记工资支付');
    const first = await flow.run('开始第一步');
    expect(first.task.status).toBe('awaiting_confirmation');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    await flow.run('继续');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const second = await flow.run('继续');
    expect(second.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId]);
    expect(second.task.status).toBe('awaiting_confirmation');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    const completed = await flow.run('继续');
    expect(completed.task.status).toBe('completed');
    expect(completed.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId,second.task.previewId]);
  });
  it('模型判断为新任务时短回答不继承原学生', async () => {
    const flow = setup([intent('payment.preview',{studentName:'林悦'}), intent('payment.preview',{courseName:'陪练',amount:'300'},'new')]);
    await flow.run('给林悦交费');
    const result = await flow.run('陪练，300');
    expect(result.task.fields.studentName).toBeUndefined();
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('模型从历史解析出未确认建档学生时不得查询或预览', async () => {
    const flow = setup([intent('student.create',{name:'林悦'}), intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    await flow.run('给林悦建档');
    const result = await flow.run('给她主课交100元微信');
    expect(result.answer).toContain('建档尚未确认');
    expect(flow.tools.getStudentCandidates).not.toHaveBeenCalled();
    expect(flow.tools.getCourseAccountCandidates).not.toHaveBeenCalled();
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('建档确认后，模型理解自然说法可继续先前的缴费请求', async () => {
    const flow = setup([
      intent('student.create',{name:'林悦'}),
      intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}),
      intent('payment.preview',{},'continue'),
    ]);
    await flow.run('给林悦建档');
    await flow.run('给她主课交100元微信');
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const result = await flow.run('好的，接着办');
    expect(result.workspace.resultKind).toBe('preview');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({amount:'100.00',channel:'WECHAT'}));
  });
  it('判断是否多项业务时向模型提供建档确认状态和待续办请求', async () => {
    const pending=intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'});
    const understandMultiStep=vi.fn().mockResolvedValue(null);
    const graph=createDialogueGraph({capability:'cap',tools:{readPreview:vi.fn().mockResolvedValue({status:'EXECUTED'}),checkActionAccess:vi.fn().mockResolvedValue({allowed:true})} as never,understandMultiStep,understand:vi.fn().mockResolvedValue(intent('payment.preview',{},'continue'))});
    await graph.invoke({turn:{runId:'pending',threadId:'thread',message:'好的，接着办',previous:{status:'awaiting_confirmation',operation:'student.create',fields:{name:'林悦'},previewId:'student-preview',pendingStudentIntent:pending}}});
    expect(understandMultiStep).toHaveBeenCalledWith(expect.objectContaining({task:expect.objectContaining({alreadyExecuted:true,pendingStudentIntent:pending})}),expect.any(AbortSignal));
  });
  it('建档确认后可以取消待办理的缴费，不撤销已确认建档', async () => {
    const flow = setup([
      intent('student.create',{name:'林悦'}),
      intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}),
      intent(null,{},'cancel'),
    ]);
    await flow.run('给林悦建档');
    await flow.run('给她主课交100元微信');
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const result = await flow.run('先算了，别收钱');
    expect(result.answer).toContain('已取消');
    expect(result.answer).toContain('建档');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.tools.invalidatePreview).not.toHaveBeenCalled();
  });
  it('建档确认后更正待办理缴费的金额，仅对新预览生效', async () => {
    const flow = setup([
      intent('student.create',{name:'林悦'}),
      intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}),
      intent('payment.preview',{amount:'200'},'correct'),
    ]);
    await flow.run('给林悦建档');
    await flow.run('给她主课交100元微信');
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const result = await flow.run('金额改成200再办');
    expect(result.workspace.resultKind).toBe('preview');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({amount:'200.00',channel:'WECHAT'}));
    expect(flow.tools.invalidatePreview).not.toHaveBeenCalled();
  });
  it('合并开户缴费时保留后续所有步骤并正确展示第四步', async () => {
    const person = {studentName:'林悦',courseName:'主课'};
    const flow = setup([], {steps:[
      {operation:'course-account.open',fields:person},
      {operation:'payment.preview',fields:{...person,amount:'100',channel:'微信'}},
      {operation:'gift.preview',fields:{...person,amount:'20'}},
      {operation:'lesson.schedule',fields:person},
      {operation:'payroll.generate',fields:{teacherName:'王老师',period:'2026-10'}},
    ]});
    const result = await flow.run('先给林悦主课开户再缴费然后赠送接着排课再生成工资');
    expect(result.task.multiStep?.steps.map(step => step.operation)).toEqual(['payment.preview','gift.preview','lesson.schedule','payroll.generate']);
    expect(result.answer).toContain('第4步');
    expect(result.answer).not.toContain('undefined');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('下一轮理解时能够读取本会话的上一轮对话', async () => {
    const {run,understand} = setup([intent('student.create',{name:'林悦'}),intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    await run('给林悦建档');
    await run('给林悦主课交100元微信');
    expect(understand.mock.calls[1]?.[0].history).toEqual(expect.arrayContaining([
      expect.objectContaining({role:'user',content:'给林悦建档'}),
      expect.objectContaining({role:'assistant',content:expect.stringContaining('预览')}),
    ]));
  });
  it('独立开户引导缴费，不生成开户预览', async () => {
    const flow = setup([intent('course-account.open',{studentName:'林悦',courseName:'主课'})]);
    const result = await flow.run('给林悦开主课账户');
    expect(result.answer).toContain('缴费');
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('提出开通后补充金额和渠道，可继续生成同一学生课程的缴费预览', async () => {
    const flow = setup([intent('course-account.open',{studentName:'林悦',courseName:'主课'}),intent(null,{amount:'1000',channel:'微信'},'continue')]);
    flow.tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    await flow.run('给林悦开主课账户');
    const result = await flow.run('1000元，微信');
    expect(result.workspace.resultKind).toBe('preview');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',amount:'1000.00',channel:'WECHAT'}));
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('同一学生课程的开户和缴费合并，保留单价', async () => {
    const flow = setup([], {steps:[{operation:'course-account.open',fields:{studentName:'林悦',courseName:'主课',currentUnitPrice:'180'}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'}}]});
    const result = await flow.run('先给林悦主课开户单价180再缴费1000元微信');
    expect(result.task.operation).toBe('payment.preview');
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',amount:'1000.00',currentUnitPrice:'180.00'}));
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it.each(['studentName','courseName','currentUnitPrice'])('开户与缴费的%s冲突时澄清', async (field) => {
    const first = {studentName:'林悦',courseName:'主课',currentUnitPrice:'180'};
    const second = {...first,amount:'1000',channel:'微信',[field]:field==='studentName'?'张三':field==='courseName'?'陪练':'200'};
    const flow = setup([], {steps:[{operation:'course-account.open',fields:first},{operation:'payment.preview',fields:second}]});
    const result = await flow.run('先开户再缴费');
    expect(result.workspace.resultKind).toBe('clarification');
    expect(result.answer).toContain('无法确认一致');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it.each(['gift.preview','lesson.schedule'] as const)('%s 缺账户时指引缴费后重新发起原请求', async operation => {
    const flow = setup([intent(operation,operation==='gift.preview' ? {studentName:'林悦',courseName:'主课',amount:'20'} : {studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'})]);
    flow.tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    const result = await flow.run('办理业务');
    expect(result.answer).toContain('缴费');
    expect(result.answer).toContain('金额');
    expect(result.answer).toContain(operation==='gift.preview'?'赠送':'排课');
    expect(result.answer).toContain('重新');
    expect(result.task.status).not.toBe('completed');
  });
  it('无账户但课程不存在时不声称先缴费即可', async () => {
    const flow = setup([intent('gift.preview',{studentName:'林悦',courseName:'不存在',amount:'20'})]);
    flow.tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    const result = await flow.run('赠送');
    expect(result.answer).toContain('没有找到课程');
    expect(result.answer).not.toContain('尚无课程记录');
  });
  it.each(['gift.preview','lesson.schedule'] as const)('%s 简称先核实完整课程再找到已有账户', async operation => {
    const fields = operation==='gift.preview' ? {studentName:'林悦',courseName:'钢琴',amount:'20'} : {studentName:'林悦',courseName:'钢琴',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'};
    const flow = setup([intent(operation,fields)]);
    flow.tools.readDirectory.mockResolvedValue({students:[],teachers:[],courses:[{courseId:'course-core-1',name:'钢琴主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60,isActive:true}]});
    flow.tools.getCourseAccountCandidates.mockResolvedValueOnce({candidates:[]}).mockResolvedValueOnce({candidates:[{accountId,studentId:'student-core-1',studentName:'林悦',courseName:'钢琴主课'}]});
    const result = await flow.run('办理业务');
    expect(flow.tools.getCourseAccountCandidates).toHaveBeenLastCalledWith('cap',{studentName:'林悦',courseName:'钢琴主课',match:'search'});
    expect(result.workspace.resultKind).toBe('preview');
    expect(operation==='gift.preview' ? flow.tools.createGiftPreview : flow.tools.createSingleLessonPreview).toHaveBeenCalledWith('cap',expect.objectContaining({accountId}));
  });
  it('简称重查时不会使用同名学生的账户', async () => {
    const flow = setup([intent('gift.preview',{studentName:'林悦',courseName:'钢琴',amount:'20'})]);
    flow.tools.readDirectory.mockResolvedValue({students:[],teachers:[],courses:[{courseId:'course-core-1',name:'钢琴主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60,isActive:true}]});
    flow.tools.getCourseAccountCandidates.mockResolvedValueOnce({candidates:[]}).mockResolvedValueOnce({candidates:[{accountId,studentId:'other-student',studentName:'林悦',courseName:'钢琴主课'}]});
    const result = await flow.run('赠送');
    expect(result.answer).toContain('尚无课程记录');
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
  });
  it.each(['payroll.adjust','payroll.pay','payroll.cancel-payment'] as const)('%s 无工资候选时给出对应提示', async operation => {
    const fields = {teacherName:'王老师',period:'2026-10',...(operation==='payroll.adjust'?{baseSalary:'2000'}:{}),...(operation==='payroll.pay'?{channel:'微信'}:{}),...(operation==='payroll.cancel-payment'?{reason:'纠错'}:{})};
    const flow = setup([intent(operation,fields)]);
    flow.tools.getPayrollCandidates.mockResolvedValue({candidates:[]});
    const result = await flow.run('办理工资');
    expect(result.answer).toContain(operation==='payroll.cancel-payment'?'没有已支付工资':'先生成工资');
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it.each([403,500])('查询课程失败（%s）时不误报无账户', async status => {
    const flow = setup([intent('gift.preview',{studentName:'林悦',courseName:'主课',amount:'20'})]);
    flow.tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    flow.tools.readDirectory.mockRejectedValue(new CoreDialogueError(status));
    const result = await flow.run('赠送');
    expect(result.answer).not.toContain('尚无课程记录');
    expect(result.answer).not.toContain('先提供学生');
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
  });
  it.each([403,500])('查询账户失败（%s）时不误报无账户', async status => {
    const flow = setup([intent('lesson.schedule',{studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'})]);
    flow.tools.getCourseAccountCandidates.mockRejectedValue(new CoreDialogueError(status));
    const result = await flow.run('排课');
    expect(result.answer).not.toContain('尚无课程记录');
    expect(flow.tools.createSingleLessonPreview).not.toHaveBeenCalled();
  });
  it('开户缴费排课合并为缴费和排课两步，缴费确认前不排课', async () => {
    const flow = setup([], {steps:[{operation:'course-account.open',fields:{studentName:'林悦',courseName:'主课'}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},{operation:'lesson.schedule',fields:{studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'}}]});
    const plan = await flow.run('先给林悦开主课账户，再交费100元微信，然后排王老师明天9点主课');
    expect(plan.task.multiStep?.steps.map(step=>step.operation)).toEqual(['payment.preview','lesson.schedule']);
    await flow.run('开始第一步');
    await flow.run('继续');
    expect(flow.tools.createSingleLessonPreview).not.toHaveBeenCalled();
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await flow.run('继续');
    expect(flow.tools.createSingleLessonPreview).toHaveBeenCalledTimes(1);
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('旧的未生成开户预览计划不能新建开户预览', async () => {
    const steps = [{operation:'course-account.open',fields:{studentName:'林悦',courseName:'主课'}},{operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}}] as DialogueMultiStepPlan['steps'];
    const flow = setup([],undefined,{status:'ready',operation:'course-account.open',multiStep:{steps,currentStep:0,completedPreviewIds:[]}});
    const result = await flow.run('开始第一步');
    expect(result.answer).toContain('缴费');
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('学生存在但没有课程记录时，余额查询不误导用户核对姓名，也不写入数据', async () => {
    const {run,tools} = setup([intent('accounts.read',{studentName:'林悦'})]);
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    const result = await run('查林悦的余额');
    expect(result.answer).toContain('尚无课程记录');
    expect(result.answer).not.toContain('核对学生姓名');
    expect(tools.readAccount).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('找不到学生时提示核对或先建档，而不是创建虚构对象', async () => {
    const flow = setup([intent('payment.preview',{studentName:'不存在',courseName:'主课',amount:'100',channel:'微信'})]);
    flow.tools.getStudentCandidates.mockResolvedValue({candidates:[]});
    const result = await flow.run('给不存在主课交100元微信');
    expect(result.answer).toContain('新建学生');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('已确认建档后的代词通过真实学生候选消歧，保留交费参数', async () => {
    const {run,tools} = setup([intent('student.create',{name:'林悦'}), intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    await run('给林悦建档');
    tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const result = await run('给她主课交100元微信');
    expect(tools.getStudentCandidates).toHaveBeenCalledWith('cap',{studentName:'林悦',match:'search'});
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({accountId,amount:'100.00'}));
    expect(result.task.fields.studentName).toBe('林悦');
  });
  it('模型结合上下文解析学生和主课后经 Core 核实缴费', async () => {
    const {run,tools}=setup([intent('student.create',{name:'林悦'}),intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'2000',channel:'微信'})]);
    tools.getStudentCandidates.mockResolvedValue({candidates:[{studentId:'student-core-1',name:'林悦'}]});
    tools.readDirectory.mockResolvedValue({students:[],teachers:[],courses:[{courseId:'course-core-1',name:'主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60,isActive:true}]});
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    await run('给林悦建档');
    tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await run('他主课缴费2000元，微信');
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',amount:'2000.00'}));
  });
  it('模型未能确定代词指向时不擅自选择学生', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify(intent('student.create',{name:'林悦'}))})
      .mockResolvedValueOnce({content:JSON.stringify(intent('payment.preview',{studentName:'王小明',courseName:'主课',amount:'2000',channel:'微信'}))})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:false,unsupportedFields:[]})});
    const {run,tools}=setup([],undefined,undefined,createIntentParser({invoke} as never));
    tools.getStudentCandidates.mockResolvedValue({candidates:[{studentId:'other-student',name:'王小明'}]});
    await run('给林悦建档');
    tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const result=await run('他主课缴费2000元，微信');
    expect(result.answer).toContain('无法确定');
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('没有确定学生时不把代词当姓名，保留业务参数以便补充', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({content:JSON.stringify(intent('payment.preview',{studentName:'他',courseName:'主课',amount:'100',channel:'微信'}))})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:true,unsupportedFields:['studentName']})});
    const {run,tools} = setup([],undefined,undefined,createIntentParser({invoke} as never));
    const result = await run('给他主课交100元微信');
    expect(result.answer).toContain('学生');
    expect(result.task.fields).toMatchObject({courseName:'主课',amount:'100',channel:'微信'});
    expect(result.task.fields.studentName).toBeUndefined();
    expect(tools.getStudentCandidates).not.toHaveBeenCalled();
  });
  it('学生没有课程账户时直接生成包含学生课程的缴费预览', async () => {
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[]});
    const result = await run('给林悦主课交100元微信');
    expect(result.answer).toContain('预览');
    expect(result.task.fields).toMatchObject({studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'});
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',amount:'100.00',channel:'WECHAT'}));
  });
  it('缴费中明确给出单节价格时将价格和金额分别送入同一预览', async () => {
    const {run,tools}=setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信',currentUnitPrice:'180'})]);
    const result=await run('林悦主课交1000元微信，每节180元');
    expect(result.answer).toContain('预览');
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',amount:'1000.00',currentUnitPrice:'180.00',channel:'WECHAT'}));
  });
  it('从余额查询继续缴费并改价时仍绑定学生身份', async () => {
    const {run,tools}=setup([intent('accounts.read',{studentName:'林悦',courseName:'主课'}),intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信',currentUnitPrice:'180'})]);
    await run('查林悦主课余额');
    await run('林悦主课交1000元微信，每节180元');
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:'student-core-1',courseId:'course-core-1',currentUnitPrice:'180.00'}));
  });
  it('建档预览未执行时不将学生视作已创建或查询其账户', async () => {
    const {run,tools} = setup([intent('student.create',{name:'林悦'}),intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    await run('给林悦建档');
    const result = await run('给她主课交100元微信');
    expect(result.answer).toContain('尚未');
    expect(tools.getStudentCandidates).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await run('继续');
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({accountId,amount:'100.00'}));
  });
  it.each([true, false])('同名学生先选择身份，再仅使用所选学生的账户（有账户：%s）', async (hasAccount) => {
    const firstStudent = '3a9a42f5-7775-45ef-98f7-3f2839625551';
    const secondStudent = '3a9a42f5-7775-45ef-98f7-3f2839625552';
    const { run, tools, restart } = setup([intent('accounts.read', { studentName:'林悦', courseName:'主课' })]);
    tools.getStudentCandidates.mockResolvedValue({ candidates:[{studentId:firstStudent,name:'林悦'},{studentId:secondStudent,name:'林悦'}] });
    tools.getCourseAccountCandidates.mockResolvedValue({ candidates:[{accountId,studentId:firstStudent,studentName:'林悦',courseName:'主课'}] });
    const selection = await run('查林悦主课余额');
    expect(selection.workspace.resultKind).toBe('selection');
    expect(tools.readAccount).not.toHaveBeenCalled();
    restart();
    const result = await run(`选择候选:${hasAccount ? firstStudent : secondStudent}:${selection.task.version}`);
    if (hasAccount) expect(tools.readAccount).toHaveBeenCalledWith('cap', { accountId });
    else { expect(tools.readAccount).not.toHaveBeenCalled(); expect(result.answer).toContain('没有找到'); }
  });
  it.each(['accounts.read', 'payment.preview'] as const)('%s 选择无账户的同名学生时不读取别人的账户', async (operation) => {
    const firstStudent = '3a9a42f5-7775-45ef-98f7-3f2839625551';
    const secondStudent = '3a9a42f5-7775-45ef-98f7-3f2839625552';
    const fields = operation === 'accounts.read' ? { studentName:'林悦' } : { studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' };
    const {run,tools} = setup([intent(operation, fields)]);
    tools.getStudentCandidates.mockResolvedValue({candidates:[{studentId:firstStudent,name:'林悦'},{studentId:secondStudent,name:'林悦'}]});
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[{accountId,studentId:firstStudent,studentName:'林悦',courseName:'主课'}]});
    const selection = await run('办理林悦的业务');
    expect(selection.workspace.resultKind).toBe('selection');
    expect(tools.getCourseAccountCandidates).not.toHaveBeenCalled();
    const result = await run(`选择候选:${secondStudent}:${selection.task.version}`);
    expect(tools.readAccount).not.toHaveBeenCalled();
    if(operation==='accounts.read') { expect(result.answer).toContain('尚无课程记录'); expect(tools.createPaymentPreview).not.toHaveBeenCalled(); }
    else { expect(result.answer).toContain('预览'); expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({studentId:secondStudent,courseId:'course-core-1',amount:'100.00'})); }
  });
  it('选择同名学生后，交费预览只针对该学生的课程账户', async () => {
    const firstStudent = '3a9a42f5-7775-45ef-98f7-3f2839625551';
    const secondStudent = '3a9a42f5-7775-45ef-98f7-3f2839625552';
    const otherAccount = crypto.randomUUID();
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})]);
    tools.getStudentCandidates.mockResolvedValue({candidates:[{studentId:firstStudent,name:'林悦'},{studentId:secondStudent,name:'林悦'}]});
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[{accountId,studentId:firstStudent,studentName:'林悦',courseName:'主课'},{accountId:otherAccount,studentId:secondStudent,studentName:'林悦',courseName:'主课'}]});
    const selection = await run('给林悦主课交100元微信');
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    await run(`选择候选:${secondStudent}:${selection.task.version}`);
    expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap',expect.objectContaining({accountId:otherAccount}));
  });
  it('拒绝修改已关账工资时不编造具体月份', async () => {
    const {run,tools} = setup([{mode:'new',operation:'unsupported',fields:{reason:'已关账工资不可调整'},question:'已关账月份的工资不能直接修改；历史工资未修改。'}]);
    const result = await run('修改2026年8月已关账工资');
    expect(result.answer).toContain('已关账月份的工资不能直接修改');
    expect(JSON.stringify(result.workspace)).not.toContain('9月');
    expect(result.workspace.blocks).toContainEqual(expect.objectContaining({type:'summary',text:expect.stringContaining('历史工资未修改')}));
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('历史工资纠错计划没有明确年份来源时不能继续生成预览', async () => {
    const tools = {getPayrollCandidates:vi.fn(),createStructuredActionPreview:vi.fn()};
    const graph = createDialogueGraph({capability:'cap',tools:tools as never});
    const previous = {status:'ready',operation:'payroll.cancel-payment',lastUserMessage:'王老师12月工资登记错了，改成1月5日银行卡',multiStep:{currentStep:0,completedPreviewIds:[],steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2026-12',reason:'纠错'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]}};
    const {result} = await graph.invoke({turn:{runId:'run',threadId:'thread',message:'开始第一步',previous}});
    expect(result.answer).toContain('年份');
    expect(tools.getPayrollCandidates).not.toHaveBeenCalled();
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('跨年工资纠错保留两个明确日期，首步确认后才生成重登预览', async () => {
    const flow = setup([], {steps:[
      {operation:'payroll.cancel-payment',fields:{teacherName:'王老师',period:'2025-12',reason:'纠正错误工资支付登记'}},
      {operation:'payroll.pay',fields:{teacherName:'王老师',period:'2025-12',paidAt:'2026-01-05',channel:'银行卡'}},
    ]});
    const payrollId = '49fbcf47-c616-468a-a058-cdca1ee66026';
    flow.tools.getPayrollCandidates.mockResolvedValue({candidates:[{payrollId,teacherId,teacherName:'王老师',period:'2025-12',status:'PAID'}]});
    const plan = await flow.run('王老师2025年12月工资支付登记错了，取消那次，改成2026年1月5日银行卡。');
    expect(plan.answer).toContain('2025-12');
    expect(plan.answer).toContain('2026-01-05');
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
    const first = await flow.run('开始第一步');
    expect(flow.tools.getPayrollCandidates).toHaveBeenCalledWith('cap', {teacherName:'王老师',period:'2025-12'});
    expect(flow.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({actionType:'payroll.cancel-payment',command:expect.objectContaining({payrollId})}));
    flow.tools.readPreview.mockResolvedValueOnce({status:'PENDING'}).mockResolvedValueOnce({status:'EXECUTED'});
    await flow.run('继续');
    expect(flow.tools.createStructuredActionPreview).toHaveBeenCalledTimes(1);
    flow.tools.getPayrollCandidates.mockResolvedValue({candidates:[{payrollId,teacherId,teacherName:'王老师',period:'2025-12',status:'UNPAID'}]});
    const second = await flow.run('继续');
    expect(second.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId]);
    expect(flow.tools.createStructuredActionPreview).toHaveBeenLastCalledWith('cap', expect.objectContaining({actionType:'payroll.pay',command:expect.objectContaining({payrollId,paidAt:'2026-01-05T00:00:00+08:00',channel:'BANK_CARD'})}));
  });
  it('模型识别实收加赠送后保留两步及排除的课程', async () => {
    const flow=setup([intent('unsupported',{})], {steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'}},
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80'}},
    ]});
    const result=await flow.run('林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信。');
    expect(result.answer).toContain('第一步交费（主课1000.00元，微信）');
    expect(result.answer).toContain('第二步赠送（主课80.00元）');
    expect(result.answer).toContain('陪练');
    expect(result.task.multiStep).toMatchObject({
      currentStep:0,
      steps:[
        { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' } },
        { operation:'gift.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'80' } },
      ],
    });
    expect(flow.understand).not.toHaveBeenCalled();
  });
  it('两笔收款计划统一展示两位小数与渠道，不生成任何写入预览', async () => {
    const flow=setup([], {steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'600',channel:'银行卡'}},
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'陪练',amount:'400',channel:'银行卡'}},
    ]});
    const result=await flow.run('这次收1000元，先给主课600，再给陪练400，银行卡，分两笔登记');
    expect(result.answer).not.toContain('原请求总额');
    expect(result.answer).toContain('主课600.00元，银行卡');
    expect(result.answer).toContain('陪练400.00元，银行卡');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('传输契约拒绝零金额时返回参数错误，不伪装成AI故障', async () => {
    const flow=setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'0',channel:'微信'})]);
    flow.tools.createPaymentPreview.mockRejectedValueOnce(new z.ZodError([{code:'custom',path:['amount'],message:'必须大于0'}]));
    const result=await flow.run('给林悦主课交费0元微信');
    expect(result.answer).toContain('参数不完整或不合法');
    expect(result.workspace.blocks).toContainEqual(expect.objectContaining({type:'error-recovery',code:'CORE_400'}));
  });
  it('首步预览未在Core变为EXECUTED前绝不生成第二步', async () => {
    const { run, tools } = setup([], { steps: [
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'gift.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'20' } },
    ] });
    tools.readPreview.mockResolvedValueOnce({ status:'PENDING' }).mockResolvedValueOnce({ status:'EXECUTED' });
    const planned = await run('先交费再赠送');
    expect(planned.task.multiStep).toMatchObject({ currentStep:0, steps:[expect.anything(),expect.anything()] });
    expect(planned.answer).toContain('开始第一步');
    const first = await run('开始第一步');
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    expect(tools.createGiftPreview).not.toHaveBeenCalled();
    const waiting = await run('继续');
    expect(waiting.task.previewId).toBe(first.task.previewId);
    expect(tools.createGiftPreview).not.toHaveBeenCalled();
    const second = await run('继续');
    expect(tools.readPreview).toHaveBeenLastCalledWith('cap', first.task.previewId);
    expect(tools.createGiftPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ accountId, amount:'20.00' }));
    expect(second.task.multiStep).toMatchObject({ currentStep:1, completedPreviewIds:[first.task.previewId] });
    expect(second.task.status).toBe('awaiting_confirmation');
  });
  it('首步已执行后用户立即取消时不创建第二步预览', async () => {
    const flow = setup([], {steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}},
    ]});
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await flow.run('先交费再赠送');
    const first = await flow.run('开始第一步');
    const cancelled = await flow.run('取消当前办理');
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId]);
    expect(cancelled.answer).toContain('前 1 步已经确认');
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
  });
  it('历史开户预览确认后重启继续缴费排课，不重建开户预览', async () => {
    const steps = [
      {operation:'course-account.open',fields:{studentName:'林悦',courseName:'主课'}},
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},
      {operation:'lesson.schedule',fields:{studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'}},
    ] as DialogueMultiStepPlan['steps'];
    const flow = setup([], undefined, {status:'awaiting_confirmation',operation:'course-account.open',previewId:'old-preview',multiStep:{steps,currentStep:0,completedPreviewIds:[]}});
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    flow.restart();
    const payment = await flow.run('继续');
    expect(flow.tools.readPreview).toHaveBeenCalledWith('cap','old-preview');
    expect(payment.task.multiStep?.completedPreviewIds).toEqual(['old-preview']);
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    flow.restart();
    await flow.run('继续');
    expect(flow.tools.createSingleLessonPreview).toHaveBeenCalledTimes(1);
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('多步识别失败时不得回退成其中一个单步操作', async () => {
    const flow = setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'})], null);
    const result = await flow.run('先开户，再交费，然后排课');
    expect(result.workspace.resultKind).toBe('clarification');
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.understand).not.toHaveBeenCalled();
  });
  it.each([
    ['未配置多步模型',undefined,'先开户，再交费，然后排课'],
    ['模型无法审核空计划',null,'给林悦主课交100元微信，另外赠送20元'],
    ['否定总额且没有模型',undefined,'林悦主课收1000，另外送80，不是收1080；陪练不动'],
  ] as const)('%s时潜在多动作不能退化为单笔交费', async (_label,multiStep,message) => {
    const invoke=vi.fn().mockResolvedValueOnce({content:JSON.stringify(intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}))})
      .mockResolvedValueOnce({content:JSON.stringify({actionSupported:false,unsupportedFields:[]})});
    const flow = setup([],multiStep,undefined,createIntentParser({invoke} as never));
    const result = await flow.run(message);
    expect(result.workspace.resultKind).toBe('clarification');
    expect(flow.understand).not.toHaveBeenCalled();
    expect(flow.tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
    expect(flow.tools.createSingleLessonPreview).not.toHaveBeenCalled();
  });

  it('同名账户跨步骤不得仅凭姓名复用首步对象', async () => {
    const another = crypto.randomUUID();
    const flow = setup([], {steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}},
    ]});
    flow.tools.getCourseAccountCandidates.mockResolvedValueOnce({candidates:[{accountId, studentId:'student-core-1',studentName:'林悦',courseName:'主课'}]}).mockResolvedValueOnce({candidates:[{accountId, studentId:'student-core-1',studentName:'林悦',courseName:'主课'},{accountId:another, studentId:'student-core-1',studentName:'林悦',courseName:'主课'}]});
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    await flow.run('先交费再赠送');
    await flow.run('开始第一步');
    const selection = await flow.run('继续');
    expect(selection.workspace.resultKind).toBe('selection');
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
  });
  it('历史开户预览状态未知时重启后只重查，不生成后续步骤', async () => {
    const steps = [{operation:'course-account.open',fields:{studentName:'林悦',courseName:'主课'}},{operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}}] as DialogueMultiStepPlan['steps'];
    const flow = setup([], undefined, {status:'awaiting_confirmation',operation:'course-account.open',previewId:'old-preview',multiStep:{steps,currentStep:0,completedPreviewIds:[]}});
    flow.tools.readPreview.mockRejectedValueOnce(new CoreDialogueError(500)).mockResolvedValue({status:'PENDING'});
    const unknown = await flow.run('继续');
    expect(unknown.workspace.resultKind).toBe('error');
    flow.restart();
    const pending = await flow.run('重试当前任务');
    expect(flow.tools.readPreview).toHaveBeenLastCalledWith('cap','old-preview');
    expect(pending.task.previewId).toBe('old-preview');
    expect(flow.tools.createGiftPreview).not.toHaveBeenCalled();
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('交费后排课与分账户交费只为当前一步生成独立预览', async () => {
    const lessonFlow = setup([], { steps:[
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'lesson.schedule', fields:{ studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00' } },
    ] });
    lessonFlow.tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    await lessonFlow.run('交费后排课');
    const paid = await lessonFlow.run('开始第一步');
    const scheduled = await lessonFlow.run('继续');
    expect(lessonFlow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    expect(lessonFlow.tools.createSingleLessonPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ accountId, teacherId, startsAt:'2026-10-22T09:00:00+08:00' }));
    expect(scheduled.task.previewId).not.toBe(paid.task.previewId);

    const secondAccountId = crypto.randomUUID();
    const payments = setup([], { steps:[
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'陪练',amount:'200',channel:'支付宝' } },
    ] });
    payments.tools.getCourseAccountCandidates.mockResolvedValueOnce({ candidates:[{ accountId, studentId:'student-core-1',studentName:'林悦',courseName:'主课' }] }).mockResolvedValueOnce({ candidates:[{ accountId:secondAccountId, studentId:'student-core-1',studentName:'林悦',courseName:'陪练' }] });
    payments.tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    await payments.run('先给主课交费，再给陪练交费');
    await payments.run('开始第一步');
    const secondPayment = await payments.run('继续');
    expect(payments.tools.createPaymentPreview).toHaveBeenNthCalledWith(2, 'cap', expect.objectContaining({ accountId:secondAccountId,amount:'200.00',channel:'ALIPAY' }));
    expect(secondPayment.task.selected.accountId).toBe(secondAccountId);
  });
  it('两步计划采用模型解析的上海时区排课时间', async () => {
    const flow = setup([], { steps:[
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'lesson.schedule', fields:{ studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T15:00:00+08:00' } },
    ] });
    flow.tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    await flow.run('交费后再排明天下午三点的课');
    await flow.run('开始第一步');
    await flow.run('继续下一步');
    expect(flow.tools.createSingleLessonPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      startsAt:'2026-10-22T15:00:00+08:00',
    }));
  });
  it('调课只用改到之前的时间筛选原课程，不能把目标时间当作原课程时间', async () => {
    const secondLessonId = crypto.randomUUID();
    const flow = setup([intent('lesson.reschedule', {
      studentName:'林悦', date:'2026-10-22', targetStartsAt:'2026-10-22T18:00:00+08:00',
    })]);
    flow.tools.getLessonCandidates.mockResolvedValue({ candidates:[
      { lessonId, studentName:'林悦', courseName:'主课', teacherName:'王老师', startsAt:'2026-10-22T01:00:00Z', status:'SCHEDULED' },
      { lessonId:secondLessonId, studentName:'林悦', courseName:'主课', teacherName:'王老师', startsAt:'2026-10-22T06:00:00Z', status:'SCHEDULED' },
    ] });

    const result = await flow.run('把林悦明天的课改到18点');

    const picker = result.workspace.blocks.find(block => block.type === 'entity-picker');
    expect(picker).toMatchObject({ type:'entity-picker', candidates:[expect.anything(), expect.anything()] });
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('依据模型识别的原课程时间筛选候选，不重新从说法中提取时刻', async () => {
    const otherId=crypto.randomUUID();
    const flow=setup([intent('lesson.reschedule',{studentName:'林悦',date:'2026-10-22',startsAt:'2026-10-22T14:00:00+08:00',targetStartsAt:'2026-10-22T18:00:00+08:00'})]);
    flow.tools.getLessonCandidates.mockResolvedValue({candidates:[
      {lessonId,studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T06:00:00Z',status:'SCHEDULED'},
      {lessonId:otherId,studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T01:00:00Z',status:'SCHEDULED'},
    ]});
    await flow.run('把下午两点那节改到晚上六点');
    expect(flow.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap',expect.objectContaining({command:expect.objectContaining({lessonId,targetStartsAt:'2026-10-22T18:00:00+08:00'})}));
  });
  it('明确说新日期时不沿用上一轮课表引用，宁可补问也不能操作错课', async () => {
    const flow = setup([
      intent('lessons.read', { dateFrom:'2026-10-21',dateTo:'2026-10-21' }),
      intent('lesson.reschedule', { targetStartsAt:'2026-10-22T18:00:00+08:00' }),
    ]);
    await flow.run('我今天有哪些课');
    const result = await flow.run('把我明天9点的课改到18点');
    expect(result.task.previewId).toBeUndefined();
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('模型未明确选择候选课程时，不仅凭“这节”自动使用上一轮课程', async () => {
    const flow=setup([intent('lessons.read',{dateFrom:'2026-10-21',dateTo:'2026-10-21'}),intent('lesson.reschedule',{targetStartsAt:'2026-10-22T18:00:00+08:00'})]);
    await flow.run('查看今天排课');
    const result=await flow.run('把这节课调到明天晚上六点');
    expect(result.task.previewId).toBeUndefined();
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('第二步失败时保留首步Core执行记录且不尝试回滚', async () => {
    const { run, tools } = setup([], { steps:[
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'gift.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'20' } },
    ] });
    tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    tools.createGiftPreview.mockRejectedValue(new CoreDialogueError(500));
    await run('先交费再赠送');
    const first = await run('开始第一步');
    const failed = await run('继续');
    expect(failed.task.multiStep).toMatchObject({ currentStep:1, completedPreviewIds:[first.task.previewId] });
    expect(failed.workspace.resultKind).toBe('error');
    expect(failed.answer).toContain('第1步已确认');
    expect(failed.answer).toContain('第2步');
    expect(tools.invalidatePreview).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('已支持的交费赠送计划在第二步故障后重试只处理第二步', async () => {
    const flow = setup([], {steps:[
      {operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'100',channel:'微信'}},
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}},
    ]});
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    flow.tools.createGiftPreview.mockRejectedValueOnce(new CoreDialogueError(500));
    await flow.run('先交费再赠送');
    const first = await flow.run('开始第一步');
    await flow.run('继续');
    const retried = await flow.run('重试当前任务');
    expect(retried.task.status).toBe('awaiting_confirmation');
    expect(retried.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId]);
    expect(flow.tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    expect(flow.tools.createGiftPreview).toHaveBeenCalledTimes(2);
  });
  it('赠送后排课逐步确认，后步失败重试不会重复首步', async () => {
    const flow = setup([], {steps:[
      {operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'20'}},
      {operation:'lesson.schedule',fields:{studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T09:00:00+08:00'}},
    ]});
    flow.tools.readPreview.mockResolvedValueOnce({status:'PENDING'}).mockResolvedValue({status:'EXECUTED'});
    flow.tools.createSingleLessonPreview.mockRejectedValueOnce(new CoreDialogueError(500));
    const plan = await flow.run('先给林悦主课赠送20元，再排王老师明天9点的主课');
    expect(plan.answer).toContain('林悦');
    expect(plan.answer).toContain('王老师');
    const first = await flow.run('开始第一步');
    await flow.run('继续');
    expect(flow.tools.createSingleLessonPreview).not.toHaveBeenCalled();
    const failed = await flow.run('继续');
    expect(failed.workspace.resultKind).toBe('error');
    expect(failed.task.multiStep).toMatchObject({currentStep:1,completedPreviewIds:[first.task.previewId]});
    flow.restart();
    const recovered = await flow.run('重试当前任务');
    expect(recovered.task.status).toBe('awaiting_confirmation');
    expect(flow.tools.createGiftPreview).toHaveBeenCalledTimes(1);
    expect(flow.tools.createSingleLessonPreview).toHaveBeenCalledTimes(2);
    expect(flow.tools.invalidatePreview).not.toHaveBeenCalled();
    const done = await flow.run('继续');
    expect(done.task.status).toBe('completed');
  });
  it.each(['payroll.adjust','payroll.pay'] as const)('生成工资后重新按所选教师ID查找工资并分别确认：%s', async (operation) => {
    const next = operation === 'payroll.adjust'
      ? {teacherName:'王老师',period:'2026-10',bonusAmount:'100',bonusNote:'奖励'}
      : {teacherName:'王老师',period:'2026-10',channel:'微信',paidAt:'2026-10-21'};
    const flow = setup([], {steps:[{operation:'payroll.generate',fields:{teacherName:'王老师',period:'2026-10'}},{operation,fields:next}]});
    const correctPayroll = '49fbcf47-c616-468a-a058-cdca1ee66026';
    flow.tools.getPayrollCandidates.mockResolvedValue({candidates:[
      {payrollId:crypto.randomUUID(),teacherId:crypto.randomUUID(),teacherName:'王老师',period:'2026-10',status:'UNPAID'},
      {payrollId:correctPayroll,teacherId,teacherName:'王老师',period:'2026-10',status:'UNPAID'},
    ]});
    flow.tools.readPreview.mockResolvedValue({status:'EXECUTED'});
    const plan = await flow.run(operation === 'payroll.adjust' ? '先生成王老师10月工资，再调整工资奖金100元' : '先生成王老师10月工资，再支付工资');
    expect(plan.answer).toContain('王老师');
    expect(plan.answer).toContain('2026-10');
    if (operation === 'payroll.adjust') expect(plan.answer).toContain('奖金100.00');
    const first = await flow.run('开始第一步');
    flow.restart();
    const second = await flow.run('继续');
    expect(flow.tools.getPayrollCandidates).toHaveBeenCalledWith('cap',{teacherName:'王老师',period:'2026-10'});
    expect(flow.tools.createStructuredActionPreview).toHaveBeenCalledTimes(2);
    expect(flow.tools.createStructuredActionPreview).toHaveBeenLastCalledWith('cap',expect.objectContaining({actionType:operation,command:expect.objectContaining({payrollId:correctPayroll})}));
    expect(second.task.multiStep?.completedPreviewIds).toEqual([first.task.previewId]);
    expect(second.task.status).toBe('awaiting_confirmation');
  });
  it('模型无法核对有序步骤时要求澄清而不是生成预览', async () => {
    const flow = setup([], { steps:[{operation:'payroll.generate',fields:{teacherName:'王老师',period:'2026-10'}},{operation:'payroll.pay',fields:{teacherName:'王老师',period:'2026-10'}}] });
    const result = await flow.run('先生成王老师10月工资，再办理工资');
    expect(result.workspace.resultKind).toBe('clarification');
    expect(result.answer).toContain('顺序');
    expect(flow.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('不把模型未经Core核对的澄清话术显示为业务事实', async () => {
    const {run,tools}=setup([{mode:'clarify',operation:null,fields:{},question:'该学生不存在，余额是0元'}]);
    const result=await run('查一下这个同学');
    expect(result.answer).not.toMatch(/不存在|余额是0/);
    expect(tools.readAccount).not.toHaveBeenCalled();
  });
  it('日期与老师筛选使用同一查询工具，补问保留已明确范围', async () => {
    const { run, tools, understand } = setup([intent('lessons.read', { dateFrom: '2026-10-22', dateTo: '2026-10-22' }), intent('lessons.read', { teacherName: '王老师' }, 'continue')]);
    await run('明天有哪些课'); const result = await run('只看王老师的');
    expect(understand).toHaveBeenCalledTimes(2);
    expect(tools.readLessons).toHaveBeenLastCalledWith('cap', { dateFrom: '2026-10-22', dateTo: '2026-10-22', teacherName: '王老师' });
    expect(result.workspace.title).toContain('2026-10-22');
    expect(JSON.stringify(result.workspace)).not.toMatch(/经营收入|冻结|工资/);
  });
  it('采用模型解析的确定日期，并把中文状态交给Core解释', async () => {
    const { run, tools } = setup([intent('lessons.read', {
      dateFrom: '2026-10-22', dateTo: '2026-10-22', teacherName: '王老师', courseName: '主课', status: '待上课',
    })]);
    const result = await run('查明天王老师的主课，只看待上课');
    expect(tools.readLessons).toHaveBeenCalledWith('cap', {
      dateFrom: '2026-10-22', dateTo: '2026-10-22', teacherName: '王老师', courseName: '主课', statusText: '待上课',
    });
    expect(result.workspace.resultKind).toBe('query');
  });
  it('含糊日期只补具体范围，不调用Core查询', async () => {
    const { run, tools } = setup([intent('lessons.read', {})]);
    const result = await run('查最近几天的课');
    expect(result.answer).toMatch(/(?:开始|起始)日期.*结束日期/u);
    expect(result.workspace.resultKind).toBe('clarification');
    expect(tools.readLessons).not.toHaveBeenCalled();
  });
  it('排课表直接显示Core返回的中文状态，不暴露内部枚举', async () => {
    const { run, tools } = setup([intent('lessons.read', {dateFrom:'2026-10-22',dateTo:'2026-10-22'})]);
    tools.readLessons.mockResolvedValue({ lessons: [{ lessonId, accountId, teacherId, startsAt:'2026-10-22T01:00:00Z',endsAt:'2026-10-22T02:00:00Z',studentName:'林悦',courseName:'主课',teacherName:'王老师',status:'SCHEDULED',statusLabel:'待上课' }] } as never);
    const result = await run('明天课表');
    expect(JSON.stringify(result.workspace)).toContain('待上课');
    expect(JSON.stringify(result.workspace)).not.toContain('SCHEDULED');
  });
  it('流水、月报和工资查询使用各自Core事实，不回落经营摘要', async () => {
    const ledger = setup([intent('ledger.read', { studentName:'林悦',courseName:'主课' })]);
    const ledgerResult = await ledger.run('查看林悦主课流水');
    expect(ledger.tools.readAccountLedger).toHaveBeenCalledWith('cap', { accountId });
    expect(ledgerResult.workspace.blocks).toContainEqual(expect.objectContaining({ type:'ledger-detail', accountId }));
    expect(ledger.tools.getDashboardSummary).not.toHaveBeenCalled();

    const report = setup([intent('report.monthly', { period:'2026-10',basis:'对比' })]);
    const reportResult = await report.run('对比10月现金净额和经营利润');
    expect(reportResult.answer).toContain('现金净额700.00元');
    expect(reportResult.answer).toContain('经营收入850.00元、经营成本560.00元、经营利润290.00元');
    expect(reportResult.answer).toContain('收款按到账确认');
    expect(report.tools.readMonthlyReport).toHaveBeenCalledWith('cap', { period:'2026-10' });

    const payroll = setup([intent('payroll.read', { period:'2026-10',teacherName:'王老师' })]);
    const payrollResult = await payroll.run('查王老师10月工资依据');
    expect(payrollResult.workspace.blocks).toContainEqual(expect.objectContaining({ type:'data-table', rows:[expect.objectContaining({ gross:'2200.00',net:'2150.00' })] }));
    expect(payroll.tools.readMonthlyPayroll).toHaveBeenCalledWith('cap', { period:'2026-10' });
  });
  it('新增四类只读意图调用对应Core工具，并仅展示本次查询结果', async () => {
    const directory = setup([intent('directory.read', {})]);
    const directoryResult = await directory.run('查看基础资料');
    expect(directory.tools.readDirectory).toHaveBeenCalledWith('cap');
    expect(directoryResult.workspace.blocks).toContainEqual(expect.objectContaining({ type:'data-table' }));
    expect(directoryResult.workspace.resultKind).toBe('query');

    const arrears = setup([intent('arrears.read', {})]);
    const arrearsResult = await arrears.run('查看欠费和冻结学生');
    expect(arrears.tools.readArrearsAndFrozen).toHaveBeenCalledWith('cap');
    expect(JSON.stringify(arrearsResult.workspace)).toContain('-20.00');
    expect(arrearsResult.workspace.title).toContain('欠费');

    const consumption = setup([intent('consumption.read', { period:'2026-10',groupBy:'teacher' })]);
    const consumptionResult = await consumption.run('查看10月按老师统计课消');
    expect(consumption.tools.readMonthlyConsumption).toHaveBeenCalledWith('cap', { period:'2026-10' });
    expect(JSON.stringify(consumptionResult.workspace)).toContain('王老师');
    expect(JSON.stringify(consumptionResult.workspace)).not.toContain('冻结');

    const preclose = setup([intent('period.preclose.read', { period:'2026-10' })]);
    const precloseResult = await preclose.run('检查10月关账');
    expect(preclose.tools.readPeriodPreclose).toHaveBeenCalledWith('cap', { period:'2026-10' });
    expect(precloseResult.answer).toContain('待上课');
    expect(precloseResult.answer).toContain('需人工判断');
    expect(preclose.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('六类基础资料请求只向Core生成本次Preview，实体ID来自授权候选', async () => {
    const createStudent = setup([intent('student.create', { name:'新学生',notes:'周末上课' })]);
    const studentPreview = await createStudent.run('新增学生新学生，备注周末上课');
    expect(createStudent.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'student.create',command:{ name:'新学生',notes:'周末上课' } }));
    expect(studentPreview.workspace.resultKind).toBe('preview');

    const updateStudent = setup([intent('student.update', { studentName:'林悦',name:'林悦新' })]);
    updateStudent.tools.getStudentCandidates.mockResolvedValue({ candidates:[{ studentId:'student-core-1',name:'林悦' }] });
    await updateStudent.run('把林悦改名林悦新');
    expect(updateStudent.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'student.update',command:expect.objectContaining({ studentId:'student-core-1',name:'林悦新' }) }));

    const createCourse = setup([intent('course.create', { name:'视奏课',defaultUnitPrice:'180',defaultDurationMinutes:'45' })]);
    await createCourse.run('新增视奏课，单价180，时长45分钟');
    expect(createCourse.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'course.create',command:{ name:'视奏课',defaultUnitPrice:'180.00',defaultDurationMinutes:45 } }));

    const updateCourse = setup([intent('course.update', { courseName:'主课',name:'精品主课' })]);
    await updateCourse.run('把主课改名精品主课');
    expect(updateCourse.tools.readDirectory).toHaveBeenCalledWith('cap');
    expect(updateCourse.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'course.update',command:expect.objectContaining({ courseId:'course-core-1',name:'精品主课' }) }));

    const openAccount = setup([intent('course-account.open', { studentName:'林悦',courseName:'主课',currentUnitPrice:'200' })]);
    openAccount.tools.getStudentCandidates.mockResolvedValue({ candidates:[{ studentId:'student-core-1',name:'林悦' }] });
    await openAccount.run('给林悦开通主课，单价200');
    expect(openAccount.tools.createStructuredActionPreview).not.toHaveBeenCalled();

    const price = setup([intent('course-account.price', { studentName:'林悦',courseName:'主课',currentUnitPrice:'220' })]);
    await price.run('把林悦主课单价调整为220');
    expect(price.tools.getCourseAccountCandidates).toHaveBeenCalledWith('cap', { studentName:'林悦',courseName:'主课',match:'search' });
    expect(price.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'course-account.price',command:expect.objectContaining({ accountId, currentUnitPrice:'220.00' }) }));
  });

  it('缺少安全课程ID候选时如实阻塞，不让模型ID进入Preview', async () => {
    const update = setup([intent('course.update', { courseName:'主课',name:'精品主课' })]);
    update.tools.readDirectory.mockResolvedValue({ students:[],teachers:[],courses:[] });
    const updateResult = await update.run('修改主课名称');
    expect(updateResult.answer).toMatch(/没有找到|候选|无法安全/);
    expect(update.tools.createStructuredActionPreview).not.toHaveBeenCalled();

    const open = setup([intent('course-account.open', { studentName:'林悦',courseName:'不存在的课程',currentUnitPrice:'200' })]);
    open.tools.readDirectory.mockResolvedValue({ students:[],teachers:[],courses:[] });
    const openResult = await open.run('给林悦开通不存在的课程');
    expect(openResult.answer).toContain('缴费');
    expect(open.tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('生产读客户端尚未暴露的新方法时明确报告接线阻塞且不冒充已查询', async () => {
    for (const [operation, fields] of [
      ['directory.read', {}], ['arrears.read', {}], ['consumption.read', { period:'2026-10' }], ['period.preclose.read', { period:'2026-10' }],
    ] as const) {
      const current = setup([intent(operation, fields)]);
      Object.assign(current.tools, { readDirectory:undefined,readArrearsAndFrozen:undefined,readMonthlyConsumption:undefined,readPeriodPreclose:undefined });
      const result = await current.run(`测试${operation}`);
      expect(result.answer).toMatch(/尚未接入|未读取/);
      expect(result.workspace.resultKind).toBe('clarification');
      expect(current.tools.createStructuredActionPreview).not.toHaveBeenCalled();
    }
  });
  it('缺渠道只补渠道，下一句支付宝接回原交费', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000' }), intent(null, { channel: '支付宝' }, 'continue')]);
    const first = await run('林悦主课收1000'); expect(first.answer).toContain('渠道'); expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    const second = await run('支付宝'); expect(tools.createPaymentPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ accountId, amount: '1000.00', channel: 'ALIPAY' })); expect(second.task.previewId).toBeTruthy();
  });
  it('工资调整先补说明，工资支付由系统补实际登记时间', async () => {
    const adjust = setup([
      intent('payroll.adjust', { teacherName:'王老师',period:'2026-10',bonusAmount:'100' }),
      intent(null, { bonusNote:'公开课奖励' }, 'continue'),
    ]);
    const first = await adjust.run('王老师10月加奖金100');
    expect(first.answer).toContain('奖金说明');
    await adjust.run('公开课奖励');
    expect(adjust.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.adjust', command:expect.objectContaining({ bonusAmount:'100.00',bonusNote:'公开课奖励' }),
    }));

    const monthConfig = setup([intent('payroll.adjust', { teacherName:'王老师',period:'2026-10',baseSalary:'2200.00',commissionRate:'12.0000' })]);
    await monthConfig.run('只把王老师10月基本工资改2200、提成12%');
    expect(monthConfig.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.adjust', command:expect.objectContaining({ baseSalary:'2200.00',commissionRate:'12.0000' }),
    }));

    const pay = setup([intent('payroll.pay', { teacherName:'王老师',period:'2026-10',channel:'微信' })]);
    await pay.run('登记王老师10月工资已微信支付');
    expect(pay.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.pay', command:expect.objectContaining({ channel:'WECHAT',paidAt:'2026-10-21T03:00:00.000Z' }),
    }));
  });
  it('写操作按各自Core契约序列化，不透传模型字段并规范百分比与日期', async () => {
    const teacher = setup([intent('teacher.create', { name:'赵老师',baseSalary:'2000',commissionRate:'10%' })]);
    await teacher.run('新增赵老师，默认基本工资2000，课消提成10%');
    expect(teacher.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'teacher.create', command:{ name:'赵老师',baseSalary:'2000.00',commissionRate:'10.0000' },
    }));

    const adjust = setup([intent('payroll.adjust', { teacherName:'王老师',period:'2026-10',baseSalary:'2200',commissionRate:'12%' })]);
    await adjust.run('只把王老师10月基本工资改2200、提成12%');
    expect(adjust.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.adjust', command:{ payrollId:'49fbcf47-c616-468a-a058-cdca1ee66026',baseSalary:'2200.00',commissionRate:'12.0000' },
    }));

    const pay = setup([intent('payroll.pay', { teacherName:'王老师',period:'2026-10',channel:'银行卡',paidAt:'2026-10-21' })]);
    await pay.run('登记王老师10月工资已在10月21日通过银行卡发放');
    expect(pay.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.pay', command:{ payrollId:'49fbcf47-c616-468a-a058-cdca1ee66026',channel:'BANK_CARD',paidAt:'2026-10-21T03:00:00.000Z' },
    }));

    const manual = setup([intent('manual-transaction.create', { kind:'收入',category:'卖书',amount:'50',channel:'微信',occurredAt:'2026-10-21' })]);
    await manual.run('今天卖书收到50元，微信，登记收入');
    expect(manual.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'manual-transaction.create', command:{ kind:'收入',category:'卖书',amount:'50.00',channel:'WECHAT',occurredAt:'2026-10-21T03:00:00.000Z' },
    }));
  });
  it('收集中任务把同操作短回答作为字段补丁，并可引用上一轮查询结果', async () => {
    const payment = setup([
      intent('payment.preview', { studentName:'林悦' }),
      intent('payment.preview', { courseName:'陪练',amount:'300' }, 'continue'),
      intent(null, { channel:'支付宝' }, 'continue'),
    ]);
    await payment.run('给林悦交个费');
    const second = await payment.run('陪练，300');
    expect(second.answer).toContain('渠道');
    await payment.run('支付宝');
    expect(payment.tools.createPaymentPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ amount:'300.00',channel:'ALIPAY' }));

    const reschedule = setup([
      intent('lessons.read', { dateFrom:'2026-10-22',dateTo:'2026-10-22',studentName:'林悦' }),
      intent('lesson.reschedule', { targetStartsAt:'2026-10-22T18:00:00+08:00',selectionId:lessonId }),
    ]);
    await reschedule.run('查询林悦明天的排课');
    await reschedule.run('把这节调整到18:00');
    expect(reschedule.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'lesson.reschedule',command:{ lessonId,targetStartsAt:'2026-10-22T18:00:00+08:00' },
    }));
  });
  it('手工收支把中文固定分类交给Core并始终先生成预览', async () => {
    const { run, tools } = setup([intent('manual-transaction.create', { kind:'收入',category:'书籍销售',amount:'50',channel:'微信',occurredAt:'2026-10-21' })]);
    const result = await run('今天卖书收到50元，微信，登记收入');
    expect(tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'manual-transaction.create',
      command:expect.objectContaining({ kind:'收入',category:'书籍销售',amount:'50.00',channel:'WECHAT',occurredAt:'2026-10-21T03:00:00.000Z' }),
    }));
    expect(result.task.status).toBe('awaiting_confirmation');
    expect(result.workspace.resultKind).toBe('preview');
  });
  it('历史课消金额纠错使用Core单一L2能力，不伪装成冲正交费再收款', async () => {
    const { run, tools } = setup([intent('lesson.complete.correction', { studentName:'林悦',courseName:'主课',dateFrom:'2026-09-01',dateTo:'2026-09-30',correctedUnitPrice:'220' })]);
    tools.readLessons.mockResolvedValueOnce({ lessons:[{ lessonId,accountId,teacherId,startsAt:'2026-09-10T01:00:00Z',endsAt:'2026-09-10T02:00:00Z',studentName:'林悦',courseName:'主课',teacherName:'王老师',status:'COMPLETED',statusLabel:'已完成' }] });
    tools.createStructuredActionPreview.mockResolvedValueOnce({ previewId:crypto.randomUUID(),actionType:'lesson.complete.correction',riskLevel:'L2',command:{lessonId,correctedUnitPrice:'220.00'},display:{title:'纠正课消金额',summary:'原200.00，纠正为220.00'},expiresAt:'2026-10-21T04:00:00Z' });
    const result = await run('9月林悦那笔主课扣了200，应该220，在10月纠正。');
    expect(tools.readLessons).toHaveBeenCalledWith('cap', expect.objectContaining({dateFrom:'2026-09-01',dateTo:'2026-09-30',studentName:'林悦',courseName:'主课',statusText:'已完成'}));
    expect(tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({actionType:'lesson.complete.correction',command:{lessonId,correctedUnitPrice:'220.00'}}));
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
    expect(result.workspace.blocks).toContainEqual(expect.objectContaining({type:'action-preview',actionType:'lesson.complete.correction',riskLevel:'L2'}));
  });
  it('退款手续费不能绕成手工收入重复登记', async () => {
    const { run, tools } = setup([{mode:'new',operation:'unsupported',fields:{},question:'退款手续费会自动计入，不能重复登记为手工收入。'}]);
    const result = await run('再把刚才退款手续费100记成手工收入。');
    expect(result.answer).toMatch(/退款手续费.*自动.*不能.*重复/u);
    expect(tools.createStructuredActionPreview).not.toHaveBeenCalled();
  });
  it('更正金额先令旧预览失效，只生成100元新预览', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), intent(null, { amount: '100', channel: '支付宝' }, 'correct')]);
    const first = await run('收1000微信'); const second = await run('不是1000是100支付宝');
    expect(tools.invalidatePreview).toHaveBeenCalledWith('cap', first.task.previewId, expect.any(String));
    expect(tools.createPaymentPreview).toHaveBeenLastCalledWith('cap', expect.objectContaining({ amount: '100.00', channel: 'ALIPAY' }));
    expect(second.task.previewId).not.toBe(first.task.previewId);
  });
  it('同名账户选定后更正金额，保留选中的账户并使原预览失效', async () => {
    const otherId = crypto.randomUUID();
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'}), intent(null,{amount:'100'},'correct')]);
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[{accountId, studentId:'student-core-1',studentName:'林悦',courseName:'主课'},{accountId:otherId, studentId:'student-core-1',studentName:'林悦',courseName:'主课'}]});
    const choices = await run('给林悦主课交1000元微信');
    const original = await run(`选择候选:${otherId}:${choices.task.version}`);
    const corrected = await run('金额改成100');
    expect(tools.invalidatePreview).toHaveBeenCalledWith('cap',original.task.previewId,expect.any(String));
    expect(tools.createPaymentPreview).toHaveBeenLastCalledWith('cap',expect.objectContaining({accountId:otherId,amount:'100.00'}));
    expect(corrected.task.selected.accountId).toBe(otherId);
  });
  it('待确认时清除金额补参，即使无法生成新预览也先失效旧预览', async () => {
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'}),intent(null,{amount:null},'continue')]);
    const original = await run('给林悦主课交1000元微信');
    const corrected = await run('金额还不确定');
    expect(tools.invalidatePreview).toHaveBeenCalledWith('cap',original.task.previewId,expect.any(String));
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
    expect(corrected.task.previewId).toBeUndefined();
  });
  it('收集参数时明确换另一名学生的同类业务，不继承原金额渠道', async () => {
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',amount:'1000',channel:'微信'}),intent('payment.preview',{studentName:'小雨',courseName:'陪练'},'new')]);
    tools.getCourseAccountCandidates.mockResolvedValue({candidates:[{accountId, studentId:'student-core-1',studentName:'小雨',courseName:'陪练'}]});
    await run('林悦交1000元微信');
    const next = await run('另外给小雨陪练交费');
    expect(next.task.fields).toEqual({studentName:'小雨',courseName:'陪练'});
    expect(next.answer).toMatch(/金额.*渠道/);
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('收集参数时发起同一学生的另一笔收款，不继承原金额渠道', async () => {
    const {run,tools} = setup([intent('payment.preview',{studentName:'林悦',amount:'1000',channel:'微信'}),intent('payment.preview',{studentName:'林悦',courseName:'主课'},'new')]);
    await run('林悦交1000元微信');
    const next = await run('另外给林悦主课交费');
    expect(next.task.fields).toEqual({studentName:'林悦',courseName:'主课'});
    expect(next.answer).toMatch(/金额.*渠道/);
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('取消办理令服务端预览失效，并清掉金额渠道对象', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' })]);
    const first = await run('收款'); const second = await run('取消当前办理');
    expect(tools.invalidatePreview).toHaveBeenCalledWith('cap', first.task.previewId, expect.any(String));
    expect(second.task.fields).toEqual({}); expect(second.task.selected).toEqual({}); expect(second.task.previewId).toBeUndefined(); expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('取消待确认写任务并切换余额查询时，失效预览且只继承学生课程', async () => {
    const { run, tools } = setup([
      intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'100',channel:'支付宝' }),
      intent('accounts.read', { studentName:'林悦',courseName:'主课' }, 'new'),
    ]);
    const first = await run('林悦主课交费100元，支付宝');
    const result = await run('先别收了，只查一下余额。');
    expect(tools.invalidatePreview).toHaveBeenCalledWith('cap', first.task.previewId, '用户切换办理事项');
    expect(tools.readAccount).toHaveBeenCalledWith('cap', { accountId });
    expect(result.task.operation).toBe('accounts.read');
    expect(result.task.fields).toEqual({ studentName:'林悦',courseName:'主课' });
    expect(result.task.previewId).toBeUndefined();
    expect(result.answer).toContain('总');
  });
  it('先理解新消息再处理旧预览，模型失败时保留预览且不请求失效', async () => {
    const { run, tools, understand } = setup([intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' })]);
    const first = await run('收1000微信');
    understand.mockRejectedValueOnce(new Error('invalid output'));
    const failed = await run('改成100');
    expect(tools.invalidatePreview).not.toHaveBeenCalled();
    expect(failed.task.previewId).toBe(first.task.previewId);
    expect(failed.workspace.blocks).toContainEqual(expect.objectContaining({ type:'action-preview', previewId:first.task.previewId }));
  });
  it('从同一课程余额查询切到交费时继承选中的账户ID，但不继承金额和渠道', async () => {
    const { run, tools } = setup([
      intent('accounts.read', { studentName:'林悦',courseName:'主课' }),
      intent('payment.preview', { studentName:'林悦',courseName:'主课' }),
    ]);
    await run('查林悦主课余额');
    tools.getCourseAccountCandidates.mockClear();
    const payment = await run('给林悦主课交费');
    expect(payment.task.selected.accountId).toBe(accountId);
    expect(payment.task.fields).toEqual({ studentName:'林悦',courseName:'主课' });
    expect(payment.answer).toMatch(/金额.*渠道/);
    expect(tools.getCourseAccountCandidates).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('用显式任务状态表达收集、选择、待确认、完成和取消', async () => {
    const { run } = setup([
      intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000' }),
      intent(null, { channel:'微信' }, 'continue'),
      intent('accounts.read', { studentName:'林悦',courseName:'主课' }),
    ]);
    const collecting = await run('林悦主课交费');
    expect(collecting.task.status).toBe('collecting');

    const choosing = setup([intent('accounts.read', { studentName:'林悦',courseName:'主课' })]);
    choosing.tools.getCourseAccountCandidates.mockResolvedValue({ candidates:[{ accountId, studentId:'student-core-1', studentName:'林悦', courseName:'主课' },{ accountId:crypto.randomUUID(), studentId:'student-core-1', studentName:'林悦', courseName:'主课' }] });
    const selecting = await choosing.run('查余额');
    expect(selecting.task.status).toBe('selecting');

    const pending = await run('补上微信');
    expect(pending.task.status).toBe('awaiting_confirmation');
    expect(pending.workspace.resultKind).toBe('preview');
    const completed = await run('查余额');
    expect(completed.task.status).toBe('completed');
    const cancelled = await run('取消当前办理');
    expect(cancelled.task.status).toBe('cancelled');
  });
  it('同名选择有版本和真实ID绑定，不查询任意人的余额', async () => {
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' })]);
    const otherId = crypto.randomUUID(); tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' },{ accountId: otherId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' }] });
    const first = await run('查林悦主课余额'); expect(tools.readAccount).not.toHaveBeenCalled(); expect(first.workspace.blocks.some(b => b.type === 'entity-picker')).toBe(true);
    await run(`选择候选:${otherId}:${first.task.version}`); expect(tools.readAccount).toHaveBeenCalledWith('cap', { accountId: otherId });
  });
  it('同名学生仅一人有匹配课程账户时，也不能猜测用户所指并读取余额', async () => {
    const {run,tools} = setup([intent('accounts.read',{studentName:'林悦',courseName:'主课'})]);
    tools.getStudentCandidates.mockResolvedValue({candidates:[{studentId:'one',name:'林悦'},{studentId:'two',name:'林悦'}]});
    const result = await run('查林悦主课余额');
    expect(result.workspace.resultKind).toBe('selection');
    expect(tools.readAccount).not.toHaveBeenCalled();
    expect(tools.readAccountLedger).not.toHaveBeenCalled();
  });
  it('拒绝旧版本选择卡和伪造候选ID', async () => {
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' })]);
    tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' },{ accountId: crypto.randomUUID(), studentId:'student-core-1', studentName: '林悦', courseName: '主课' }] });
    await run('余额'); const old = await run(`选择候选:${accountId}:0`); expect(old.answer).toContain('失效'); expect(tools.readAccount).not.toHaveBeenCalled();
    const forged = await run(`选择候选:${crypto.randomUUID()}:${old.task.version}`); expect(forged.answer).toContain('授权候选'); expect(tools.readAccount).not.toHaveBeenCalled();
  });
  it('自然语言选择同名对象也只能选择当前候选真实ID', async () => {
    const otherId = crypto.randomUUID();
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' }), intent(null, { selectionId: otherId }, 'continue')]);
    tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' }, { accountId: otherId, studentId:'student-core-1', studentName: '林悦', courseName: '主课' }] });
    await run('查同名林悦'); await run('第二个'); expect(tools.readAccount).toHaveBeenCalledWith('cap', { accountId: otherId });
  });
  it('新业务不继承上一笔金额和渠道', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), intent('payment.preview', { studentName: '小雨', courseName: '陪练' })]);
    await run('先收林悦'); const next = await run('现在给小雨交费'); expect(next.task.fields).toEqual({ studentName: '小雨', courseName: '陪练' }); expect(next.answer).toMatch(/金额.*渠道/); expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('Core拒绝权限时显示权限错误，不改称空结果', async () => {
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' })]);
    tools.getCourseAccountCandidates.mockRejectedValue(new CoreDialogueError(403)); const result = await run('老师查余额'); expect(result.answer).toContain('无权'); expect(result.workspace.blocks).toContainEqual(expect.objectContaining({ type: 'error-recovery', code: 'CORE_403' }));
  });
  it('无权业务即使缺少参数也先由Core拒绝，不继续索取资金资料', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName: '林悦', amount: '100', channel: '微信' })]);
    tools.checkActionAccess.mockRejectedValue(new CoreDialogueError(403));
    const result = await run('给林悦交费100微信');
    expect(result.answer).toContain('无权');
    expect(tools.checkActionAccess).toHaveBeenCalledWith('cap', 'course-account.payment');
    expect(tools.createPaymentPreview).not.toHaveBeenCalled();
  });
  it('确认上课采用Core的L2与教师投影，不额外读取余额', async () => {
    const { run, tools } = setup([intent('lesson.complete', { studentName: '林悦', date: '2026-10-20' })]);
    const result = await run('这节课已上完'); expect(result.workspace.blocks).toContainEqual(expect.objectContaining({ type:'action-preview', riskLevel:'L2' })); expect(tools.readAccount).not.toHaveBeenCalled(); expect(JSON.stringify(result.workspace)).not.toMatch(/实收|赠送|500.00/);
  });
  it('模型不可用时不靠关键词伪装理解，也不会写入', async () => {
    const graph = createDialogueGraph({ tools: {} as Parameters<typeof createDialogueGraph>[0]['tools'], capability: 'cap' }); const { result } = await graph.invoke({ turn: { runId: crypto.randomUUID(), threadId: 'task', message: '交费100', previous: {} } }); expect(result.answer).toContain('AI暂不可用'); expect(result.task.previewId).toBeUndefined();
  });
  it('首次模型出错后的恢复使用原始请求，不把刷新按钮当成新业务', async () => {
    const { run, understand } = setup([]);
    understand.mockRejectedValueOnce(new Error('invalid output')).mockResolvedValueOnce(intent('lessons.read', { dateFrom:'2026-10-22',dateTo:'2026-10-22' }));
    await run('明天有哪些排课');
    const retry = await run('重试当前任务');
    expect(understand).toHaveBeenLastCalledWith(expect.objectContaining({userMessage:'明天有哪些排课'}), expect.any(AbortSignal));
    expect(retry.workspace.title).toContain('2026-10-22');
  });
  it('原预览已经确认时，不把取消对话当成撤销交易', async () => {
    const { run, tools } = setup([intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' })]);
    await run('收1000'); tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    const result = await run('取消当前办理'); expect(tools.readPreview).toHaveBeenCalled(); expect(tools.invalidatePreview).not.toHaveBeenCalled(); expect(result.answer).toContain('原业务已经确认执行'); expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('浏览器确认后先同步Core终态，询问这笔记录只展示原回执而不重复生成预览', async () => {
    const { run, tools } = setup([
      intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' }),
      intent('receipt.read' as DialogueIntent['operation'], {}),
    ]);
    const first = await run('给林悦主课交1000元，微信');
    tools.readPreview.mockResolvedValue({
      status: 'EXECUTED',
      actionType: 'course-account.payment',
      display: { title:'课程交费', summary:'交费 ¥1000.00' },
      receipt: { receiptId:'receipt-1', amount:'1000.00' },
    });

    const reopened = await run('把刚办好的给我看看');

    expect(tools.readPreview).toHaveBeenCalledWith('cap', first.task.previewId);
    expect(reopened.answer).toMatch(/已执行.*1000\.00/);
    expect(reopened.task.executedPreviewId).toBe(first.task.previewId);
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('已执行标记跨多轮保留，不能先取消再更正重复生成原交费', async () => {
    const { run, tools, understand } = setup([intent('payment.preview', {studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'})]);
    await run('收1000微信');
    tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    await run('取消当前办理');
    understand.mockResolvedValueOnce(intent(null,{amount:'100'},'correct'));
    const next = await run('那改成100');
    expect(next.answer).toContain('已经确认执行');
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
  });
  it('撤销预览服务失败时保留待核对ID，不能遗失一个仍可确认的旧预览', async () => {
    const { run, tools, understand } = setup([intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' })]);
    const first=await run('收1000'); tools.invalidatePreview.mockRejectedValue(new CoreDialogueError(500));
    const result=await run('改金额'); expect(result.task.previewId).toBe(first.task.previewId); expect(understand).toHaveBeenCalledTimes(2); expect(result.workspace.blocks).toContainEqual(expect.objectContaining({type:'error-recovery'}));
  });
  it('教师资料与默认薪酬都只生成可确认预览且不创建登录账号', async () => {
    const created = setup([intent('teacher.create', { name:'赵老师',baseSalary:'2000.00',commissionRate:'10.0000' })]);
    const createResult = await created.run('新增赵老师，基本工资2000，提成10%');
    expect(created.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'teacher.create', command:{ name:'赵老师',baseSalary:'2000.00',commissionRate:'10.0000' },
    }));
    expect(createResult.answer).toContain('不会创建登录账号');

    const updated = setup([intent('teacher.compensation.update', { teacherName:'王老师',baseSalary:'2200.00',commissionRate:'12.0000' })]);
    await updated.run('把王老师基本工资改成2200，提成12%');
    expect(updated.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'teacher.compensation.update', command:expect.objectContaining({ teacherId,baseSalary:'2200.00',commissionRate:'12.0000' }),
    }));
  });
  it('流水冲正从Core真实流水中选定目标，不接受模型提供entryId', async () => {
    const { run, tools } = setup([intent('ledger-entry.reversal', { studentName:'林悦',courseName:'主课',amount:'500',kind:'交费',reason:'重复登记' })]);
    await run('冲正林悦主课最近一笔500元交费，重复登记');
    expect(tools.readAccountLedger).toHaveBeenCalledWith('cap', { accountId });
    expect(tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'ledger-entry.reversal', command:expect.objectContaining({ entryId:'entry-1',reason:'重复登记' }),
    }));
  });
  it('撤销工资支付只选择Core中已支付工资并生成预览', async () => {
    const { run, tools } = setup([intent('payroll.cancel-payment', { teacherName:'王老师',period:'2026-10',reason:'支付信息有误' })]);
    tools.getPayrollCandidates.mockResolvedValue({ candidates:[{ payrollId:'49fbcf47-c616-468a-a058-cdca1ee66026',teacherId,teacherName:'王老师',period:'2026-10',status:'PAID' }] });
    await run('撤销王老师10月工资支付，支付信息有误');
    expect(tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({
      actionType:'payroll.cancel-payment', command:{ payrollId:'49fbcf47-c616-468a-a058-cdca1ee66026',reason:'支付信息有误' },
    }));
  });
});
