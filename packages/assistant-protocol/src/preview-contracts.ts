import { z } from 'zod';

/**
 * 预览确认单的统一结构。
 *
 * 这里是唯一来源：Core 用它约束返回、并导出接口定义；Agent 用它校验响应。
 * 两端不再各写一份，避免「一边加字段、另一边把合法确认单当成非法」。
 *
 * 校验宽严的原则：
 * - 识别业务所必需的字段（单号、类型、金额、对象、有效期）必须存在且类型正确；
 * - 纯展示字段允许增加，`.loose()` 让新增展示项不会中断用户办理；
 * - 用户输入侧（请求）仍保持严格，多传字段照旧拒绝。
 */

const MoneySchema = z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/u);
const PositiveMoneySchema = z.string().regex(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,11}\.\d{2})$/u);
const PaymentChannelSchema = z.enum(['CASH', 'WECHAT', 'ALIPAY', 'BANK_CARD', 'OTHER']);
/** 预览只有 L1/L2 两档风险；L0 是只读，不产生确认单。 */
const PreviewRiskLevelSchema = z.enum(['L1', 'L2']);

/** 账户余额快照；首次缴费时尚无账户，accountId 允许为空。 */
export const PreviewBalanceSchema = z
  .object({
    accountId: z.uuid().optional(),
    paidBalance: MoneySchema,
    giftBalance: MoneySchema,
    totalBalance: MoneySchema,
  })
  .loose();

const PreviewBase = {
  previewId: z.uuid(),
  riskLevel: PreviewRiskLevelSchema.optional(),
  expiresAt: z.iso.datetime(),
  /** 审计标识用于追溯，不参与用户办理，允许单独缺失。 */
  auditEventId: z.uuid().optional(),
};

/** 单节排课确认单。结束时间由 Core 按课程时长计算，用户从不填写。 */
export const SingleLessonPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('lesson.schedule.single'),
    command: z
      .object({
        accountId: z.uuid(),
        teacherId: z.uuid(),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
        note: z.string().nullable().optional(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        studentName: z.string(),
        courseName: z.string(),
        teacherName: z.string(),
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
      })
      .loose(),
    resourceVersions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** 按周批量排课确认单。 */
export const BatchLessonPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('lesson.schedule.weekly-batch'),
    command: z
      .object({
        accountId: z.uuid(),
        teacherId: z.uuid(),
        firstStartsAt: z.iso.datetime(),
        weeks: z.number().int().min(1).max(52),
        note: z.string().nullable(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        lessons: z.array(
          z
            .object({
              week: z.number().int().min(1),
              startsAt: z.iso.datetime(),
              endsAt: z.iso.datetime(),
            })
            .loose(),
        ),
        conflicts: z.array(z.record(z.string(), z.string())),
      })
      .loose(),
    resourceVersions: z.record(z.string(), z.unknown()),
  })
  .loose();

/** 首次缴费：账户在确认时才按需建立，因此命令里带学生与课程。 */
const CombinedPaymentPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('course-account.payment'),
    command: z
      .object({
        studentId: z.uuid(),
        courseId: z.uuid(),
        amount: PositiveMoneySchema,
        channel: PaymentChannelSchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
        currentUnitPrice: PositiveMoneySchema,
        priceExplicit: z.boolean(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        studentName: z.string(),
        courseName: z.string(),
        amount: PositiveMoneySchema,
        channel: PaymentChannelSchema,
        priceBefore: PositiveMoneySchema.nullable(),
        priceAfter: PositiveMoneySchema,
        beforeBalance: PreviewBalanceSchema,
        afterBalance: PreviewBalanceSchema,
      })
      .loose(),
  })
  .loose();

/** 已有账户的缴费：命令以账户为入口。 */
const LegacyPaymentPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('course-account.payment'),
    command: z
      .object({
        accountId: z.uuid(),
        amount: PositiveMoneySchema,
        channel: PaymentChannelSchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        currentUnitPrice: PositiveMoneySchema.optional(),
        studentName: z.string().optional(),
        courseName: z.string().optional(),
        beforeBalance: PreviewBalanceSchema,
        afterBalance: PreviewBalanceSchema,
      })
      .loose(),
  })
  .loose();

export const PaymentPreviewResponseSchema = z.union([
  CombinedPaymentPreviewResponseSchema,
  LegacyPaymentPreviewResponseSchema,
]);

/** 赠送确认单：只增加赠送余额，不涉及收款渠道。 */
export const GiftPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('course-account.gift'),
    command: z
      .object({
        accountId: z.uuid(),
        amount: PositiveMoneySchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        beforeBalance: PreviewBalanceSchema,
        afterBalance: PreviewBalanceSchema,
      })
      .loose(),
  })
  .loose();

/** 最终退学退款确认单。 */
export const FinalRefundPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.literal('student.final-refund'),
    command: z
      .object({
        studentId: z.uuid(),
        feeAmount: MoneySchema,
        channel: PaymentChannelSchema,
        occurredAt: z.iso.datetime(),
        note: z.string().nullable(),
      })
      .loose(),
    display: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        studentId: z.uuid(),
        studentName: z.string().min(1),
        studentStatusBefore: z.string().min(1),
        studentStatusAfter: z.string().min(1),
        totalPaidRefund: MoneySchema,
        feeAmount: MoneySchema,
        feePercentage: MoneySchema,
        actualRefundAmount: MoneySchema,
        courses: z.array(
          z
            .object({
              accountId: z.uuid(),
              courseName: z.string().min(1),
              paidBalanceBefore: MoneySchema,
              giftBalanceBefore: MoneySchema,
              paidRefundAmount: MoneySchema,
              giftClearingAmount: MoneySchema,
            })
            .loose(),
        ),
      })
      .loose(),
    resourceVersions: z.record(z.string(), z.unknown()),
  })
  .loose();

/**
 * 结构化操作确认单：调课、取消、确认上课、工资、收支、关账等共用外层。
 * 内部命令按业务不同，保留为键值对；展示字段允许增加。
 */
export const StructuredActionPreviewResponseSchema = z
  .object({
    ...PreviewBase,
    actionType: z.string().min(1),
    command: z.record(z.string(), z.unknown()),
    display: z
      .object({
        title: z.string().min(1).optional(),
        summary: z.string().min(1).optional(),
      })
      .loose(),
    resourceVersions: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** 确认后返回的回执。 */
export const PreviewReceiptSchema = z
  .object({
    previewId: z.uuid(),
    status: z.string().min(1),
    actionType: z.string().min(1).optional(),
    auditEventId: z.uuid().optional(),
    executedAt: z.iso.datetime().optional(),
    receipt: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .loose();

export type SingleLessonPreviewResponse = z.infer<typeof SingleLessonPreviewResponseSchema>;
export type BatchLessonPreviewResponse = z.infer<typeof BatchLessonPreviewResponseSchema>;
export type PaymentPreviewResponse = z.infer<typeof PaymentPreviewResponseSchema>;
export type GiftPreviewResponse = z.infer<typeof GiftPreviewResponseSchema>;
export type FinalRefundPreviewResponse = z.infer<typeof FinalRefundPreviewResponseSchema>;
export type StructuredActionPreviewResponse = z.infer<typeof StructuredActionPreviewResponseSchema>;
export type PreviewReceipt = z.infer<typeof PreviewReceiptSchema>;

/** 预览失效结果。 */
export const PreviewInvalidationSchema = z
  .object({
    previewId: z.uuid(),
    status: z.string().min(1),
  })
  .loose();

export type PreviewInvalidation = z.infer<typeof PreviewInvalidationSchema>;
