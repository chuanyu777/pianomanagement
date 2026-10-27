import { describe, expect, it } from 'vitest';
import { LESSON_ID, createAuditHarness, newIntent } from './audit-harness.js';

// 编排契约测试：固定意图由 Fake BaseChatModel 提供；本文件不声称覆盖自然语言理解。

describe('AI dialogue query audit: Q01-Q11', () => {
  it('Q01 returns today todo summary with no business write', async () => {
    const h = createAuditHarness([newIntent('overview.read')]);
    const result = await h.run('q01', '今天先处理哪些事情？');
    expect(h.calls.getDashboardSummary).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain('已结束未确认课程 1 节');
    expect(result.answer).toContain('欠费学生');
    expect(result.answer).toContain('待支付工资');
    expect(result.answer).toContain('关账前异常');
    expect(h.readCalls.readPeriodPreclose).toHaveBeenCalledWith(expect.any(String), { period: '2026-10' });
    expect(JSON.stringify(result.workspace)).not.toContain('action-preview');
  });

  it.each([
    ['查询今天的排课', '2026-10-21', ['林悦', '小雨']], ['今天安排了什么课', '2026-10-21', ['林悦', '小雨']],
    ['查看昨天排课', '2026-10-20', ['林悦']], ['查看明天排课', '2026-10-22', ['林悦']],
    ['后天排课', '2026-10-23', ['林悦']], ['查看2026-10-24的排课', '2026-10-24', []],
  ])('Q02 routes date wording to the requested lesson range: %s', async (message, date, students) => {
    const h = createAuditHarness([newIntent('lessons.read', { dateFrom: '2026-10-01', dateTo: '2026-10-02' })]);
    const result = await h.run(`q02-${date}`, message);
    expect(result.workspace).toMatchObject({ title: expect.stringContaining(date) });
    expect(result.answer).toContain(date);
    expect(h.readCalls.readLessons).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dateFrom: date, dateTo: date }));
    for (const student of students) expect(result.answer).toContain(student);
    if (students.length === 0) expect(result.answer).toMatch(/没有排课|空/u);
  });

  it('Q02 keeps the query intent in the same task when “那明天呢” changes only the date', async () => {
    const h = createAuditHarness([newIntent('lessons.read', { dateFrom: '2026-10-01', dateTo: '2026-10-02' }), newIntent('lessons.read', { dateFrom: '2026-10-01', dateTo: '2026-10-02' }, 'continue')]);
    await h.run('q02-relative', '今天有哪些排课？');
    const result = await h.run('q02-relative', '那明天呢？');
    expect(result.workspace).toMatchObject({ title: expect.stringContaining('2026-10-22') });
    expect(result.answer).toContain('林悦');
    expect(result.answer).not.toContain('小雨');
    expect(h.readCalls.readLessons).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ dateFrom: '2026-10-22', dateTo: '2026-10-22' }));
  });

  it('Q03 preserves an explicit multi-day range when a teacher filter is added', async () => {
    const h = createAuditHarness([newIntent('lessons.read', { dateFrom: '2026-10-01', dateTo: '2026-10-02' }), newIntent('lessons.read', { teacherName: '王老师' }, 'continue')]);
    await h.run('q03-range', '查10月20日到22日的排课。');
    const result = await h.run('q03-range', '只看王老师的。');
    expect(h.readCalls.readLessons).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ dateFrom: '2026-10-20', dateTo: '2026-10-22', teacherName: '王老师' }));
    expect(result.answer).toContain('2026-10-20');
    expect(result.answer).toContain('2026-10-22');
    expect(result.answer).toContain('王老师');
    expect(result.answer).not.toContain('李老师');
  });

  it.each([
    ['本月排课', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }, ['2026-10-01', '2026-10-31']],
    ['上月排课', { dateFrom: '2026-09-01', dateTo: '2026-09-30' }, ['2026-09-01', '2026-09-30']],
    ['查最近几天的课', {}, ['请补充具体范围']],
  ])('Q03 handles calendar range or ambiguity without guessing: %s', async (message, fields, expected) => {
    const h = createAuditHarness([newIntent('lessons.read', Object.keys(fields).length ? { dateFrom: '2026-10-02', dateTo: '2026-10-03' } : fields)]);
    const result = await h.run('q03-calendar', message);
    for (const term of expected) expect(result.answer).toContain(term);
    expect(result.workspace?.title).not.toBe('暂不支持此查询');
  });

  it('K01 reads the Core pre-close checklist and reports unresolved facts without deciding their blocking severity', async () => {
    const h = createAuditHarness([newIntent('period.preclose.read', { period: '2026-10' })]);
    const result = await h.run('k01-preclose', '检查2026年10月关账前还有什么要处理。');
    expect(result.answer).toContain('2026-10');
    expect(result.answer).toContain('林悦');
    expect(result.answer).toContain('王老师');
    expect(result.answer).toMatch(/人工判断|需判断|阻断/u);
    expect(h.readCalls.readPeriodPreclose).toHaveBeenCalledWith(expect.any(String), { period: '2026-10' });
  });

  it.each([
    ['查一下小明', ['小明', '同名']], ['有哪些老师？', ['王老师']], ['主课和陪练各多长时间、默认多少钱？', ['60', '80.00']],
  ])('Q04 returns basic records without financial data: %s', async (message, expected) => {
    const h = createAuditHarness([newIntent('directory.read')]);
    const result = await h.run('q04', message);
    for (const term of expected) expect(result.answer).toContain(term);
    expect(result.answer).not.toMatch(/余额|交费|赠送|流水/u);
  });

  it('Q05 returns separate per-course paid/gift balances and locked unit prices', async () => {
    const h = createAuditHarness([newIntent('accounts.read', { studentName: '林悦' })]);
    const result = await h.run('q05', '林悦每门课还有多少钱？');
    expect(result.answer).toContain('主课');
    expect(result.answer).toContain('实收 500.00');
    expect(result.answer).toContain('赠送 80.00');
    expect(result.answer).toContain('总 580.00');
    expect(result.answer).toContain('陪练');
    expect(result.answer).toContain('实收 120.00');
    expect(result.answer).toContain('单价 80.00');
    expect(result.answer).not.toMatch(/剩余课次|课包/u);
  });

  it.each([
    ['Q06', '查林悦本月主课的扣费流水。', ['林悦', '主课', '2026-10', '课消', '经办人']],
    ['Q07', '林悦主课为什么只剩380元？', ['交费 500.00', '赠送 80.00', '课消 200.00', '实收 380.00']],
    ['Q08', '哪些学生欠费？', ['周宁', '主课']],
    ['Q08 frozen', '再看看冻结学生，为什么被冻结？', ['赵一', '31天']],
    ['Q09', '看10月课消，按课程分开。', ['主课', '400.00', '陪练', '80.00', '480.00']],
    ['Q11', '为什么10月现金是负380，利润却有190？', ['-380.00', '190.00', '570.00']],
  ])('%s retains its original business-result assertion against its designed read operation', async (id, message, expected) => {
    const operation = id === 'Q08' || id === 'Q08 frozen' ? 'arrears.read'
      : id === 'Q09' ? 'consumption.read'
        : id === 'Q11' ? 'report.monthly'
          : 'ledger.read';
    const fields = operation === 'consumption.read' ? { period: '2026-10' }
      : operation === 'report.monthly' ? { period: '2026-10', basis: '对比' }
        : operation === 'ledger.read' && id === 'Q06' ? { studentName: '林悦', courseName: '主课', dateFrom: '2026-10-01', dateTo: '2026-10-31' }
          : operation === 'ledger.read' ? { studentName: '林悦', courseName: '主课' } : {};
    const h = createAuditHarness([newIntent(operation, fields)], id === 'Q07' ? {
      readAccount: async () => ({ accountId:'22222222-2222-4222-8222-222222222222',studentName:'林悦',courseName:'主课',paidBalance:'380.00',giftBalance:'0.00',totalBalance:'380.00',currentUnitPrice:'200.00' }),
    } : {});
    const result = await h.run(id, message);
    for (const term of expected) expect(result.answer).toContain(term);
    expect(result.answer).not.toMatch(/我已|已经为你|操作成功/u);
  });

  it('Q10 asks for revenue口径 before selecting operating income versus cash receipts and retains the selected scope', async () => {
    const h = createAuditHarness([newIntent('report.monthly', { period: '2026-10' }), newIntent('report.monthly', { basis: '经营' }, 'continue')]);
    const clarification = await h.run('q10', '查看这个月收入。');
    expect(clarification.answer).toMatch(/实际收款|经营收入|口径/u);
    const operating = await h.run('q10', '看经营收入。');
    expect(operating.answer).toContain('2670.00');
    expect(operating.answer).not.toContain('现金净额');
  });
});

