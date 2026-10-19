import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createBusinessQueryGraph } from '../src/graph/business-query-graph.js';

const summary = {
  businessDate: '2026-10-17',
  highlights: ['今日排课 4 节', '本月经营收入 1200.00 元'],
};
const detailedSummary = {
  role: 'OWNER', period: '2026-10',
  businessDate: '2026-10-17',
  highlights: ['今日排课 4 节', '冻结学生 2 人', '课程账户负余额学生 1 人', '2026-10 待发工资 3 笔', '本月经营收入 1200.00 元'],
  todayLessons: { total: 4, scheduled: 3, completed: 1, cancelled: 0 },
  todayLessonItems: [
    { lessonId: 'lesson-1', startsAt: '2026-10-17T01:00:00.000Z', endsAt: '2026-10-17T01:45:00.000Z', startTime: '09:00', studentName: '小明', courseName: '主课', teacherName: '王老师', statusLabel: '待上课' },
    { lessonId: 'lesson-2', startsAt: '2026-10-17T06:00:00.000Z', endsAt: '2026-10-17T06:45:00.000Z', startTime: '14:00', studentName: '小红', courseName: '陪练', teacherName: '李老师', statusLabel: '已完成' },
  ],
  frozenStudentCount: 2, studentsWithNegativeBalanceCount: 1, unpaidPayrollCount: 3,
  monthlyOperatingIncome: '1200.00',
};

