import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDialogueGraph, type DialogueResult } from '../src/graph/dialogue-graph.js';
import { CoreDialogueError } from '../src/tools/dialogue-tools.js';
import type { DialogueIntent } from '../src/graph/dialogue-intent.js';
import type { DialogueMultiStepPlan } from '../src/graph/dialogue-multi-step.js';

const accountId = '49fbcf47-c616-468a-a058-cdca1ee66025';
const lessonId = 'f77d8168-5d57-4e81-9c32-11e22e42b81c';
const teacherId = 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90';
function intent(operation: DialogueIntent['operation'], fields: Record<string, string | null>, mode: DialogueIntent['mode'] = 'new'): DialogueIntent { return { mode, operation, fields, question: null }; }
function setup(intents: DialogueIntent[], multiStep?: DialogueMultiStepPlan) {
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
    getCourseAccountCandidates: vi.fn().mockResolvedValue({ candidates: [{ accountId, studentName: '林悦', courseName: '主课' }] }),
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
  const graph = createDialogueGraph({ capability: 'cap', tools: tools as unknown as Parameters<typeof createDialogueGraph>[0]['tools'], understand, ...(multiStep ? { understandMultiStep: vi.fn().mockResolvedValue(multiStep) } : {}), now: () => new Date('2026-10-21T03:00:00Z') });
  let state: unknown = {};
  const run = async (message: string, runId = crypto.randomUUID()): Promise<DialogueResult> => {
    const { result } = await graph.invoke({ turn: { runId, threadId: 'task', message, previous: state } }); state = result.task; return result;
  };
  return { tools, understand, run };
}
describe('模型驱动的持续业务任务', () => {
  it('实收加赠送稳定拆成两步，不依赖模型分类结果', async () => {
    const flow=setup([intent('unsupported',{})]);
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
    const result=await flow.run('这次收1000元，主课600、陪练400，银行卡，分两笔登记');
    expect(result.answer).toContain('原请求总额1000.00元');
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
    payments.tools.getCourseAccountCandidates.mockResolvedValueOnce({ candidates:[{ accountId,studentName:'林悦',courseName:'主课' }] }).mockResolvedValueOnce({ candidates:[{ accountId:secondAccountId,studentName:'林悦',courseName:'陪练' }] });
    payments.tools.readPreview.mockResolvedValue({ status:'EXECUTED' });
    await payments.run('分别交费');
    await payments.run('开始第一步');
    const secondPayment = await payments.run('继续');
    expect(payments.tools.createPaymentPreview).toHaveBeenNthCalledWith(2, 'cap', expect.objectContaining({ accountId:secondAccountId,amount:'200.00',channel:'ALIPAY' }));
    expect(secondPayment.task.selected.accountId).toBe(secondAccountId);
  });
  it('两步计划中的相对排课时间在执行前统一转换为上海时区时间', async () => {
    const flow = setup([], { steps:[
      { operation:'payment.preview', fields:{ studentName:'林悦',courseName:'主课',amount:'100',channel:'微信' } },
      { operation:'lesson.schedule', fields:{ studentName:'林悦',courseName:'主课',teacherName:'王老师',startsAt:'明天下午三点' } },
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
    expect(tools.invalidatePreview).not.toHaveBeenCalled();
    expect(tools.createPaymentPreview).toHaveBeenCalledTimes(1);
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
  it('确定日期表达由业务日历归一化，覆盖模型错误日期并把中文状态交给Core解释', async () => {
    const { run, tools } = setup([intent('lessons.read', {
      dateFrom: '2026-10-21', dateTo: '2026-10-21', teacherName: '王老师', courseName: '主课', status: '待上课',
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
    expect(result.answer).toContain('开始日期和结束日期');
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
    expect(openAccount.tools.createStructuredActionPreview).toHaveBeenCalledWith('cap', expect.objectContaining({ actionType:'course-account.open',command:expect.objectContaining({ studentId:'student-core-1',courseId:'course-core-1',currentUnitPrice:'200.00' }) }));

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
    expect(openResult.answer).toMatch(/没有找到|候选|无法安全/);
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
      intent('payment.preview', { courseName:'陪练',amount:'300' }, 'new'),
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
    const { run, tools } = setup([intent('unsupported', {})]);
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
    choosing.tools.getCourseAccountCandidates.mockResolvedValue({ candidates:[{ accountId, studentName:'林悦', courseName:'主课' },{ accountId:crypto.randomUUID(), studentName:'林悦', courseName:'主课' }] });
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
    const otherId = crypto.randomUUID(); tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentName: '林悦', courseName: '主课' },{ accountId: otherId, studentName: '林悦', courseName: '主课' }] });
    const first = await run('查林悦主课余额'); expect(tools.readAccount).not.toHaveBeenCalled(); expect(first.workspace.blocks.some(b => b.type === 'entity-picker')).toBe(true);
    await run(`选择候选:${otherId}:${first.task.version}`); expect(tools.readAccount).toHaveBeenCalledWith('cap', { accountId: otherId });
  });
  it('拒绝旧版本选择卡和伪造候选ID', async () => {
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' })]);
    tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentName: '林悦', courseName: '主课' },{ accountId: crypto.randomUUID(), studentName: '林悦', courseName: '主课' }] });
    await run('余额'); const old = await run(`选择候选:${accountId}:0`); expect(old.answer).toContain('失效'); expect(tools.readAccount).not.toHaveBeenCalled();
    const forged = await run(`选择候选:${crypto.randomUUID()}:${old.task.version}`); expect(forged.answer).toContain('授权候选'); expect(tools.readAccount).not.toHaveBeenCalled();
  });
  it('自然语言选择同名对象也只能选择当前候选真实ID', async () => {
    const otherId = crypto.randomUUID();
    const { run, tools } = setup([intent('accounts.read', { studentName: '林悦', courseName: '主课' }), intent(null, { selectionId: otherId }, 'continue')]);
    tools.getCourseAccountCandidates.mockResolvedValue({ candidates: [{ accountId, studentName: '林悦', courseName: '主课' }, { accountId: otherId, studentName: '林悦', courseName: '主课' }] });
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
      intent('payment.preview', { studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信' }),
    ]);
    const first = await run('给林悦主课交1000元，微信');
    tools.readPreview.mockResolvedValueOnce({
      status: 'EXECUTED',
      actionType: 'course-account.payment',
      display: { title:'课程交费', summary:'交费 ¥1000.00' },
      receipt: { receiptId:'receipt-1', amount:'1000.00' },
    });

    const reopened = await run('这笔记录还能打开吗？');

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
