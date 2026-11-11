import { describe, expect, it } from 'vitest';
import {
  BatchLessonPreviewResponseSchema,
  PaymentPreviewResponseSchema,
  SingleLessonPreviewResponseSchema,
} from '../src/index.js';

const previewId = 'd301e0d7-c44a-463d-b124-8fbdf2ac0d90';
const createdAt = '2026-11-02T01:05:00.000Z';

const singleLesson = {
  previewId,
  actionType: 'lesson.schedule.single' as const,
  riskLevel: 'L1' as const,
  command: {
    accountId: '49fbcf47-c616-468a-a058-cdca1ee66025',
    teacherId: '71726279-43f1-4fe6-9aa1-b12988812b5d',
    startsAt: '2026-11-02T01:00:00.000Z',
    endsAt: '2026-11-02T01:45:00.000Z',
  },
  display: {
    title: '单节排课',
    summary: '小明 · 主课 · 周老师，请核对上课时间。',
    studentName: '小明',
    courseName: '主课',
    teacherName: '周老师',
    startsAt: '2026-11-02T01:00:00.000Z',
    endsAt: '2026-11-02T01:45:00.000Z',
  },
  expiresAt: createdAt,
};

describe('单节排课确认单的结构约定', () => {
  it('接受 Core 实际返回的完整结构', () => {
    expect(SingleLessonPreviewResponseSchema.safeParse(singleLesson).success).toBe(true);
  });

  it('Core 新增展示字段时不打断用户办理', () => {
    const widened = {
      ...singleLesson,
      display: { ...singleLesson.display, teacherNote: '本周临时调整教室', classroom: '302' },
      extraTopLevel: 'core-forward-compatible',
    };
    expect(SingleLessonPreviewResponseSchema.safeParse(widened).success).toBe(true);
  });

  it('缺少确认单号时必须拒绝，不能给出无法确认的界面', () => {
    const { previewId: _dropped, ...rest } = singleLesson;
    expect(SingleLessonPreviewResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('确认单缺少结束时间必须拒绝：结束时间由 Core 计算，不能缺失或以空值展示', () => {
    const { endsAt: _dropped, ...display } = singleLesson.display;
    expect(
      SingleLessonPreviewResponseSchema.safeParse({ ...singleLesson, display }).success,
    ).toBe(false);
  });

  it('订单类型必须是排课单，不能把其他业务单当成排课确认', () => {
    expect(
      SingleLessonPreviewResponseSchema.safeParse({ ...singleLesson, actionType: 'student.final-refund' })
        .success,
    ).toBe(false);
  });
});

describe('批量排课与缴费确认单', () => {
  it('批量排课接受每周明细与冲突列表', () => {
    const batch = {
      previewId,
      actionType: 'lesson.schedule.weekly-batch' as const,
      riskLevel: 'L1' as const,
      command: {
        accountId: singleLesson.command.accountId,
        teacherId: singleLesson.command.teacherId,
        firstStartsAt: '2026-11-02T01:00:00.000Z',
        weeks: 4,
        note: null,
      },
      display: {
        title: '每周批量排课',
        summary: '每周一节，共 4 节',
        lessons: [{ week: 1, startsAt: '2026-11-02T01:00:00.000Z', endsAt: '2026-11-02T01:45:00.000Z' }],
        conflicts: [],
      },
      resourceVersions: {},
      expiresAt: createdAt,
    };
    expect(BatchLessonPreviewResponseSchema.safeParse(batch).success).toBe(true);
  });

  it('首次缴费在没有账户时也能通过：余额快照不要求账户编号', () => {
    const payment = {
      previewId,
      actionType: 'course-account.payment' as const,
      riskLevel: 'L2' as const,
      command: {
        studentId: '71726279-43f1-4fe6-9aa1-b12988812b5d',
        courseId: '49fbcf47-c616-468a-a058-cdca1ee66025',
        amount: '2000.00',
        channel: 'WECHAT' as const,
        occurredAt: '2026-11-02T01:00:00.000Z',
        note: null,
        currentUnitPrice: '180.00',
        priceExplicit: true,
      },
      display: {
        title: '课程交费',
        summary: '交费 ¥2000.00',
        studentName: '小明',
        courseName: '主课',
        amount: '2000.00',
        channel: 'WECHAT' as const,
        priceBefore: null,
        priceAfter: '180.00',
        beforeBalance: { paidBalance: '0.00', giftBalance: '0.00', totalBalance: '0.00' },
        afterBalance: { paidBalance: '2000.00', giftBalance: '0.00', totalBalance: '2000.00' },
      },
      expiresAt: createdAt,
    };
    expect(PaymentPreviewResponseSchema.safeParse(payment).success).toBe(true);
  });
});
