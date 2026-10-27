import { describe, expect, it } from 'vitest';
import { ACCOUNT_ID, ACCOUNT_ID_2, ACCOUNT_ID_3, LESSON_ID, TEACHER_ID, TEACHER_ID_3, createAuditHarness, newIntent } from './audit-harness.js';

// 编排契约测试：固定意图序列只隔离模型输出，实际任务状态和生产 executor/Graph 仍运行。

describe('AI 对话上下文专项审计（C01-C08、E01、E06）', () => {
  it('C01：同名学生在选择前不得读取余额，选择后要能恢复原任务', async () => {
    const h = createAuditHarness([
      newIntent('accounts.read', { studentName: '小明', courseName: '主课' }),
      newIntent('accounts.read', { selectionId: ACCOUNT_ID_3 }, 'continue'),
      newIntent('payment.preview', { amount: '100', channel: '微信' }, 'continue'),
    ], { getCourseAccountCandidates: (async () => ({ candidates: [{ accountId: ACCOUNT_ID_2, studentName: '小明', courseName: '主课' }, { accountId: ACCOUNT_ID_3, studentName: '小明', courseName: '主课' }] })) as unknown });
    const first = await h.run('c01', '小明主课还剩多少钱？');
    expect(first.answer).not.toMatch(/500\.00|600\.00|余额\s*[:：]?\s*\d/u);
    expect(first.answer).toMatch(/选择|匹配/u);
    const selected = await h.run('c01', '选择第二位');
    expect(selected.answer).toMatch(/实收|余额|课程/u);
    const payment = await h.run('c01', '给他主课交100元，微信');
    expect(h.calls.createPaymentPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID_3, amount: '100.00', channel: 'WECHAT' }));
    expect(payment.answer).toContain('预览');
  });

  it('C02：同名老师选择后必须把真实 teacherId 带回排课 Preview', async () => {
    const h = createAuditHarness([
      newIntent('lesson.schedule', { studentName: '小雨', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T15:00:00+08:00' }),
      newIntent('lesson.schedule', { selectionId: TEACHER_ID_3 }, 'continue'),
    ], { getTeacherCandidates: (async () => ({ candidates: [{ teacherId: TEACHER_ID, name: '王老师' }, { teacherId: TEACHER_ID_3, name: '王老师' }] })) as unknown });
    const first = await h.run('c02', '给小雨的主课安排王老师于2026-10-22 15:00');
    expect(first.answer).toMatch(/选择|匹配/u);
    expect(h.calls.createSingleLessonPreview).not.toHaveBeenCalled();
    const selected = await h.run('c02', '选择T3');
    expect(h.calls.createSingleLessonPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, teacherId: TEACHER_ID_3, startsAt: '2026-10-22T15:00:00+08:00' }));
    expect(selected.answer).toContain('预览');
  });

  it('C03：补充“这节课”的唯一指向后，必须保留原调课目标', async () => {
    const h = createAuditHarness([newIntent('lesson.reschedule', { targetStartsAt: '2026-10-22T18:00:00+08:00' }), newIntent('lesson.reschedule', { studentName: '林悦', courseName: '主课', date: '2026-10-22' }, 'continue')]);
    const first = await h.run('c03', '把这节课改到18:00');
    expect(first.answer).toMatch(/课程|补充|选择/u);
    const continued = await h.run('c03', '林悦明天9点的主课');
    expect(h.calls.getLessonCandidates).toHaveBeenCalledWith(expect.any(String), { studentName: '林悦', match: 'search', date: '2026-10-22' });
    expect(h.calls.createStructuredActionPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actionType: 'lesson.reschedule', command: expect.objectContaining({ lessonId: LESSON_ID, targetStartsAt: '2026-10-22T18:00:00+08:00' }) }));
    expect(continued.answer).toContain('预览');
  });

  it('C04：新任务不得继承上一任务的金额、渠道或办理对象', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), newIntent(null, {}, 'clarify')]);
    await h.run('c04-old', '给林悦的主课交费1000元，微信');
    const callsBeforeNewTask = h.calls.createPaymentPreview.mock.calls.length;
    const newTask = await h.run('c04-new', '也给小雨办一下');
    expect(newTask.answer).toMatch(/要办理什么|业务|交费|排课|补充/u);
    expect(newTask.answer).not.toMatch(/1000|微信|林悦/u);
    expect(h.calls.createPaymentPreview).toHaveBeenCalledTimes(callsBeforeNewTask);
  });

  it('C05：否定、更正和取消必须使旧 Preview 失效，不能沿用旧参数', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' }), newIntent('payment.preview', { amount: '100', channel: '支付宝' }, 'correct'), newIntent('accounts.read', { studentName: '林悦', courseName: '主课' }, 'new')]);
    await h.run('c05', '给林悦的主课交费1000元，微信');
    await h.run('c05', '不是1000，是100，改支付宝');
    const cancelled = await h.run('c05', '先别收了，只查一下余额');
    expect(h.calls.createPaymentPreview).toHaveBeenCalledTimes(2);
    expect(h.calls.createPaymentPreview).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ amount: '100.00', channel: 'ALIPAY' }));
    expect(h.calls.createPaymentPreview).not.toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ amount: '1000.00', channel: 'WECHAT' }));
    expect(cancelled.answer).toMatch(/500\.00|80\.00|余额/u);
  });

  it('C06：一句话多个动作要拆分依赖并分别确认，前一步失败不能伪称全部成功', async () => {
    const h = createAuditHarness([], {}, [{ steps:[
      { operation:'payment.preview',fields:{studentName:'小雨',courseName:'主课',amount:'1000',channel:'微信'} },
      { operation:'lesson.schedule',fields:{studentName:'小雨',courseName:'主课',teacherName:'王老师',startsAt:'2026-10-22T15:00:00+08:00'} },
    ] }]);
    const attempt = await h.run('c06', '小雨主课交费1000，微信，再给她排明天15点王老师的课');
    expect(attempt.answer).toMatch(/交费/u);
    expect(attempt.answer).toMatch(/排课/u);
    expect(attempt.answer).toMatch(/分别|顺序|确认|待/u);
    expect(attempt.answer).not.toMatch(/全部成功|已经.*排课|已经.*交费/u);
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
    expect(h.calls.createSingleLessonPreview).not.toHaveBeenCalled();
  });

  it('C07：多个金额、课程和赠送说法不得串成一笔1080元收款或改动陪练', async () => {
    const h = createAuditHarness([], {}, [{ steps:[
      { operation:'payment.preview',fields:{studentName:'林悦',courseName:'主课',amount:'1000',channel:'微信'} },
      { operation:'gift.preview',fields:{studentName:'林悦',courseName:'主课',amount:'80',note:'续费赠送'} },
    ] }]);
    const attempt = await h.run('c07', '林悦主课收1000，另外送80，不是收1080；陪练不动，两项登记渠道都选微信');
    expect(attempt.answer).toMatch(/1000/u);
    expect(attempt.answer).toMatch(/80/u);
    expect(attempt.answer).toMatch(/主课/u);
    expect(attempt.answer).toMatch(/陪练/u);
    expect(attempt.answer).not.toMatch(/收款\s*1080|交费\s*1080/u);
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
  });

  it('C08：超范围请求要明确拒绝并保留可继续的本期边界，不得自动排课或通知', async () => {
    const h = createAuditHarness([newIntent('unsupported'), newIntent('lesson.schedule', { weeks: '12' })]);
    const unsupported = await h.run('c08', '以后每周都自动排下去，不用再问我，再自动微信通知家长');
    expect(unsupported.answer).toMatch(/不支持|不能|本期|指定周数/u);
    expect(h.calls.getDashboardSummary).not.toHaveBeenCalled();
    const bounded = await h.run('c08', '那先排12周，具体安排我再说');
    expect(bounded.answer).toMatch(/学生|课程|老师|时间|补充/u);
    expect(h.calls.createSingleLessonPreview).not.toHaveBeenCalled();
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('E01：查询服务故障必须返回可恢复的失败状态，不能伪装空数据或成功', async () => {
    let calls = 0;
    const h = createAuditHarness([newIntent('lessons.read', { dateFrom: '2026-10-22', dateTo: '2026-10-22' }), newIntent('lessons.read', { dateFrom: '2026-10-22', dateTo: '2026-10-22' })], {
      readLessons: (async () => { calls += 1; if (calls === 1) throw new Error('synthetic query failure'); return { lessons: [{ lessonId: LESSON_ID, startsAt: '2026-10-22T01:00:00.000Z', endsAt: '2026-10-22T02:00:00.000Z', studentName: '林悦', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' }], total: 1 }; }) as unknown,
    });
    const failed = await h.run('e01', '查看明天的排课');
    expect(failed.error).toBeUndefined();
    expect(failed.answer).toMatch(/查询失败|重试|暂时无法/u);
    expect(failed.answer).not.toMatch(/没有排课|查询成功|经营摘要/u);
    const retried = await h.run('e01', '查看明天的排课');
    expect(calls).toBe(2);
    expect(retried.answer).toMatch(/2026-10-22|林悦|主课|王老师/u);
  });

  it('E06：补问中 Agent 重启/消息断开后，第二轮“明天下午三点”必须恢复同一排课任务', async () => {
    const h = createAuditHarness([newIntent('lesson.schedule', { studentName: '小雨', courseName: '主课', teacherName: '王老师' }), newIntent('lesson.schedule', { startsAt: '2026-10-22T15:00:00+08:00' }, 'continue')]);
    const first = await h.run('e06', '给小雨排主课，王老师');
    expect(first.answer).toMatch(/日期|时间|补充/u);
    expect(h.calls.createSingleLessonPreview).not.toHaveBeenCalled();
    const resumed = await h.run('e06', '明天下午三点');
    expect(h.calls.getCourseAccountCandidates).toHaveBeenCalledWith(expect.any(String), { studentName: '小雨', courseName: '主课', match: 'search' });
    expect(h.calls.getTeacherCandidates).toHaveBeenCalledWith(expect.any(String), { teacherName: '王老师', match: 'search' });
    expect(h.calls.createSingleLessonPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, teacherId: TEACHER_ID, startsAt: '2026-10-22T15:00:00+08:00' }));
    expect(resumed.answer).toContain('预览');
  });
});