describe('AI dialogue query audit: C03-C05', () => {
  it('C03 continues the same reschedule task after resolving “这节课” from the next turn', async () => {
    const h = createAuditHarness([
      newIntent('lesson.reschedule', { targetStartsAt: '2026-10-22T18:00:00+08:00' }),
      newIntent('lesson.reschedule', { studentName: '林悦', courseName: '主课', date: '2026-10-22' }, 'continue'),
    ]);
    await h.run('c03', '把这节课改到18:00。');
    const result = await h.run('c03', '林悦明天9点的主课。');
    expect(h.calls.getLessonCandidates).toHaveBeenCalledWith(expect.any(String), { studentName: '林悦', match: 'search', date: '2026-10-22' });
    expect(h.calls.createStructuredActionPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actionType: 'lesson.reschedule', command: expect.objectContaining({ lessonId: LESSON_ID, targetStartsAt: '2026-10-22T18:00:00+08:00' }) }));
    expect(result.workspace).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'action-preview', actionType: 'lesson.reschedule' })]) });
  });

  it('C03 does not guess an object or amount for “照旧交费” without a unique prior reference', async () => {
    const h = createAuditHarness([newIntent('payment.preview')]);
    const result = await h.run('c03-implicit', '照旧交费。');
    expect(result.answer).toMatch(/学生|课程|金额|渠道/u);
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
  });

  it('C04 starts a new task without inheriting the prior student, amount, or channel', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), newIntent(null, {}, 'clarify')]);
    await h.run('c04-prior', '给林悦的主课交费1000元，微信');
    const result = await h.run('c04-new', '也给小雨办一下。');
    expect(result.answer).toMatch(/办理什么|业务|操作/u);
    expect(result.answer).not.toMatch(/林悦|1000|微信/u);
    expect(h.calls.createPaymentPreview).toHaveBeenCalledTimes(1);
  });

  it('C04 retains only the new task subject while collecting its missing payment channel', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '小雨' }), newIntent('payment.preview', { courseName: '陪练', amount: '200' }, 'continue')]);
    await h.run('c04-fields', '也给小雨办一下。');
    const result = await h.run('c04-fields', '交费，陪练200元。');
    expect(result.answer).toContain('小雨');
    expect(result.answer).toContain('渠道');
    expect(result.answer).not.toContain('微信');
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
  });

  it('C05 invalidates the old preview when amount and channel are corrected', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), newIntent('payment.preview', { amount: '100', channel: '支付宝' }, 'correct')]);
    await h.run('c05', '给林悦的主课交费1000元，微信');
    const corrected = await h.run('c05', '不是1000，是100，改支付宝。');
    expect(h.calls.createPaymentPreview).toHaveBeenCalledTimes(2);
    expect(h.calls.createPaymentPreview).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ amount: '100.00', channel: 'ALIPAY' }));
    expect(corrected.workspace).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'action-preview' })]) });
    expect(JSON.stringify(corrected.workspace)).not.toContain('1000.00');
  });

  it('C05 turns a cancelled payment request into a read-only balance query with no preview', async () => {
    const h = createAuditHarness([
      newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }),
      newIntent('accounts.read', { studentName: '林悦', courseName: '主课' }),
    ]);
    await h.run('c05-cancel', '给林悦的主课交费1000元，微信。');
    h.calls.createPaymentPreview.mockClear();
    const result = await h.run('c05-cancel', '先别收了，只查一下余额。');
    expect(result.answer).toContain('500.00');
    expect(result.answer).toContain('80.00');
    expect(result.answer).not.toMatch(/预览|登记|收款/u);
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
    expect(h.readCalls.invalidatePreview).toHaveBeenCalled();
  });
});