describe('read-only business query graph', () => {
  it.each(['今天有哪些排课', '查询今天的排课', '查看今日排课', '今天有几节课', '今日排课', '今天的排课', '今天上什么课'])('returns only today lesson details for %s', async (userMessage) => {
    const fetchDashboardSummary = vi.fn().mockResolvedValue(detailedSummary);
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary });
    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage,
    }, { configurable: { thread_id: `today-lessons-${userMessage}` } });

    expect(fetchDashboardSummary).toHaveBeenCalledWith('request-capability');
    expect(result.clarification).toBeUndefined();
    expect(result.workspace?.title).toBe('今日排课 · 2026-10-17');
    expect(result.answer).toContain('小明');
    expect(result.answer).toContain('小红');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({
      type: 'data-table', rows: expect.arrayContaining([expect.objectContaining({ student: '小明', course: '主课' })]),
    }));
    expect(JSON.stringify(result.workspace)).not.toMatch(/冻结|负余额|工资|收入|摘要 2/u);
  });

  it.each([
    ['查看这个月收入', '本月经营收入 · 2026-10', '1200.00', '排课|冻结|负余额|工资'],
    ['本月经营收入是多少', '本月经营收入 · 2026-10', '1200.00', '排课|冻结|负余额|工资'],
    ['本月收入', '本月经营收入 · 2026-10', '1200.00', '排课|冻结|负余额|工资'],
    ['有多少冻结学生', '冻结学生 · 2026-10-17', '2', '排课|负余额|工资|收入'],
    ['查一下负余额学生', '负余额学生 · 2026-10-17', '1', '排课|冻结|工资|收入'],
    ['待发工资有几笔', '待发工资 · 2026-10', '3', '排课|冻结|负余额|收入'],
  ])('projects the matching result for %s', async (userMessage, title, value, unrelated) => {
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn().mockResolvedValue(detailedSummary) });
    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage }, { configurable: { thread_id: `scope-${userMessage}` } });
    expect(result.workspace?.title).toBe(title);
    expect(result.answer).toContain(value);
    expect(JSON.stringify(result.workspace)).not.toMatch(new RegExp(unrelated, 'u'));
  });

  it.each(['查询学生账户', '列出本周排课', '今天收入是多少'])('does not substitute the dashboard for unsupported scope %s', async (userMessage) => {
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn().mockResolvedValue(detailedSummary) });
    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage }, { configurable: { thread_id: `unsupported-${userMessage}` } });
    expect(result.answer).toContain('暂不支持');
    expect(result.workspace?.title).toBe('暂不支持此查询');
    expect(JSON.stringify(result.workspace)).not.toMatch(/1200\.00|冻结学生 2 人|今日排课 4 节/u);
  });
  it('reports an empty real schedule without rendering unrelated dashboard data', async () => {
    const empty = { ...detailedSummary, todayLessons: { total: 0, scheduled: 0, completed: 0, cancelled: 0 }, todayLessonItems: [] };
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn().mockResolvedValue(empty) });
    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage: '今天有哪些排课' }, { configurable: { thread_id: 'empty-today-lessons' } });
    expect(result.answer).toContain('没有排课');
    expect(result.workspace?.blocks).toHaveLength(1);
    expect(JSON.stringify(result.workspace)).not.toMatch(/冻结|工资|收入/u);
  });
  it('creates a payment Preview after an exact unique account resolution, without any confirm capability', async () => {
    const findCourseAccountCandidates = vi.fn().mockResolvedValue({
      candidates: [{ accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', studentName: '小明', courseName: '主课' }],
    });
    const createPaymentPreview = vi.fn().mockResolvedValue({
      previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90',
      actionType: 'course-account.payment',
      command: { accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', amount: '1000.00', channel: 'WECHAT', occurredAt: '2026-10-17T01:00:00.000Z', note: null },
      display: {
        title: '课程交费', summary: '交费 ¥1000.00',
        beforeBalance: { accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', paidBalance: '10.00', giftBalance: '2.00', totalBalance: '12.00' },
        afterBalance: { accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', paidBalance: '1010.00', giftBalance: '2.00', totalBalance: '1012.00' },
      },
      expiresAt: '2026-10-17T01:05:00.000Z', auditEventId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability',
      fetchDashboardSummary: vi.fn(), findCourseAccountCandidates, createPaymentPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给小明的主课交费 1000 元，微信',
    }, { configurable: { thread_id: 'payment-preview' } });

    expect(findCourseAccountCandidates).toHaveBeenCalledWith('request-capability', { studentName: '小明', courseName: '主课' });
    expect(createPaymentPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({
      accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', amount: '1000.00', channel: 'WECHAT',
      idempotencyKey: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', requestId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
    }));
    expect(result.answer).toContain('尚未登记');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({
      type: 'action-preview', previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', riskLevel: 'L2',
    }));
  });

  it('asks for a missing payment channel before resolving an account or requesting a Preview', async () => {
    const findCourseAccountCandidates = vi.fn();
    const createPaymentPreview = vi.fn();
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(),
      findCourseAccountCandidates, createPaymentPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给小明的主课交费 1000 元',
    }, { configurable: { thread_id: 'payment-clarification' } });

    expect(result.answer).toContain('渠道');
    expect(findCourseAccountCandidates).not.toHaveBeenCalled();
    expect(createPaymentPreview).not.toHaveBeenCalled();
  });

  it('creates a single-lesson Preview only after exact account and teacher resolution', async () => {
    const findCourseAccountCandidates = vi.fn().mockResolvedValue({
      candidates: [{ accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', studentName: '小明', courseName: '主课' }],
    });
    const findTeacherCandidates = vi.fn().mockResolvedValue({
      candidates: [{ teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b', name: '王老师' }],
    });
    const createSingleLessonPreview = vi.fn().mockResolvedValue({
      previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', actionType: 'lesson.schedule.single',
      command: {
        accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b',
        startsAt: '2026-10-20T07:00:00.000Z', endsAt: '2026-10-20T07:45:00.000Z',
      },
      display: { title: '单节排课', summary: '确认后创建一节排课记录。' }, expiresAt: '2026-10-17T01:05:00.000Z',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(),
      findCourseAccountCandidates, findTeacherCandidates, createSingleLessonPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给小明的主课安排王老师于2026-10-20 15:00',
    }, { configurable: { thread_id: 'lesson-preview' } });

    expect(findCourseAccountCandidates).toHaveBeenCalledWith('request-capability', { studentName: '小明', courseName: '主课' });
    expect(findTeacherCandidates).toHaveBeenCalledWith('request-capability', { teacherName: '王老师' });
    expect(createSingleLessonPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({
      accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b',
      startsAt: '2026-10-20T15:00:00+08:00', idempotencyKey: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
    }));
    expect(result.answer).toContain('尚未创建');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({
      type: 'action-preview', actionType: 'lesson.schedule.single', riskLevel: 'L1',
    }));
  });

  it('creates a weekly batch lesson Preview without creating lessons', async () => {
    const findCourseAccountCandidates = vi.fn().mockResolvedValue({
      candidates: [{ accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', studentName: '小明', courseName: '主课' }],
    });
    const findTeacherCandidates = vi.fn().mockResolvedValue({
      candidates: [{ teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b', name: '王老师' }],
    });
    const createBatchLessonPreview = vi.fn().mockResolvedValue({
      previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', actionType: 'lesson.schedule.weekly-batch',
      command: {
        accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b',
        firstStartsAt: '2026-10-20T07:00:00.000Z', weeks: 3, note: null,
      },
      display: {
        title: '每周批量排课', summary: '每周一节，共 3 节',
        lessons: [
          { week: 1, startsAt: '2026-10-20T07:00:00.000Z', endsAt: '2026-10-20T07:45:00.000Z' },
          { week: 2, startsAt: '2026-10-27T07:00:00.000Z', endsAt: '2026-10-27T07:45:00.000Z' },
          { week: 3, startsAt: '2026-11-03T07:00:00.000Z', endsAt: '2026-11-03T07:45:00.000Z' },
        ], conflicts: [],
      },
      resourceVersions: { accountVersion: 1, teacherUpdatedAt: '2026-10-17T01:00:00.000Z' },
      expiresAt: '2026-10-17T01:05:00.000Z', auditEventId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(),
      findCourseAccountCandidates, findTeacherCandidates, createBatchLessonPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给小明的主课安排王老师于2026-10-20 15:00，每周3周',
    }, { configurable: { thread_id: 'lesson-batch-preview' } });

    expect(createBatchLessonPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({
      accountId: '49fbcf47-c616-468a-a058-cdca1ee66025', teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b',
      firstStartsAt: '2026-10-20T15:00:00+08:00', weeks: 3,
      idempotencyKey: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
    }));
    expect(result.answer).toContain('批量排课');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({
      type: 'action-preview', actionType: 'lesson.schedule.weekly-batch', riskLevel: 'L1',
    }));
  });

  it('creates a final-refund Preview after exact student resolution', async () => {
    const findStudentCandidates = vi.fn().mockResolvedValue({
      candidates: [{ studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', name: '小明' }],
    });
    const createFinalRefundPreview = vi.fn().mockResolvedValue({
      previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', actionType: 'student.final-refund',
      command: {
        studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', feeAmount: '10.00', channel: 'WECHAT',
        occurredAt: '2026-10-17T01:00:00.000Z', note: null,
      },
      display: {
        title: '最终退学退款', summary: '共 1 门课程，实际退款 ¥90.00',
        studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', studentName: '小明',
        studentStatusBefore: '在读', studentStatusAfter: '退学', totalPaidRefund: '100.00', feeAmount: '10.00',
        feePercentage: '10.00', actualRefundAmount: '90.00',
        courses: [{ accountId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b', courseName: '主课', paidBalanceBefore: '100.00', giftBalanceBefore: '20.00', paidRefundAmount: '100.00', giftClearingAmount: '20.00' }],
      },
      resourceVersions: { studentUpdatedAt: '2026-10-17T01:00:00.000Z' },
      expiresAt: '2026-10-17T01:05:00.000Z', auditEventId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(),
      findStudentCandidates, createFinalRefundPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给小明办理退学退款，手续费10元，微信',
    }, { configurable: { thread_id: 'refund-preview' } });

    expect(findStudentCandidates).toHaveBeenCalledWith('request-capability', { studentName: '小明' });
    expect(createFinalRefundPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({
      studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', feeAmount: '10.00', channel: 'WECHAT',
      idempotencyKey: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
    }));
    expect(result.answer).toContain('退学退款预览');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({
      type: 'action-preview', actionType: 'student.final-refund', riskLevel: 'L2',
    }));
  });

  it('requires and forwards a note when refund channel is other', async () => {
    const findStudentCandidates = vi.fn().mockResolvedValue({
      candidates: [{ studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', name: '小明' }],
    });
    const createFinalRefundPreview = vi.fn().mockResolvedValue({
      previewId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', actionType: 'student.final-refund',
      command: { studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', feeAmount: '0.00', channel: 'OTHER', occurredAt: '2026-10-17T01:00:00.000Z', note: '线下转账' },
      display: { title: '最终退学退款', summary: '共 0 门课程，实际退款 ¥0.00', studentId: '49fbcf47-c616-468a-a058-cdca1ee66025', studentName: '小明', studentStatusBefore: '在读', studentStatusAfter: '退学', totalPaidRefund: '0.00', feeAmount: '0.00', feePercentage: '0.00', actualRefundAmount: '0.00', courses: [] },
      resourceVersions: {}, expiresAt: '2026-10-17T01:05:00.000Z', auditEventId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c',
    });
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(), findStudentCandidates, createFinalRefundPreview });

    await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage: '给小明办理退学退款，手续费0元，其他，线下转账' }, { configurable: { thread_id: 'refund-other-channel' } });

    expect(createFinalRefundPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({ channel: 'OTHER', note: '线下转账' }));
  });

  it('does not create a refund Preview when other channel has no note', async () => {
    const createFinalRefundPreview = vi.fn();
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(), findStudentCandidates: vi.fn(), createFinalRefundPreview });

    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage: '给小明办理退学退款，手续费0元，其他' }, { configurable: { thread_id: 'refund-other-clarification' } });

    expect(createFinalRefundPreview).not.toHaveBeenCalled();
    expect(result.clarification).toContain('其他');
  });

  it.each([
    ['lesson-reschedule', '把小明周一的课调课到周二下午三点', '调课'],
    ['lesson-cancel', '给小明请假，取消今天的排课', '取消排课'],
    ['lesson-complete', '确认小明今天已经上课', '确认上课'],
    ['manual-transaction', '登记一笔琴行其他经营收入 300 元', '手工收支'],
    ['payroll', '给王老师发工资', '工资操作'],
    ['period-close', '关账 2026-10', '关账或重开账期'],
  ])('explains the missing Core Preview for %s without falling through to reads or writes', async (threadId, userMessage, expectedText) => {
    const fetchDashboardSummary = vi.fn();
    const findCourseAccountCandidates = vi.fn();
    const findStudentCandidates = vi.fn();
    const findTeacherCandidates = vi.fn();
    const createSingleLessonPreview = vi.fn();
    const createBatchLessonPreview = vi.fn();
    const createFinalRefundPreview = vi.fn();
    const createPaymentPreview = vi.fn();
    const createGiftPreview = vi.fn();
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary,
      findCourseAccountCandidates, findStudentCandidates, findTeacherCandidates,
      createSingleLessonPreview, createBatchLessonPreview, createFinalRefundPreview, createPaymentPreview, createGiftPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
      threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage,
    }, { configurable: { thread_id: threadId } });

    expect(result.answer).toContain(expectedText);
    expect(result.answer).toContain('没有 Assistant Preview');
    expect(result.workspace?.title).toBe('需要补充信息');
    for (const operation of [fetchDashboardSummary, findCourseAccountCandidates, findStudentCandidates,
      findTeacherCandidates, createSingleLessonPreview, createBatchLessonPreview, createFinalRefundPreview,
      createPaymentPreview, createGiftPreview]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['reschedule', '把小明的课调到 2026-10-21 15:00', 'lesson.reschedule'],
    ['cancel', '给小明请假，取消排课', 'lesson.cancel'],
    ['complete', '确认小明今天上课', 'lesson.complete'],
    ['reverse-complete', '撤销小明今天的上课确认', 'lesson.complete.reversal'],
    ['manual-income', '登记一笔其他经营收入 300 元，微信', 'manual-transaction.create'],
    ['payroll-generate', '生成王老师 2026-10 工资', 'payroll.generate'],
    ['period-close', '关账 2026-10', 'period.close'],
    ['period-reopen', '重开 2026-10，补录遗漏的收支', 'period.reopen'],
  ])('routes %s to its injected Preview tool and never reads Dashboard', async (_name, userMessage, actionType) => {
    const fetchDashboardSummary = vi.fn();
    const findLessonCandidates = vi.fn().mockResolvedValue({
      candidates: [{ lessonId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', studentName: '小明', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-20T07:00:00.000Z', status: 'SCHEDULED' }],
    });
    const findTeacherCandidates = vi.fn().mockResolvedValue({ candidates: [{ teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b', name: '王老师' }] });
    const createActionPreview = vi.fn().mockResolvedValue({
      previewId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c', actionType,
      command: {}, display: { title: '操作预览', summary: '确认后才会执行。' }, expiresAt: '2026-10-17T01:05:00.000Z',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary,
      findLessonCandidates, findTeacherCandidates, createActionPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage,
    }, { configurable: { thread_id: `structured-action-${_name}` } });

    expect(createActionPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({ actionType }));
    expect(fetchDashboardSummary).not.toHaveBeenCalled();
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType }));
  });

  it('routes a bonus payroll adjustment with a Decimal string and note to Preview only', async () => {
    const findPayrollCandidates = vi.fn().mockResolvedValue({ candidates: [
      { payrollId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', teacherId: '6ed41b4d-cad9-42b3-a3ca-6571ce2e033b', teacherName: '王老师', period: '2026-10', status: 'UNPAID' },
    ] });
    const createActionPreview = vi.fn().mockResolvedValue({
      previewId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c', actionType: 'payroll.adjust',
      command: { payrollId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', bonusAmount: '300.00', bonusNote: '公开课奖励' },
      display: { title: '调整工资奖金或代扣', summary: '王老师 2026-10：奖金 ¥10.00 → ¥300.00' }, expiresAt: '2026-10-17T01:05:00.000Z',
    });
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(),
      findPayrollCandidates, createActionPreview,
    });

    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给王老师 2026-10 工资加奖金 300 元，奖金说明：公开课奖励',
    }, { configurable: { thread_id: 'payroll-adjust-preview' } });

    expect(findPayrollCandidates).toHaveBeenCalledWith('request-capability', { teacherName: '王', period: '2026-10' });
    expect(createActionPreview).toHaveBeenCalledWith('request-capability', expect.objectContaining({
      actionType: 'payroll.adjust',
      command: expect.objectContaining({ payrollId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', bonusAmount: '300.00', bonusNote: '公开课奖励' }),
    }));
    expect(result.answer).toContain('尚未执行');
    expect(result.workspace?.blocks).toContainEqual(expect.objectContaining({ type: 'action-preview', actionType: 'payroll.adjust' }));
  });

  it('requires a note for a positive deduction adjustment before querying payroll records', async () => {
    const findPayrollCandidates = vi.fn();
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn(), findPayrollCandidates, createActionPreview: vi.fn() });
    const result = await graph.invoke({
      runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
      userMessage: '给王老师 2026-10 工资代扣 30 元',
    }, { configurable: { thread_id: 'payroll-adjust-missing-note' } });
    expect(result.answer).toContain('说明');
    expect(findPayrollCandidates).not.toHaveBeenCalled();
  });

  it('clarifies structured actions when the lesson object is not unique and never creates a Preview or reads Dashboard', async () => {
    const fetchDashboardSummary = vi.fn();
    const findLessonCandidates = vi.fn().mockResolvedValue({ candidates: [
      { lessonId: 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90', studentName: '小明', courseName: '主课', teacherName: '王老师', startsAt: '2026-10-20T07:00:00.000Z', status: 'SCHEDULED' },
      { lessonId: 'f77d8168-5d57-4e81-9c32-11e22e42b81c', studentName: '小明', courseName: '陪练', teacherName: '李老师', startsAt: '2026-10-20T08:00:00.000Z', status: 'SCHEDULED' },
    ] });
    const createActionPreview = vi.fn();
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary, findLessonCandidates, createActionPreview });

    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage: '给小明请假，取消排课' }, { configurable: { thread_id: 'structured-action-ambiguous' } });

    expect(result.answer).toContain('唯一');
    expect(createActionPreview).not.toHaveBeenCalled();
    expect(fetchDashboardSummary).not.toHaveBeenCalled();
  });

  it('reads the dashboard using the injected capability and answers without interrupting', async () => {
    const fetchDashboardSummary = vi.fn().mockResolvedValue(summary);
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(),
      capability: 'request-capability',
      fetchDashboardSummary,
    });

    const result = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '今天经营情况怎么样？',
      },
      { configurable: { thread_id: 'read-only-query' } },
    );

    expect(fetchDashboardSummary).toHaveBeenCalledWith('request-capability');
    expect(result.answer).toContain('2026-10-17');
    expect(result.answer).toContain('今日排课 4 节');
    expect(result.workspace).toMatchObject({
      protocolVersion: '1.0',
      blocks: [
        { type: 'summary', text: '业务日期：2026-10-17' },
        { type: 'summary', title: '经营要点', text: '今日排课 4 节\n本月经营收入 1200.00 元' },
      ],
      sources: [],
    });
    expect(result.__interrupt__).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('request-capability');
  });

  it('shows a general operating overview without numbered placeholder labels', async () => {
    const graph = createBusinessQueryGraph({ checkpointer: new MemorySaver(), capability: 'request-capability', fetchDashboardSummary: vi.fn().mockResolvedValue(detailedSummary) });
    const result = await graph.invoke({ runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage: '今天经营情况怎么样' }, { configurable: { thread_id: 'overview-without-placeholder-labels' } });
    expect(result.workspace?.title).toBe('经营摘要 · 2026-10-17');
    expect(JSON.stringify(result.workspace)).not.toMatch(/摘要 [1-9]/u);
    expect(JSON.stringify(result.workspace)).toContain('冻结学生 2 人');
  });

  it('treats 查看今日排课 as a read-only schedule query instead of an incomplete lesson command', async () => {
    const fetchDashboardSummary = vi.fn().mockResolvedValue(detailedSummary);
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(),
      capability: 'request-capability',
      fetchDashboardSummary,
    });

    const result = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '查看今日排课',
      },
      { configurable: { thread_id: 'read-only-schedule-query' } },
    );

    expect(fetchDashboardSummary).toHaveBeenCalledWith('request-capability');
    expect(result.clarification).toBeUndefined();
    expect(result.workspace?.title).toBe('今日排课 · 2026-10-17');
  });

  it('asks the model to summarize only the fetched read-only summary', async () => {
    const model = { invoke: vi.fn().mockResolvedValue(new AIMessage('今天安排了 4 节课。')) };
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(),
      capability: 'request-capability',
      fetchDashboardSummary: vi.fn().mockResolvedValue(summary),
      model: model as never,
    });

    const result = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '今天经营情况怎么样？',
      },
      { configurable: { thread_id: 'model-read-only-query' } },
    );

    expect(result.answer).toBe('今天安排了 4 节课。');
    expect(model.invoke).toHaveBeenCalledTimes(1);
    const messages = model.invoke.mock.calls[0]?.[0] as [unknown, HumanMessage];
    expect(JSON.parse(String(messages[1].content))).toEqual({
      question: '今天经营情况怎么样？',
      readOnlySummary: summary,
    });
    expect(JSON.stringify(messages)).toContain('只读');
    expect(JSON.stringify(messages)).toContain('禁止声称');
  });

  it('replaces a model claim that it performed a business operation', async () => {
    const model = { invoke: vi.fn().mockResolvedValue(new AIMessage('已经为你安排了课程。')) };
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(),
      capability: 'request-capability',
      fetchDashboardSummary: vi.fn().mockResolvedValue(summary),
      model: model as never,
    });

    const result = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '帮我安排一节课',
      },
      { configurable: { thread_id: 'model-operation-claim' } },
    );

    expect(result.answer).toContain('安排老师');
  });

  it('uses the deterministic read-only answer when the model fails', async () => {
    const model = { invoke: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
    const graph = createBusinessQueryGraph({
      checkpointer: new MemorySaver(),
      capability: 'request-capability',
      fetchDashboardSummary: vi.fn().mockResolvedValue(summary),
      model: model as never,
    });

    const result = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '今天经营情况怎么样？',
      },
      { configurable: { thread_id: 'model-failure-fallback' } },
    );

    expect(result.answer).toBe('经营摘要（2026-10-17）：今日排课 4 节；本月经营收入 1200.00 元');
    expect(result.workspace?.blocks).toHaveLength(2);
  });
});
