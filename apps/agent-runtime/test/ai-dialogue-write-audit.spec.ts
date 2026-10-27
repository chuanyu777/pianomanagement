import { describe, expect, it } from 'vitest';
import { ACCOUNT_ID, ACCOUNT_ID_2, LESSON_ID, STUDENT_ID, TEACHER_ID, createAuditHarness, newIntent } from './audit-harness.js';
import { CoreDialogueError } from '../src/tools/dialogue-tools.js';

// 编排契约测试：意图 JSON 是每例显式 fixture；不调用真实模型，也不模拟关键词路由。

describe('AI 对话写操作离线编排审计（B/S/F/R/W/M/K）', () => {
  it('B01 新增学生的自然语句应到达资料预览，而不是落入查询兜底', async () => {
    const h = createAuditHarness([newIntent('student.create', { name: '小晴', notes: '周末方便上课' })]);
    const result = await h.run('b01', '新增学生小晴，备注周末方便上课。');
    expect(result.answer).toContain('小晴');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'student.create' }));
    expect(h.calls.getDashboardSummary).not.toHaveBeenCalled();
  });

  it('B06 开户并按默认价的自然语句应申请课程账户预览', async () => {
    const h = createAuditHarness([newIntent('course-account.open', { studentName: '小雨', courseName: '主课' })]);
    const result = await h.run('b06', '给小雨开通主课，按默认价。');
    expect(result.answer).toContain('预览');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'course-account.open' }));
  });

  it('S01 “明天下午三点排课”应识别学生、老师、课程和日期并申请单节预览', async () => {
    const h = createAuditHarness([newIntent('lesson.schedule', { studentName: '小雨', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T15:00:00+08:00' })]);
    const result = await h.run('s01', '给小雨明天下午三点排王老师的主课。');
    expect(h.calls.getCourseAccountCandidates).toHaveBeenCalledWith(expect.any(String), { studentName: '小雨', courseName: '主课', match: 'search' });
    expect(h.calls.getTeacherCandidates).toHaveBeenCalledWith(expect.any(String), { teacherName: '王老师', match: 'search' });
    expect(h.calls.createSingleLessonPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, teacherId: TEACHER_ID, startsAt: '2026-10-22T15:00:00+08:00' }));
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'lesson.schedule.single' }));
  });

  it('S03 “从下周三起每周三晚上七点共12周”应申请批量排课预览', async () => {
    const h = createAuditHarness([newIntent('lesson.schedule', { studentName: '小雨', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-28T19:00:00+08:00', weeks: '12' })]);
    const result = await h.run('s03', '给小雨从下周三开始，每周三晚上七点排王老师主课，共12周。');
    expect(h.calls.createBatchLessonPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, teacherId: TEACHER_ID, firstStartsAt: '2026-10-28T19:00:00+08:00', weeks: 12 }));
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'lesson.schedule.weekly-batch' }));
  });

  it('S02 缺少排课时间时应补问且不得查询账户或申请预览', async () => {
    const h = createAuditHarness([newIntent('lesson.schedule', { studentName: '小雨', courseName: '主课', teacherName: '王老师' })]);
    const result = await h.run('s02', '给小雨排一节主课，王老师。');
    expect(result.answer).toContain('上课日期时间');
    expect(result.workspace?.title).toBe('请补充信息');
    expect(h.calls.getCourseAccountCandidates).not.toHaveBeenCalled();
    expect(h.calls.createSingleLessonPreview).not.toHaveBeenCalled();
  });

  it('F01 “给林悦主课交费1000元，微信”应申请交费预览且只传金额1000', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000', channel: '微信' })]);
    const result = await h.run('f01', '给林悦主课交费1000元，微信。');
    expect(h.calls.createPaymentPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, amount: '1000.00', channel: 'WECHAT' }));
    expect(result.answer).toContain('尚未登记');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'course-account.payment' }));
  });

  it('F02 缺少交费渠道时应补问，不应先解析账户或生成预览', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '林悦', courseName: '主课', amount: '1000' })]);
    const result = await h.run('f02', '给林悦的主课交费1000元。');
    expect(result.answer).toContain('渠道');
    expect(result.workspace?.title).toBe('请补充信息');
    expect(h.calls.getCourseAccountCandidates).not.toHaveBeenCalled();
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
  });

  it('F03 赠送金额与登记渠道的自然说法应申请赠送预览，不得变成收款', async () => {
    const h = createAuditHarness([newIntent('gift.preview', { studentName: '林悦', courseName: '主课', amount: '80', note: '续费活动' })]);
    const result = await h.run('f03', '给林悦主课赠送80元，登记渠道微信，备注续费活动。');
    expect(h.calls.createGiftPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountId: ACCOUNT_ID, amount: '80.00', note: '续费活动' }));
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'course-account.gift' }));
  });

  it('R01 最终退学退款自然语句应保留手续费、渠道和备注并申请严格预览', async () => {
    const h = createAuditHarness([newIntent('refund.preview', { studentName: '小林', feeAmount: '100', channel: '银行卡', note: '线下已办好' })]);
    const result = await h.run('r01', '登记小林最终退学退款，手续费100元，银行卡，线下已办好。');
    expect(h.calls.getStudentCandidates).toHaveBeenCalledWith(expect.any(String), { studentName: '小林', match: 'search' });
    expect(h.calls.createFinalRefundPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ studentId: STUDENT_ID, feeAmount: '100.00', channel: 'BANK_CARD', note: '线下已办好' }));
    expect(result.answer).toContain('尚未登记退款');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'student.final-refund', riskLevel: 'L2' }));
  });

  it('R02 缺少手续费和渠道时应补问，不能默认零手续费或默认课程范围', async () => {
    const h = createAuditHarness([newIntent('refund.preview', { studentName: '小林' })]);
    const result = await h.run('r02', '给小林办最终退学退款。');
    expect(result.answer).toContain('固定手续费');
    expect(result.workspace?.title).toBe('请补充信息');
    expect(h.calls.getStudentCandidates).not.toHaveBeenCalled();
    expect(h.calls.createFinalRefundPreview).not.toHaveBeenCalled();
  });

  it('R02 零手续费补参必须被当作明确数值而不是缺失值', async () => {
    const h = createAuditHarness([
      newIntent('refund.preview', { studentName: '小林' }),
      newIntent(null, { feeAmount: '0', channel: '微信', note: '线下已经退过' }, 'continue'),
    ]);
    await h.run('r02-zero', '给小林办最终退学退款。');
    const result = await h.run('r02-zero', '手续费0，微信，线下已经退过。');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'student.final-refund' }));
    expect(h.calls.createFinalRefundPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ feeAmount: '0.00', channel: 'WECHAT', note: '线下已经退过' }));
  });

  it('S12 对唯一已完成课程给出状态限制，不能生成普通调课预览', async () => {
    const h = createAuditHarness([newIntent('lesson.reschedule', { courseName: '主课', status: '已完成', targetStartsAt: '2026-10-22T09:00:00+08:00' })], {
      readLessons: async () => ({ businessDate: '2026-10-21', filters: {}, lessons: [{ lessonId: LESSON_ID, startsAt:'2026-10-21T01:00:00.000Z', endsAt:'2026-10-21T02:00:00.000Z', status:'COMPLETED', statusLabel:'已完成', studentId:STUDENT_ID, studentName:'林悦', courseId:'55555555-5555-4555-8555-555555555555', courseName:'主课', teacherId:TEACHER_ID, teacherName:'王老师' }] }),
    });
    const result = await h.run('s12-completed', '把这节已完成的主课改到明天。');
    expect(result.error).toBeUndefined();
    expect(result.answer).toMatch(/已完成.*不能.*调课|不能.*已完成.*调课/u);
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('P03 多动作请求仍先由 Core 权限边界拒绝，不产生任何预览', async () => {
    const h = createAuditHarness([newIntent(null, {}, 'clarify')], {
      checkActionAccess: async () => { throw new CoreDialogueError(403); },
    });
    const result = await h.run('p03-composite', '把李老师明天的课取消，再撤销林悦今天的上课确认。');
    expect(result.answer).toMatch(/无权|权限/u);
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('W02 “生成王老师2026年10月工资”应识别月份并申请工资生成预览', async () => {
    const h = createAuditHarness([newIntent('payroll.generate', { teacherName: '王老师', period: '2026-10' })]);
    const result = await h.run('w02', '生成王老师2026年10月工资。');
    expect(h.calls.getTeacherCandidates).toHaveBeenCalledWith(expect.any(String), { teacherName: '王老师', match: 'search' });
    expect(h.calls.createStructuredActionPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actionType: 'payroll.generate', command: expect.objectContaining({ period: '2026-10', teacherId: TEACHER_ID }) }));
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'payroll.generate' }));
  });

  it('W04 正奖金缺少说明时应补问，不能在没有理由的情况下申请预览', async () => {
    const h = createAuditHarness([newIntent('payroll.adjust', { teacherName: '王老师', period: '2026-10', bonusAmount: '100' })]);
    const result = await h.run('w04', '给王老师 2026-10 工资加奖金 100 元。');
    expect(result.answer).toContain('说明');
    expect(result.workspace?.title).toBe('请补充信息');
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('M01 “今天卖书收到50元，微信，登记收入”应申请书籍销售收入预览', async () => {
    const h = createAuditHarness([newIntent('manual-transaction.create', { kind: '收入', category: '书籍销售', amount: '50', channel: '微信', occurredAt: '2026-10-21T03:00:00.000Z' })]);
    const result = await h.run('m01', '今天卖书收到50元，微信，登记收入。');
    expect(result.answer).toContain('50.00');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'manual-transaction.create' }));
  });

  it('M02 “今天付房租200元，银行卡，登记支出”应识别为房租物业支出', async () => {
    const h = createAuditHarness([newIntent('manual-transaction.create', { kind: '支出', category: '房租物业', amount: '200', channel: '银行卡', occurredAt: '2026-10-21T03:00:00.000Z' })]);
    const result = await h.run('m02', '今天付房租200元，银行卡，登记支出。');
    expect(result.answer).toContain('200.00');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'manual-transaction.create' }));
  });

  it('K02 “把2026年9月关账”应识别月份并申请关账预览', async () => {
    const h = createAuditHarness([newIntent('period.close', { period: '2026-09' })]);
    const result = await h.run('k02', '把2026年9月关账。');
    expect(h.calls.createStructuredActionPreview).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actionType: 'period.close', command: expect.objectContaining({ period: '2026-09' }) }));
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'period.close' }));
  });

  it('K03 撤销关账缺少原因时应补问，不能申请重开预览', async () => {
    const h = createAuditHarness([newIntent('period.reopen', { period: '2026-09' })]);
    const result = await h.run('k03', '撤销2026年9月关账。');
    expect(result.answer).toContain('原因');
    expect(result.workspace?.title).toBe('请补充信息');
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });

  it('C01 同名课程账户未选择前不得读取金额或申请交费预览', async () => {
    const h = createAuditHarness([newIntent('payment.preview', { studentName: '小明', courseName: '主课', amount: '100', channel: '微信' })], {
      getCourseAccountCandidates: (async () => ({ candidates: [{ accountId: ACCOUNT_ID, studentName: '小明', courseName: '主课' }, { accountId: ACCOUNT_ID_2, studentName: '小明', courseName: '主课' }] })) as unknown,
    });
    const result = await h.run('c01', '给小明的主课交费100元，微信。');
    expect(result.answer).toContain('选择');
    expect(result.workspace?.title).toBe('请选择办理对象');
    expect(h.calls.createPaymentPreview).not.toHaveBeenCalled();
  });

  it('S08 取消课程的对象不唯一时应让用户选择，不能擅自申请取消预览', async () => {
    const h = createAuditHarness([newIntent('lesson.cancel', { studentName: '林悦', date: '2026-10-22' })], {
      getLessonCandidates: (async () => ({ candidates: [{ lessonId: LESSON_ID, studentName: '林悦', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-22T01:00:00.000Z', status: 'SCHEDULED' }, { lessonId: ACCOUNT_ID, studentName: '林悦', courseName: '陪练', teacherName: '李老师', startsAt: '2026-10-22T05:00:00.000Z', status: 'SCHEDULED' }] })) as unknown,
    });
    const result = await h.run('s08', '林悦明天请假，取消排课。');
    expect(result.answer).toContain('选择');
    expect(result.workspace?.title).toBe('请选择办理对象');
    expect(h.calls.createStructuredActionPreview).not.toHaveBeenCalled();
  });
});
