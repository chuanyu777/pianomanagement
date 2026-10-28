import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ManualExpenseCategory,
  ManualIncomeCategory,
  ManualTransactionKind,
  PayrollStatus,
  PreviewRiskLevel,
  PreviewStatus,
  PaymentChannel,
  type ActionPreview,
  type BusinessAuditEvent,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { LessonsService, type CreateBatchLessonsInput, type CreateSingleLessonInput } from '../lessons/lessons.service.js';
import { CourseLedgerService, type CourseAccountBalance } from '../course-ledger/course-ledger.service.js';
import { RefundsService, type CreateRefundInput } from '../refunds/refunds.service.js';
import type { LessonConsumptionCorrectionVersions, LessonMutationVersions } from '../lessons/lessons.service.js';
import { ManualTransactionsService, type CreateManualTransactionInput } from '../manual-transactions/manual-transactions.service.js';
import { PayrollService } from '../payroll/payroll.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { businessMonthStart, parseBusinessMonth } from '../../common/time/business-calendar.js';
import { StudentsService } from '../students/students.service.js';
import { CoursesService, type UpdateCourseInput } from '../courses/courses.service.js';
import { StudentCourseAccountsService, type CreateStudentCourseAccountInput, type UpdateStudentCourseAccountPriceInput } from '../student-course-accounts/student-course-accounts.service.js';
import { TeachersService } from '../teachers/teachers.service.js';

const TECHNICAL_SPIKE_ACTION_TYPE = 'technical-spike.preview';
const TECHNICAL_SPIKE_SCHEMA_VERSION = 'stage0.v1';
const TECHNICAL_SPIKE_TTL_MS = 5 * 60 * 1000;
const TECHNICAL_SPIKE_EVENT_TYPE = 'assistant.preview.created';

const TECHNICAL_SPIKE_COMMAND = {
  kind: 'technical-spike',
  mode: 'preview-only',
  businessWrite: false,
} satisfies Prisma.InputJsonObject;

const TECHNICAL_SPIKE_DISPLAY = {
  title: '阶段 0 技术预览',
  summary: '仅验证 Preview 持久化、审计和幂等，不会写入任何业务数据。',
  technicalSpike: true,
  businessWrite: false,
} satisfies Prisma.InputJsonObject;

const TECHNICAL_SPIKE_RESOURCES = {
  kind: 'technical-spike',
  resources: [],
} satisfies Prisma.InputJsonObject;

export type CreateTechnicalPreviewInput = {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
  now?: Date;
};

export type TechnicalPreviewResponse = {
  preview: {
    id: string;
    actorUserId: string;
    actionType: string;
    schemaVersion: string;
    riskLevel: PreviewRiskLevel;
    normalizedCommandJson: Prisma.JsonValue;
    displayJson: Prisma.JsonValue;
    resourceVersionsJson: Prisma.JsonValue;
    idempotencyKey: string;
    status: PreviewStatus;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  auditEventId: string;
  technicalSpike: true;
  businessWrite: false;
};

type FinalRefundPreviewInput = Omit<CreateRefundInput, 'commandId'> & {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
};

type LessonMutationAction = 'lesson.reschedule' | 'lesson.cancel' | 'lesson.complete' | 'lesson.complete.reversal' | 'lesson.complete.correction';
type LessonMutationPreviewInput = {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
  lessonId: string;
  startsAt?: Date;
  correctedUnitPrice?: Prisma.Decimal;
  note?: string | undefined;
};

type StructuredBusinessAction =
  | 'manual-transaction.create'
  | 'payroll.generate'
  | 'payroll.pay'
  | 'payroll.adjust'
  | 'payroll.cancel-payment'
  | 'ledger-entry.reversal'
  | 'period.close'
  | 'period.reopen';
type BasicDataAction = 'student.create' | 'student.update' | 'teacher.create' | 'teacher.compensation.update' | 'course.create' | 'course.update' | 'course-account.open' | 'course-account.price';
type StructuredAction = LessonMutationAction | StructuredBusinessAction | BasicDataAction;
type StructuredActionPreviewInput = {
  actorUserId: string;
  runId: string;
  requestId: string;
  idempotencyKey: string;
  actionType: StructuredAction;
  command: Record<string, unknown>;
};

type CreatedPreview = {
  preview: ActionPreview;
  auditEvent: BusinessAuditEvent;
};

const OWNER_ONLY_PREVIEW_ACTIONS = new Set([
  'course-account.payment',
  'course-account.gift',
  'student.final-refund',
  'manual-transaction.create',
  'payroll.generate',
  'payroll.pay',
  'payroll.adjust',
  'payroll.cancel-payment',
  'ledger-entry.reversal',
  'period.close',
  'period.reopen',
  'lesson.complete.correction',
  'student.create', 'student.update', 'teacher.create', 'teacher.compensation.update', 'course.create', 'course.update', 'course-account.open', 'course-account.price',
]);

const LESSON_MUTATION_ACTIONS = new Set<LessonMutationAction>([
  'lesson.reschedule',
  'lesson.cancel',
  'lesson.complete',
  'lesson.complete.reversal',
  'lesson.complete.correction',
]);

const TEACHER_COMPLETION_DISPLAY_FIELDS = [
  'title',
  'lessonId',
  'studentName',
  'courseName',
  'teacherId',
  'startsAt',
  'endsAt',
  'statusBefore',
  'statusAfter',
  'note',
] as const;

const TEACHER_COMPLETION_RESOURCE_VERSION_FIELDS = [
  'lessonId',
  'lessonVersion',
  'accountId',
  'accountVersion',
  'consumptionEntryId',
] as const;

const TEACHER_COMPLETION_RECEIPT_FIELDS = [
  'actionType',
  'lessonId',
  'status',
  'startsAt',
  'endsAt',
  'completedAt',
  'idempotencyKey',
  'executedAt',
] as const;

function projectScalarFields(value: unknown, allowedFields: readonly string[]): Prisma.InputJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of allowedFields) {
    const candidate = source[field];
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      projected[field] = candidate;
    }
  }
  return projected as Prisma.InputJsonObject;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  ) ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002');
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BadRequestException(`${field} 不能为空`);
  return normalized;
}

function commandText(command: Record<string, unknown>, field: string): string {
  const value = command[field];
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} 必须是非空字符串`);
  return value.trim();
}

function commandAmount(command: Record<string, unknown>, field: string): Prisma.Decimal {
  const value = commandText(command, field);
  if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} 必须是两位小数字符串`);
  }
  const amount = new Prisma.Decimal(value);
  if (!amount.isFinite() || !amount.gt(0)) throw new BadRequestException(`${field} 必须大于零`);
  return amount;
}

function optionalText(command: Record<string, unknown>, field: string): string | null | undefined {
  const value = command[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串`);
  return value.trim() || null;
}

function commandInteger(command: Record<string, unknown>, field: string): number {
  const value = command[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 480) throw new BadRequestException(`${field} 必须是 1 至 480 的整数`);
  return value;
}

function commandNonNegativeInteger(command: Record<string, unknown>, field: string): number {
  const value = command[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new BadRequestException(`${field} 必须是非负整数`);
  return value;
}

function commandBoolean(command: Record<string, unknown>, field: string): boolean {
  const value = command[field];
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} 必须是布尔值`);
  return value;
}

function commandNonNegativeAmount(command: Record<string, unknown>, field: string): Prisma.Decimal {
  const value = commandText(command, field);
  if (!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} 必须是两位小数字符串`);
  }
  const amount = new Prisma.Decimal(value);
  if (!amount.isFinite() || amount.lt(0)) throw new BadRequestException(`${field} 不能为负数`);
  return amount;
}

function commandDecimal(command: Record<string, unknown>, field: string, scale: number): Prisma.Decimal {
  const value = commandText(command, field);
  const fraction = scale === 0 ? '' : `(?:\\.\\d{1,${scale}})?`;
  if (!new RegExp(`^(?:0|[1-9]\\d{0,11})${fraction}$`).test(value)) {
    throw new BadRequestException(`${field} 最多保留 ${scale} 位小数`);
  }
  const amount = new Prisma.Decimal(value);
  if (!amount.isFinite() || amount.isNegative()) throw new BadRequestException(`${field} 不能为负数`);
  return amount;
}

function commandDateTime(command: Record<string, unknown>, field: string): Date {
  const value = commandText(command, field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !value.includes('T')) throw new BadRequestException(`${field} 必须是带时区的日期时间字符串`);
  return date;
}

function commandBusinessMonth(command: Record<string, unknown>, field = 'period'): { value: string; date: Date } {
  const value = commandText(command, field);
  const date = parseBusinessMonth(value);
  if (!date) throw new BadRequestException(`${field} 必须是 YYYY-MM 字符串`);
  return { value, date };
}

function enumText<T extends string>(command: Record<string, unknown>, field: string, values: readonly T[]): T {
  const value = commandText(command, field);
  if (!values.includes(value as T)) throw new BadRequestException(`${field} 取值不合法`);
  return value as T;
}

const MANUAL_KIND_TEXT: Record<string, ManualTransactionKind> = {
  '收入': ManualTransactionKind.INCOME,
  '支出': ManualTransactionKind.EXPENSE,
};
const MANUAL_INCOME_CATEGORY_TEXT: Record<string, ManualIncomeCategory> = {
  '书籍销售': ManualIncomeCategory.BOOK_SALE,
  '卖书': ManualIncomeCategory.BOOK_SALE,
  '钢琴/乐器销售': ManualIncomeCategory.INSTRUMENT_SALE,
  '钢琴销售': ManualIncomeCategory.INSTRUMENT_SALE,
  '乐器销售': ManualIncomeCategory.INSTRUMENT_SALE,
  '卖琴': ManualIncomeCategory.INSTRUMENT_SALE,
  '外部合作收入': ManualIncomeCategory.EXTERNAL_COOPERATION,
  '外部合作': ManualIncomeCategory.EXTERNAL_COOPERATION,
  '其他收入': ManualIncomeCategory.OTHER_INCOME,
  '其他经营收入': ManualIncomeCategory.OTHER_INCOME,
};
const MANUAL_EXPENSE_CATEGORY_TEXT: Record<string, ManualExpenseCategory> = {
  '房租物业': ManualExpenseCategory.RENT_PROPERTY,
  '房租': ManualExpenseCategory.RENT_PROPERTY,
  '水电网络': ManualExpenseCategory.UTILITIES_NETWORK,
  '市场推广': ManualExpenseCategory.MARKETING,
  '推广': ManualExpenseCategory.MARKETING,
  '办公耗材': ManualExpenseCategory.OFFICE_SUPPLIES,
  '办公用品': ManualExpenseCategory.OFFICE_SUPPLIES,
  '维修维护': ManualExpenseCategory.MAINTENANCE,
  '维修': ManualExpenseCategory.MAINTENANCE,
  '书籍采购成本': ManualExpenseCategory.BOOK_PURCHASE_COST,
  '购书成本': ManualExpenseCategory.BOOK_PURCHASE_COST,
  '钢琴/乐器采购成本': ManualExpenseCategory.INSTRUMENT_PURCHASE_COST,
  '购琴成本': ManualExpenseCategory.INSTRUMENT_PURCHASE_COST,
  '外部合作成本': ManualExpenseCategory.EXTERNAL_COOPERATION_COST,
  '其他支出': ManualExpenseCategory.OTHER_EXPENSE,
  '其他经营支出': ManualExpenseCategory.OTHER_EXPENSE,
};

function manualKind(command: Record<string, unknown>): ManualTransactionKind {
  const value = commandText(command, 'kind');
  return MANUAL_KIND_TEXT[value] ?? enumText(command, 'kind', Object.values(ManualTransactionKind));
}

function manualIncomeCategory(command: Record<string, unknown>): ManualIncomeCategory | undefined {
  const raw = command.incomeCategory ?? command.category;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException('incomeCategory 取值不合法');
  const value = raw.trim();
  if (MANUAL_INCOME_CATEGORY_TEXT[value]) return MANUAL_INCOME_CATEGORY_TEXT[value];
  if (!Object.values(ManualIncomeCategory).includes(value as ManualIncomeCategory)) throw new BadRequestException('incomeCategory 取值不合法');
  return value as ManualIncomeCategory;
}

function manualExpenseCategory(command: Record<string, unknown>): ManualExpenseCategory | undefined {
  const raw = command.expenseCategory ?? command.category;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException('expenseCategory 取值不合法');
  const value = raw.trim();
  if (MANUAL_EXPENSE_CATEGORY_TEXT[value]) return MANUAL_EXPENSE_CATEGORY_TEXT[value];
  if (!Object.values(ManualExpenseCategory).includes(value as ManualExpenseCategory)) throw new BadRequestException('expenseCategory 取值不合法');
  return value as ManualExpenseCategory;
}

function toDisplayBalance(balance: CourseAccountBalance): CourseAccountBalance {
  return {
    accountId: balance.accountId,
    paidBalance: balance.paidBalance,
    giftBalance: balance.giftBalance,
    totalBalance: balance.totalBalance,
  };
}

@Injectable()
export class AssistantActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lessons: LessonsService,
    private readonly ledger: CourseLedgerService,
    private readonly refunds?: RefundsService,
    private readonly manualTransactions?: ManualTransactionsService,
    private readonly payroll?: PayrollService,
    private readonly periods?: PeriodsService,
    private readonly students?: StudentsService,
    private readonly courses?: CoursesService,
    private readonly studentCourseAccounts?: StudentCourseAccountsService,
    private readonly teachers?: TeachersService,
  ) {}

  // Coarse eligibility only. Each read/Preview/Confirm still rechecks current
  // role, resource ownership, versions and business state in its domain service.
  async checkActionAccess(actorUserId: string, actionType: string): Promise<{ allowed: true }> {
    const ownerOnly = OWNER_ONLY_PREVIEW_ACTIONS.has(actionType)
      || ['course-account.read', 'lesson.schedule.weekly-batch', 'lesson.complete.reversal'].includes(actionType);
    const scopedTeaching = LESSON_MUTATION_ACTIONS.has(actionType as LessonMutationAction)
      || actionType === 'lesson.schedule.single';
    if (!ownerOnly && !scopedTeaching) throw new BadRequestException('不支持的业务操作');
    const actor = await this.loadActor(actorUserId);
    if (ownerOnly && actor.role !== 'OWNER') throw new ForbiddenException('当前账号无权执行此操作');
    return { allowed: true };
  }

  async previewFinalRefund(input: FinalRefundPreviewInput) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可预览退学退款');
    const feeAmount = this.parseRefundFee(input.feeAmount);
    if (!Number.isFinite(input.occurredAt.getTime())) throw new BadRequestException('退费时间无效');
    if (this.periods) await this.periods.assertWritableForDate(input.occurredAt);
    const actionType = 'student.final-refund';
    const normalizedCommand = {
      studentId: input.studentId,
      feeAmount: feeAmount.toFixed(2),
      channel: input.channel,
      occurredAt: input.occurredAt.toISOString(),
      note: input.note?.trim() || null,
    } satisfies Prisma.InputJsonObject;

    const calculated = await this.calculateFinalRefund(input.studentId, feeAmount);
    const display = {
      title: '最终退学退款',
      summary: `共 ${calculated.courses.length} 门课程，实际退款 ¥${calculated.actualRefundAmount}`,
      studentId: input.studentId,
      studentName: calculated.studentName,
      studentStatusBefore: calculated.studentStatusBefore,
      studentStatusAfter: '退学',
      courses: calculated.courses,
      totalPaidRefund: calculated.totalPaidRefund,
      feeAmount: calculated.feeAmount,
      feePercentage: calculated.feePercentage,
      actualRefundAmount: calculated.actualRefundAmount,
    } satisfies Prisma.InputJsonObject;
    const resourceVersions = {
      studentId: input.studentId,
      studentUpdatedAt: calculated.studentUpdatedAt.toISOString(),
      accountVersions: calculated.accountVersions,
    } satisfies Prisma.InputJsonObject;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L2,
          normalizedCommandJson: normalizedCommand,
          displayJson: display,
          resourceVersionsJson: resourceVersions,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId,
          resourceType: 'student', resourceId: input.studentId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1` },
        } });
        return { preview, audit };
      });
      return {
        previewId: created.preview.id,
        actionType: created.preview.actionType,
        riskLevel: created.preview.riskLevel,
        command: created.preview.normalizedCommandJson,
        display: created.preview.displayJson,
        resourceVersions: created.preview.resourceVersionsJson,
        expiresAt: created.preview.expiresAt.toISOString(),
        auditEventId: created.audit.id,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      if (JSON.stringify(prior.normalizedCommandJson) !== JSON.stringify(normalizedCommand)) {
        throw new ConflictException('幂等键已用于不同的最终退学退款请求');
      }
      const audit = await this.prisma.businessAuditEvent.findFirst({
        where: { previewId: prior.id, eventType: 'assistant.preview.created' },
        orderBy: { createdAt: 'asc' }, select: { id: true },
      });
      if (!audit) throw new ConflictException('幂等预览审计记录不存在');
      return {
        previewId: prior.id, actionType: prior.actionType, riskLevel: prior.riskLevel,
        command: prior.normalizedCommandJson, display: prior.displayJson,
        resourceVersions: prior.resourceVersionsJson,
        expiresAt: prior.expiresAt.toISOString(), auditEventId: audit.id,
      };
    }
  }

  private parseRefundFee(feeAmount: Prisma.Decimal | string): Prisma.Decimal {
    try {
      const parsed = new Prisma.Decimal(feeAmount);
      if (!parsed.isFinite() || parsed.isNegative() || parsed.decimalPlaces() > 2 || parsed.gt('999999999999.99')) {
        throw new BadRequestException('手续费金额无效');
      }
      return parsed;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('手续费金额无效');
    }
  }

  private async calculateFinalRefund(studentId: string, feeAmount: Prisma.Decimal) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, withdrawnAt: true, updatedAt: true },
    });
    if (!student) throw new NotFoundException('学生不存在');
    const existingRefund = await this.prisma.refundRecord.findUnique({ where: { studentId }, select: { id: true } });
    if (existingRefund) throw new ConflictException('该学生已登记退费');
    const accounts = await this.prisma.studentCourseAccount.findMany({
      where: { studentId }, orderBy: { id: 'asc' },
      select: { id: true, version: true, openingPaidBalance: true, openingGiftBalance: true, course: { select: { name: true } } },
    });
    const accountIds = accounts.map(({ id }) => id);
    const entries = accountIds.length === 0 ? [] : await this.prisma.ledgerEntry.findMany({
      where: { accountId: { in: accountIds } }, select: { accountId: true, paidDelta: true, giftDelta: true },
    });
    const balances = new Map(accounts.map((account) => [account.id, {
      paid: new Prisma.Decimal(account.openingPaidBalance), gift: new Prisma.Decimal(account.openingGiftBalance),
    }]));
    for (const entry of entries) {
      const balance = balances.get(entry.accountId);
      if (balance) {
        balance.paid = balance.paid.add(entry.paidDelta);
        balance.gift = balance.gift.add(entry.giftDelta);
      }
    }
    const zero = new Prisma.Decimal(0);
    const courses = accounts.map((account) => {
      const balance = balances.get(account.id)!;
      if (balance.paid.isNegative()) throw new BadRequestException(`课程账户 ${account.id} 的实收余额为负数，不能办理退费`);
      return {
        accountId: account.id,
        courseName: account.course.name,
        paidBalanceBefore: balance.paid.toFixed(2),
        giftBalanceBefore: balance.gift.toFixed(2),
        paidRefundAmount: (balance.paid.gt(0) ? balance.paid : zero).toFixed(2),
        giftClearingAmount: (balance.gift.gt(0) ? balance.gift : zero).toFixed(2),
      };
    });
    const totalPaidRefund = courses.reduce((sum, course) => sum.add(course.paidRefundAmount), zero);
    if (feeAmount.gt(totalPaidRefund)) throw new BadRequestException('手续费不能大于实收退费总额');
    const feePercentage = totalPaidRefund.isZero() ? zero : feeAmount.div(totalPaidRefund).mul(100).toDecimalPlaces(2);
    return {
      studentName: student.name,
      studentStatusBefore: student.withdrawnAt ? '退学' : '在读',
      studentUpdatedAt: student.updatedAt,
      accountVersions: accounts.map(({ id, version }) => ({ accountId: id, version })),
      courses,
      totalPaidRefund: totalPaidRefund.toFixed(2),
      feeAmount: feeAmount.toFixed(2),
      feePercentage: feePercentage.toFixed(2),
      actualRefundAmount: totalPaidRefund.sub(feeAmount).toFixed(2),
    };
  }

  async createPaymentPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; channel: PaymentChannel; occurredAt: Date; note?: string | undefined;
  }) {
    return this.createMoneyPreview({ ...input, action: 'PAYMENT' });
  }

  async createGiftPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; occurredAt: Date; note?: string | undefined;
  }) {
    return this.createMoneyPreview({ ...input, action: 'GIFT' });
  }

  private async createMoneyPreview(input: {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
    accountId: string; amount: string; occurredAt: Date;
    action: 'PAYMENT' | 'GIFT'; channel?: PaymentChannel | undefined; note?: string | undefined;
  }) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const amount = new Prisma.Decimal(input.amount);
    if (!amount.isFinite() || !amount.gt(0) || amount.toFixed(2) !== input.amount) {
      throw new BadRequestException('金额必须是大于零的两位小数字符串');
    }
    const actor = await this.loadActor(actorUserId);
    if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可预览资金操作');
    if (this.periods) await this.periods.assertWritableForDate(input.occurredAt);
    const actionType = input.action === 'PAYMENT' ? 'course-account.payment' : 'course-account.gift';
    const commandId = input.idempotencyKey;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const account = await tx.studentCourseAccount.findUnique({ where: { id: input.accountId }, select: { id: true } });
        if (!account) throw new NotFoundException('学生课程账户不存在');
        const snapshot = await this.ledger.getPreviewSnapshotInTransaction(tx, input.accountId);
        const projected = this.ledger.projectBalance(snapshot, input.action, amount);
        const command = {
          accountId: input.accountId,
          amount: amount.toFixed(2),
          ...(input.action === 'PAYMENT' ? { channel: input.channel } : {}),
          occurredAt: input.occurredAt.toISOString(),
          note: input.note?.trim() || null,
        } satisfies Prisma.InputJsonObject;
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L2,
          normalizedCommandJson: command,
          displayJson: {
            title: input.action === 'PAYMENT' ? '课程交费' : '课程赠送',
            summary: input.action === 'PAYMENT' ? `交费 ¥${amount.toFixed(2)}` : `赠送 ¥${amount.toFixed(2)}`,
            beforeBalance: toDisplayBalance(projected.before),
            afterBalance: toDisplayBalance(projected.after),
          } as unknown as Prisma.InputJsonObject,
          resourceVersionsJson: { accountId: input.accountId, accountVersion: snapshot.version },
          idempotencyKey: commandId,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId,
          resourceType: 'student-course-account', resourceId: input.accountId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1`, accountVersion: snapshot.version },
        } });
        return { preview, auditEvent: audit } satisfies CreatedPreview;
      });
      return this.toMoneyPreviewResponse(result);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // 只在唯一约束冲突后读取并核验，避免“先查再插”的竞态窗口。
      const original = await this.findByIdempotencyKey(commandId);
      if (!original || original.preview.actorUserId !== actorUserId || original.preview.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const command = original.preview.normalizedCommandJson as {
        accountId?: string; amount?: string; channel?: PaymentChannel; occurredAt?: string; note?: string | null;
      };
      if (
        command.accountId !== input.accountId ||
        command.amount !== amount.toFixed(2) ||
        command.occurredAt !== input.occurredAt.toISOString() ||
        (command.note ?? null) !== (input.note?.trim() || null) ||
        (input.action === 'PAYMENT' && command.channel !== input.channel)
      ) {
        throw new ConflictException('幂等键已用于不同的资金预览请求');
      }
      return this.toMoneyPreviewResponse(original);
    }
  }

  private toMoneyPreviewResponse(created: CreatedPreview) {
    return {
      previewId: created.preview.id,
      actionType: created.preview.actionType,
      riskLevel: created.preview.riskLevel,
      command: created.preview.normalizedCommandJson,
      display: created.preview.displayJson,
      expiresAt: created.preview.expiresAt.toISOString(),
      auditEventId: created.auditEvent.id,
    };
  }

  async confirmMoneyPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || !['course-account.payment', 'course-account.gift'].includes(preview.actionType)) {
        throw new NotFoundException('资金预览不存在');
      }
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的资金预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认资金操作');
      if (preview.status === PreviewStatus.EXECUTED) {
        const receiptEvent = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = receiptEvent?.detailJson as (Record<string, unknown> & { idempotencyKey?: string }) | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('资金预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: receiptEvent?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('资金预览已不能确认');
      const now = new Date();
      if (preview.expiresAt <= now) throw new ConflictException('资金预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as {
        accountId: string; amount: string; channel?: PaymentChannel; occurredAt: string; note: string | null;
      };
      const versions = preview.resourceVersionsJson as unknown as { accountId: string; accountVersion: number };
      if (command.accountId !== versions.accountId) throw new ConflictException('资金预览账户快照无效');
      const current = await this.ledger.getPreviewSnapshotInTransaction(tx, command.accountId);
      if (current.version !== versions.accountVersion) throw new ConflictException('课程账户余额已变化，请重新预览');
      const amount = new Prisma.Decimal(command.amount);
      const happenedAt = new Date(command.occurredAt);
      const ledgerInput = {
        accountId: command.accountId,
        amount,
        occurredAt: happenedAt,
        ...(command.note ? { note: command.note } : {}),
        createdById: actor.id,
        commandId: idempotencyKey,
      };
      const after = preview.actionType === 'course-account.payment'
        ? await this.ledger.recordPaymentInTransaction(tx, { ...ledgerInput, channel: command.channel! })
        : await this.ledger.recordGiftInTransaction(tx, ledgerInput);
      const entry = await tx.ledgerEntry.findUnique({ where: { commandId: idempotencyKey }, select: { id: true } });
      if (!entry) throw new ConflictException('资金流水未能创建');
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = {
        actionType: preview.actionType,
        ledgerEntryId: entry.id,
        idempotencyKey,
        accountId: command.accountId,
        amount: command.amount,
        occurredAt: happenedAt.toISOString(),
        balanceAfter: after,
        executedAt: now.toISOString(),
      };
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'ledger-entry', resourceId: entry.id,
        detailJson: receipt,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: {
        ...receipt, auditEventId: audit.id,
      } };
    });
  }

  async confirmPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    const currentActor = await this.loadActor(actor.id);
    const preview = await this.prisma.actionPreview.findUnique({ where: { id: previewId }, select: { actionType: true } });
    if (preview?.actionType === 'course-account.payment' || preview?.actionType === 'course-account.gift') {
      return this.confirmMoneyPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview?.actionType === 'lesson.schedule.weekly-batch') {
      return this.confirmBatchLessonPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview?.actionType === 'student.final-refund') {
      return this.confirmFinalRefundPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview && LESSON_MUTATION_ACTIONS.has(preview.actionType as LessonMutationAction)) {
      return this.confirmLessonMutationPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview && ['manual-transaction.create', 'payroll.generate', 'payroll.pay', 'payroll.adjust', 'payroll.cancel-payment', 'ledger-entry.reversal', 'period.close', 'period.reopen'].includes(preview.actionType)) {
      return this.confirmStructuredBusinessPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview && ['student.create', 'student.update', 'teacher.create', 'teacher.compensation.update', 'course.create', 'course.update', 'course-account.open', 'course-account.price'].includes(preview.actionType)) {
      return this.confirmBasicDataPreview(previewId, currentActor, idempotencyKey);
    }
    if (preview?.actionType === 'lesson.schedule.single') return this.confirmSingleLessonPreview(previewId, currentActor, idempotencyKey);
    throw new NotFoundException('预览不存在或不支持确认');
  }

  private async confirmBasicDataPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    const students = this.students;
    const courses = this.courses;
    const accounts = this.studentCourseAccounts;
    if (!students || !courses || !accounts) throw new ConflictException('基础资料操作服务未配置');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      const supported: BasicDataAction[] = ['student.create', 'student.update', 'teacher.create', 'teacher.compensation.update', 'course.create', 'course.update', 'course-account.open', 'course-account.price'];
      if (!preview || !supported.includes(preview.actionType as BasicDataAction)) throw new NotFoundException('基础资料预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的基础资料预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认基础资料操作');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as Record<string, unknown> | null;
        if (receipt?.['idempotencyKey'] !== idempotencyKey) throw new ConflictException('预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('基础资料预览已不能确认');
      if (preview.riskLevel !== PreviewRiskLevel.L2) throw new ConflictException('基础资料预览风险级别无效，请重新预览');
      if (preview.expiresAt <= new Date()) throw new ConflictException('基础资料预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as Record<string, unknown>;
      const versions = preview.resourceVersionsJson as Record<string, unknown>;
      const occurredAt = new Date().toISOString();
      let receipt: Record<string, unknown>;
      try {
        switch (preview.actionType as BasicDataAction) {
          case 'student.create': {
            const result = await students.createInTransaction(tx, { name: commandText(command, 'name'), phone: optionalText(command, 'phone') ?? null, notes: optionalText(command, 'notes') ?? null });
            receipt = { actionType: preview.actionType, studentId: result.id, name: result.name, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'student.update': {
            const studentId = commandText(command, 'studentId');
            const result = await students.updateInTransaction(tx, studentId, {
              ...(typeof command.name === 'string' ? { name: command.name } : {}),
              ...(command.phone !== undefined ? { phone: optionalText(command, 'phone') ?? null } : {}),
              ...(command.notes !== undefined ? { notes: optionalText(command, 'notes') ?? null } : {}),
            }, new Date(String(versions.updatedAt)));
            receipt = { actionType: preview.actionType, studentId: result.id, name: result.name, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'teacher.create': {
            if (!this.teachers) throw new ConflictException('教师资料服务未配置');
            const result = await this.teachers.createProfileInTransaction(tx, {
              name: commandText(command, 'name'),
              defaultBaseSalary: commandNonNegativeAmount(command, 'baseSalary'),
              defaultCommissionRate: commandDecimal(command, 'commissionRate', 4),
            });
            receipt = { actionType: preview.actionType, teacherId: result.id, name: result.name, userId: null, username: null, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'teacher.compensation.update': {
            if (!this.teachers) throw new ConflictException('教师资料服务未配置');
            const teacherId = commandText(command, 'teacherId');
            const result = await this.teachers.updateCompensationInTransaction(tx, teacherId, {
              defaultBaseSalary: commandNonNegativeAmount(command, 'baseSalary'),
              defaultCommissionRate: commandDecimal(command, 'commissionRate', 4),
            }, new Date(String(versions.updatedAt)));
            receipt = { actionType: preview.actionType, teacherId: result.id, name: result.name, defaultBaseSalary: result.defaultBaseSalary, defaultCommissionRate: result.defaultCommissionRate, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'course.create': {
            const result = await courses.createInTransaction(tx, {
              name: commandText(command, 'name'), defaultUnitPrice: commandAmount(command, 'defaultUnitPrice'), defaultDurationMinutes: commandInteger(command, 'defaultDurationMinutes'),
            });
            receipt = { actionType: preview.actionType, courseId: result.id, name: result.name, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'course.update': {
            const courseId = commandText(command, 'courseId');
            const result = await courses.updateInTransaction(tx, courseId, {
              ...(typeof command.name === 'string' ? { name: command.name } : {}),
              ...(command.defaultUnitPrice !== undefined ? { defaultUnitPrice: commandAmount(command, 'defaultUnitPrice') } : {}),
              ...(command.defaultDurationMinutes !== undefined ? { defaultDurationMinutes: commandInteger(command, 'defaultDurationMinutes') } : {}),
              ...(command.isActive !== undefined ? { isActive: commandBoolean(command, 'isActive') } : {}),
            }, new Date(String(versions.updatedAt)));
            receipt = { actionType: preview.actionType, courseId: result.id, name: result.name, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'course-account.open': {
            const studentId = commandText(command, 'studentId');
            const courseId = commandText(command, 'courseId');
            const result = await accounts.openInTransaction(tx, studentId, {
              courseId, ...(command.currentUnitPrice !== undefined ? { currentUnitPrice: commandAmount(command, 'currentUnitPrice') } : {}),
            }, { studentUpdatedAt: new Date(String(versions.studentUpdatedAt)), courseUpdatedAt: new Date(String(versions.courseUpdatedAt)) });
            receipt = { actionType: preview.actionType, accountId: result.id, studentId, courseId, currentUnitPrice: result.currentUnitPrice, idempotencyKey, executedAt: occurredAt };
            break;
          }
          case 'course-account.price': {
            const accountId = commandText(command, 'accountId');
            const result = await accounts.updatePriceInTransaction(tx, accountId, { currentUnitPrice: commandAmount(command, 'currentUnitPrice') }, Number(versions.version));
            receipt = { actionType: preview.actionType, accountId: result.id, currentUnitPrice: result.currentUnitPrice, version: result.version, idempotencyKey, executedAt: occurredAt };
            break;
          }
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new ConflictException('业务记录已存在，请重新预览');
        throw error;
      }
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: new Date(occurredAt) } });
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed', requestId: idempotencyKey,
        resourceType: preview.actionType, resourceId: previewId, detailJson: receipt! as Prisma.InputJsonObject,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: { ...receipt!, auditEventId: audit.id } };
    });
  }

  createReschedulePreview(input: LessonMutationPreviewInput & { startsAt: Date }) {
    return this.createLessonMutationPreview('lesson.reschedule', input);
  }

  createCancelPreview(input: LessonMutationPreviewInput) {
    return this.createLessonMutationPreview('lesson.cancel', input);
  }

  createCompletionPreview(input: LessonMutationPreviewInput) {
    return this.createLessonMutationPreview('lesson.complete', input);
  }

  createCompletionReversalPreview(input: LessonMutationPreviewInput) {
    return this.createLessonMutationPreview('lesson.complete.reversal', input);
  }

  createCompletionCorrectionPreview(input: LessonMutationPreviewInput & { correctedUnitPrice: Prisma.Decimal }) {
    return this.createLessonMutationPreview('lesson.complete.correction', input);
  }

  createStructuredActionPreview(input: StructuredActionPreviewInput) {
    if (['student.create', 'student.update', 'teacher.create', 'teacher.compensation.update', 'course.create', 'course.update', 'course-account.open', 'course-account.price'].includes(input.actionType)) {
      return this.createBasicDataPreview(input as StructuredActionPreviewInput & { actionType: BasicDataAction });
    }
    if (input.actionType === 'manual-transaction.create') return this.createManualTransactionPreview(input);
    if (input.actionType === 'payroll.generate') return this.createPayrollGeneratePreview(input);
    if (input.actionType === 'payroll.pay') return this.createPayrollPayPreview(input);
    if (input.actionType === 'payroll.adjust') return this.createPayrollAdjustPreview(input);
    if (input.actionType === 'payroll.cancel-payment') return this.createPayrollCancelPaymentPreview(input);
    if (input.actionType === 'ledger-entry.reversal') return this.createLedgerReversalPreview(input);
    if (input.actionType === 'period.close') return this.createPeriodClosePreview(input);
    if (input.actionType === 'period.reopen') return this.createPeriodReopenPreview(input);

    const lessonId = typeof input.command.lessonId === 'string' ? input.command.lessonId : '';
    if (!lessonId) throw new BadRequestException('lessonId 不能为空');
    if (input.actionType === 'lesson.reschedule') {
      const startsAt = typeof input.command.targetStartsAt === 'string' ? input.command.targetStartsAt : input.command.startsAt;
      if (typeof startsAt !== 'string') throw new BadRequestException('调课目标时间不能为空');
      return this.createReschedulePreview({ ...input, lessonId, startsAt: new Date(startsAt) });
    }
    const note = typeof input.command.reason === 'string' ? input.command.reason : typeof input.command.note === 'string' ? input.command.note : undefined;
    if (input.actionType === 'lesson.complete.correction') {
      return this.createCompletionCorrectionPreview({
        ...input,
        lessonId,
        correctedUnitPrice: commandAmount(input.command, 'correctedUnitPrice'),
        note,
      });
    }
    return input.actionType === 'lesson.cancel'
      ? this.createCancelPreview({ ...input, lessonId, note })
      : input.actionType === 'lesson.complete'
        ? this.createCompletionPreview({ ...input, lessonId, note })
        : this.createCompletionReversalPreview({ ...input, lessonId, note });
  }

  private async createBasicDataPreview(input: StructuredActionPreviewInput & { actionType: BasicDataAction }) {
    const actor = await this.loadOwner(input.actorUserId, '基础资料');
    const command = input.command;
    let values: { command: Prisma.InputJsonObject; display: Prisma.InputJsonObject; resourceVersions: Prisma.InputJsonObject; resourceType: string; resourceId: string };
    switch (input.actionType) {
      case 'student.create': {
        this.assertCommandFields(command, ['name', 'phone', 'notes']);
        if (!this.students) throw new ConflictException('学生资料服务未配置');
        const result = await this.students.previewCreate({ name: commandText(command, 'name'), phone: optionalText(command, 'phone') ?? null, notes: optionalText(command, 'notes') ?? null });
        values = { command: { name: result.input.name, phone: result.input.phone ?? null, notes: result.input.notes ?? null }, display: { title: '新增学生', name: result.input.name, phone: result.input.phone ?? null, notes: result.input.notes ?? null }, resourceVersions: {}, resourceType: 'student', resourceId: 'new' };
        break;
      }
      case 'student.update': {
        this.assertCommandFields(command, ['studentId', 'name', 'phone', 'notes']);
        if (!this.students) throw new ConflictException('学生资料服务未配置');
        const studentId = commandText(command, 'studentId');
        const result = await this.students.previewUpdate(studentId, { ...(typeof command.name === 'string' ? { name: command.name } : {}), ...(command.phone !== undefined ? { phone: optionalText(command, 'phone') ?? null } : {}), ...(command.notes !== undefined ? { notes: optionalText(command, 'notes') ?? null } : {}) });
        values = { command: { studentId, ...result.input }, display: { title: '修改学生资料', ...result.display }, resourceVersions: result.resourceVersions as Prisma.InputJsonObject, resourceType: 'student', resourceId: studentId };
        break;
      }
      case 'teacher.create': {
        this.assertCommandFields(command, ['name', 'baseSalary', 'commissionRate']);
        if (!this.teachers) throw new ConflictException('教师资料服务未配置');
        const normalized = this.teachers.previewCreateProfile({
          name: commandText(command, 'name'),
          defaultBaseSalary: commandNonNegativeAmount(command, 'baseSalary'),
          defaultCommissionRate: commandDecimal(command, 'commissionRate', 4),
        });
        values = {
          command: { name: normalized.name, baseSalary: normalized.defaultBaseSalary.toFixed(2), commissionRate: normalized.defaultCommissionRate.toFixed(4) },
          display: { title: '新增教师资料', summary: `${normalized.name}，基本工资 ¥${normalized.defaultBaseSalary.toFixed(2)}，提成 ${normalized.defaultCommissionRate.toFixed(4)}%；不会创建登录账号`, name: normalized.name, baseSalary: normalized.defaultBaseSalary.toFixed(2), commissionRate: normalized.defaultCommissionRate.toFixed(4), createsLoginAccount: false },
          resourceVersions: {}, resourceType: 'teacher', resourceId: 'new',
        };
        break;
      }
      case 'teacher.compensation.update': {
        this.assertCommandFields(command, ['teacherId', 'baseSalary', 'commissionRate']);
        if (!this.teachers) throw new ConflictException('教师资料服务未配置');
        const teacherId = commandText(command, 'teacherId');
        const preview = await this.teachers.previewUpdateCompensation(teacherId, {
          defaultBaseSalary: commandNonNegativeAmount(command, 'baseSalary'),
          defaultCommissionRate: commandDecimal(command, 'commissionRate', 4),
        });
        values = {
          command: { teacherId, baseSalary: preview.nextBaseSalary, commissionRate: preview.nextCommissionRate },
          display: { title: '修改教师薪酬配置', teacherName: preview.teacher.name, beforeBaseSalary: preview.teacher.defaultBaseSalary, afterBaseSalary: preview.nextBaseSalary, beforeCommissionRate: preview.teacher.defaultCommissionRate, afterCommissionRate: preview.nextCommissionRate },
          resourceVersions: { updatedAt: preview.updatedAt.toISOString() }, resourceType: 'teacher', resourceId: teacherId,
        };
        break;
      }
      case 'course.create': {
        this.assertCommandFields(command, ['name', 'defaultUnitPrice', 'defaultDurationMinutes']);
        if (!this.courses) throw new ConflictException('课程资料服务未配置');
        const result = await this.courses.previewCreate({ name: commandText(command, 'name'), defaultUnitPrice: commandAmount(command, 'defaultUnitPrice'), defaultDurationMinutes: commandInteger(command, 'defaultDurationMinutes') });
        values = { command: { name: result.input.name, defaultUnitPrice: result.input.defaultUnitPrice.toFixed(2), defaultDurationMinutes: result.input.defaultDurationMinutes }, display: { title: '新增课程', ...result.input, defaultUnitPrice: result.input.defaultUnitPrice.toFixed(2) }, resourceVersions: {}, resourceType: 'course', resourceId: 'new' };
        break;
      }
      case 'course.update': {
        this.assertCommandFields(command, ['courseId', 'name', 'defaultUnitPrice', 'defaultDurationMinutes', 'isActive']);
        if (!this.courses) throw new ConflictException('课程资料服务未配置');
        const courseId = commandText(command, 'courseId');
        const update: UpdateCourseInput = {
          ...(typeof command.name === 'string' ? { name: command.name } : {}),
          ...(command.defaultUnitPrice !== undefined ? { defaultUnitPrice: commandAmount(command, 'defaultUnitPrice') } : {}),
          ...(command.defaultDurationMinutes !== undefined ? { defaultDurationMinutes: commandInteger(command, 'defaultDurationMinutes') } : {}),
          ...(command.isActive !== undefined ? { isActive: commandBoolean(command, 'isActive') } : {}),
        };
        const result = await this.courses.previewUpdate(courseId, update);
        const jsonUpdate = { ...result.input, ...(result.input.defaultUnitPrice ? { defaultUnitPrice: result.input.defaultUnitPrice.toFixed(2) } : {}) };
        values = { command: { courseId, ...jsonUpdate }, display: { title: '修改课程资料', ...result.display }, resourceVersions: result.resourceVersions as Prisma.InputJsonObject, resourceType: 'course', resourceId: courseId };
        break;
      }
      case 'course-account.open': {
        this.assertCommandFields(command, ['studentId', 'courseId', 'currentUnitPrice']);
        if (!this.studentCourseAccounts) throw new ConflictException('课程账户服务未配置');
        const studentId = commandText(command, 'studentId');
        const open: CreateStudentCourseAccountInput = { courseId: commandText(command, 'courseId'), ...(command.currentUnitPrice !== undefined ? { currentUnitPrice: commandAmount(command, 'currentUnitPrice') } : {}) };
        const result = await this.studentCourseAccounts.previewOpen(studentId, open);
        values = { command: { studentId, ...result.input }, display: { title: '开通课程账户', ...result.display }, resourceVersions: result.resourceVersions as Prisma.InputJsonObject, resourceType: 'student-course-account', resourceId: `${studentId}:${open.courseId}` };
        break;
      }
      case 'course-account.price': {
        this.assertCommandFields(command, ['accountId', 'currentUnitPrice']);
        if (!this.studentCourseAccounts) throw new ConflictException('课程账户服务未配置');
        const accountId = commandText(command, 'accountId');
        const price: UpdateStudentCourseAccountPriceInput = { currentUnitPrice: commandAmount(command, 'currentUnitPrice') };
        const result = await this.studentCourseAccounts.previewPrice(accountId, price);
        values = { command: { accountId, ...result.input }, display: { title: '修改课程单价', ...result.display }, resourceVersions: result.resourceVersions as Prisma.InputJsonObject, resourceType: 'student-course-account', resourceId: accountId };
        break;
      }
    }
    return this.saveStructuredPreview({ ...input, actorUserId: actor.id }, values);
  }

  private assertCommandFields(command: Record<string, unknown>, allowed: string[]): void {
    const extra = Object.keys(command).find((field) => !allowed.includes(field));
    if (extra) throw new BadRequestException(`不支持的参数：${extra}`);
  }

  private async createManualTransactionPreview(input: StructuredActionPreviewInput) {
    if (!this.manualTransactions || !this.periods) throw new ConflictException('手工收支预览服务未配置');
    const actor = await this.loadOwner(input.actorUserId, '手工收支');
    const kind = manualKind(input.command);
    const amount = commandAmount(input.command, 'amount');
    const channel = enumText(input.command, 'channel', Object.values(PaymentChannel));
    const occurredAt = commandDateTime(input.command, 'occurredAt');
    const note = typeof input.command.note === 'string' ? input.command.note.trim() || undefined : undefined;
    const incomeCategory = kind === ManualTransactionKind.INCOME ? manualIncomeCategory(input.command) : undefined;
    const expenseCategory = kind === ManualTransactionKind.EXPENSE ? manualExpenseCategory(input.command) : undefined;
    const domainInput: CreateManualTransactionInput = {
      kind, amount, channel, occurredAt, createdById: actor.id,
      ...(incomeCategory ? { incomeCategory } : {}),
      ...(expenseCategory ? { expenseCategory } : {}),
      ...(note ? { note } : {}),
    };
    this.manualTransactions.validateInput(domainInput);
    await this.periods.assertWritableForDate(occurredAt);
    const periodStart = businessMonthStart(occurredAt);
    const categoryFields = {
      ...(incomeCategory ? { incomeCategory } : {}),
      ...(expenseCategory ? { expenseCategory } : {}),
    };
    const direction = kind === ManualTransactionKind.INCOME ? '收入' : '支出';
    return this.saveStructuredPreview(input, {
      command: {
        kind, amount: amount.toFixed(2),
        ...categoryFields,
        channel, occurredAt: occurredAt.toISOString(), note: note ?? null,
      },
      display: {
        title: kind === ManualTransactionKind.INCOME ? '登记经营收入' : '登记经营支出',
        summary: `${direction} ¥${amount.toFixed(2)}${note ? ` · 备注 ${note}` : ''}`,
        kind, ...categoryFields, amount: amount.toFixed(2), channel, occurredAt: occurredAt.toISOString(), note: note ?? null,
      },
      resourceVersions: { periodStart: periodStart.toISOString(), periodState: 'OPEN' },
      resourceType: 'manual-transaction', resourceId: periodStart.toISOString(),
    });
  }

  private async createPayrollGeneratePreview(input: StructuredActionPreviewInput) {
    const payrollService = this.payroll;
    if (!payrollService) throw new ConflictException('工资预览服务未配置');
    const actor = await this.loadOwner(input.actorUserId, '工资生成');
    const teacherId = commandText(input.command, 'teacherId');
    const period = commandBusinessMonth(input.command);
    const calculated = await payrollService.previewGenerate({ teacherId, periodStart: period.date, actorId: actor.id });
    return this.saveStructuredPreview(input, {
      command: { teacherId, period: period.value },
      display: {
        title: '生成工资记录', summary: `${calculated.teacherName} ${period.value} 应发 ¥${calculated.netSalary}`,
        teacherName: calculated.teacherName, courseRevenue: calculated.courseRevenue, baseSalary: calculated.baseSalary,
        commissionRate: calculated.commissionRate, commissionAmount: calculated.commissionAmount,
        grossSalary: calculated.grossSalary, netSalary: calculated.netSalary,
        periodStart: calculated.periodStart.toISOString(), teacherUpdatedAt: calculated.teacherUpdatedAt.toISOString(),
      },
      resourceVersions: {
        teacherId, teacherUpdatedAt: calculated.teacherUpdatedAt.toISOString(),
        courseRevenue: calculated.courseRevenue, periodStart: period.date.toISOString(),
      },
      resourceType: 'payroll', resourceId: `${teacherId}:${period.date.toISOString()}`,
    });
  }

  private async createPayrollPayPreview(input: StructuredActionPreviewInput) {
    const payrollService = this.payroll;
    if (!payrollService) throw new ConflictException('工资预览服务未配置');
    await this.loadOwner(input.actorUserId, '工资支付');
    const payrollId = commandText(input.command, 'payrollId');
    const paidAt = commandDateTime(input.command, 'paidAt');
    const channel = enumText(input.command, 'channel', Object.values(PaymentChannel));
    const note = typeof input.command.note === 'string' ? input.command.note.trim() || undefined : undefined;
    if (channel === PaymentChannel.OTHER && !note) throw new BadRequestException('选择其他渠道时必须填写备注');
    const payroll = await payrollService.findById(payrollId);
    if (payroll.status === PayrollStatus.PAID) throw new ConflictException('工资已经支付');
    return this.saveStructuredPreview(input, {
      command: { payrollId, paidAt: paidAt.toISOString(), channel, note: note ?? null },
      display: {
        title: '支付工资', summary: `${payroll.teacherName} ${payroll.periodStart.toISOString().slice(0, 7)} 支付 ¥${payroll.netSalary}`,
        teacherName: payroll.teacherName, netSalary: payroll.netSalary, status: payroll.status,
        paidAt: paidAt.toISOString(), channel,
      },
      resourceVersions: { payrollId, payrollVersion: payroll.version, status: payroll.status, periodStart: payroll.periodStart.toISOString() },
      resourceType: 'payroll', resourceId: payrollId,
    });
  }

  private async createPayrollAdjustPreview(input: StructuredActionPreviewInput) {
    const payrollService = this.payroll;
    if (!payrollService) throw new ConflictException('工资预览服务未配置');
    await this.loadOwner(input.actorUserId, '工资奖金或代扣调整');
    this.assertCommandFields(input.command, ['payrollId', 'baseSalary', 'commissionRate', 'bonusAmount', 'bonusNote', 'deductionAmount', 'deductionNote']);
    const payrollId = commandText(input.command, 'payrollId');
    const hasBaseSalary = input.command.baseSalary !== undefined;
    const hasCommissionRate = input.command.commissionRate !== undefined;
    const hasBonus = input.command.bonusAmount !== undefined;
    const hasDeduction = input.command.deductionAmount !== undefined;
    if (!hasBaseSalary && !hasCommissionRate && !hasBonus && !hasDeduction) throw new BadRequestException('至少需要调整一项工资数据');
    const baseSalary = hasBaseSalary ? commandNonNegativeAmount(input.command, 'baseSalary') : undefined;
    const commissionRate = hasCommissionRate ? commandDecimal(input.command, 'commissionRate', 4) : undefined;
    const bonusAmount = hasBonus ? commandNonNegativeAmount(input.command, 'bonusAmount') : undefined;
    const deductionAmount = hasDeduction ? commandNonNegativeAmount(input.command, 'deductionAmount') : undefined;
    const bonusNote = typeof input.command.bonusNote === 'string' ? input.command.bonusNote.trim() || undefined : undefined;
    const deductionNote = typeof input.command.deductionNote === 'string' ? input.command.deductionNote.trim() || undefined : undefined;
    const preview = await payrollService.previewAdjust({ payrollId, ...(baseSalary ? { baseSalary } : {}), ...(commissionRate ? { commissionRate } : {}), ...(bonusAmount ? { bonusAmount } : {}), ...(deductionAmount ? { deductionAmount } : {}), ...(hasBonus ? { bonusNote } : {}), ...(hasDeduction ? { deductionNote } : {}), actorId: input.actorUserId });
    return this.saveStructuredPreview(input, {
      command: {
        payrollId,
        beforeBaseSalary: preview.beforeBaseSalary,
        afterBaseSalary: preview.afterBaseSalary,
        beforeCommissionRate: preview.beforeCommissionRate,
        afterCommissionRate: preview.afterCommissionRate,
        commissionAmount: preview.payroll.commissionAmount,
        grossSalary: preview.payroll.grossSalary,
        netSalary: preview.payroll.netSalary,
        ...(hasBaseSalary ? { baseSalary: preview.afterBaseSalary } : {}),
        ...(hasCommissionRate ? { commissionRate: preview.afterCommissionRate } : {}),
        ...(hasBonus ? { bonusAmount: bonusAmount!.toFixed(2), bonusNote: bonusNote ?? null } : {}),
        ...(hasDeduction ? { deductionAmount: deductionAmount!.toFixed(2), deductionNote: deductionNote ?? null } : {}),
      },
      display: {
        title: '调整工资',
        summary: `${preview.payroll.teacherName} ${preview.payroll.periodStart.toISOString().slice(0, 7)}：基础工资 ¥${preview.beforeBaseSalary} → ¥${preview.afterBaseSalary}，提成比例 ${preview.beforeCommissionRate}% → ${preview.afterCommissionRate}%；重算提成 ¥${preview.payroll.commissionAmount}，应发 ¥${preview.payroll.grossSalary}，实发 ¥${preview.payroll.netSalary}`,
        teacherName: preview.payroll.teacherName,
        period: preview.payroll.periodStart.toISOString().slice(0, 7),
        beforeBaseSalary: preview.beforeBaseSalary, afterBaseSalary: preview.afterBaseSalary,
        beforeCommissionRate: preview.beforeCommissionRate, afterCommissionRate: preview.afterCommissionRate,
        commissionAmount: preview.payroll.commissionAmount,
        beforeBonusAmount: preview.beforeBonusAmount, afterBonusAmount: preview.afterBonusAmount,
        beforeDeductionAmount: preview.beforeDeductionAmount, afterDeductionAmount: preview.afterDeductionAmount,
        grossSalary: preview.payroll.grossSalary, netSalary: preview.payroll.netSalary,
        bonusNote: preview.payroll.bonusNote, deductionNote: preview.payroll.deductionNote,
      },
      resourceVersions: { payrollId, payrollVersion: preview.payrollVersion, status: preview.payroll.status, periodStart: preview.payroll.periodStart.toISOString() },
      resourceType: 'payroll', resourceId: payrollId,
    });
  }

  private async createPayrollCancelPaymentPreview(input: StructuredActionPreviewInput) {
    if (!this.payroll) throw new ConflictException('工资预览服务未配置');
    await this.loadOwner(input.actorUserId, '撤销工资支付');
    this.assertCommandFields(input.command, ['payrollId', 'reason', 'note']);
    const payrollId = commandText(input.command, 'payrollId');
    const reason = commandText(input.command, 'reason');
    const preview = await this.payroll.previewCancelPayment(payrollId);
    return this.saveStructuredPreview(input, {
      command: { payrollId, reason, note: optionalText(input.command, 'note') ?? null },
      display: {
        title: '撤销工资支付',
        summary: `${preview.payroll.teacherName} ${preview.payroll.periodStart.toISOString().slice(0, 7)} 已支付工资 ¥${preview.payroll.netSalary} 将恢复为未支付；原支付信息保留在审计记录中。`,
        teacherName: preview.payroll.teacherName, period: preview.payroll.periodStart.toISOString().slice(0, 7),
        netSalary: preview.payroll.netSalary, paidAt: preview.payroll.paidAt?.toISOString() ?? null,
        paymentChannel: preview.payroll.paymentChannel, reason,
      },
      resourceVersions: { payrollId, payrollVersion: preview.expectedVersion, status: preview.payroll.status },
      resourceType: 'payroll', resourceId: payrollId,
    });
  }

  private async createLedgerReversalPreview(input: StructuredActionPreviewInput) {
    await this.loadOwner(input.actorUserId, '金额流水冲正');
    this.assertCommandFields(input.command, ['entryId', 'accountVersion', 'occurredAt', 'reason', 'note']);
    const entryId = commandText(input.command, 'entryId');
    const requestedVersion = commandNonNegativeInteger(input.command, 'accountVersion');
    const occurredAt = commandDateTime(input.command, 'occurredAt');
    const reason = commandText(input.command, 'reason');
    const preview = await this.ledger.previewReverseEntry(entryId);
    if (preview.accountVersion !== requestedVersion) throw new ConflictException('课程账户已变化，请重新预览');
    return this.saveStructuredPreview(input, {
      command: { entryId, accountVersion: preview.accountVersion, occurredAt: occurredAt.toISOString(), reason, note: optionalText(input.command, 'note') ?? null },
      display: {
        title: preview.kind === 'PAYMENT' ? '冲正交费流水' : '冲正赠送流水',
        summary: `冲正${preview.kind === 'PAYMENT' ? '交费' : '赠送'} ¥${preview.amount}；只追加反向流水，不删除原记录。`,
        kind: preview.kind, amount: preview.amount, reason,
        beforeBalance: preview.before, afterBalance: preview.after,
      },
      resourceVersions: { accountId: preview.accountId, accountVersion: preview.accountVersion, entryId },
      resourceType: 'ledger-entry', resourceId: entryId,
    });
  }

  private async createPeriodClosePreview(input: StructuredActionPreviewInput) {
    if (!this.periods) throw new ConflictException('关账预览服务未配置');
    await this.loadOwner(input.actorUserId, '关账');
    const period = commandBusinessMonth(input.command);
    if (typeof this.periods.preclose === 'function') {
      const readiness = await this.periods.preclose(period.date);
      if (readiness.blockers.length > 0) {
        throw new ConflictException(`该月份存在关账阻断：${readiness.blockers.map((item) => item.message).join('；')}`);
      }
    } else {
      await this.periods.assertWritableForDate(period.date);
    }
    return this.saveStructuredPreview(input, {
      command: { period: period.value },
      display: { title: '关账', summary: `关闭 ${period.value} 业务月份，关闭后不能修改该月记录。`, period: period.value },
      resourceVersions: { periodStart: period.date.toISOString(), periodState: 'OPEN' },
      resourceType: 'closed-period', resourceId: period.date.toISOString(),
    });
  }

  private async createPeriodReopenPreview(input: StructuredActionPreviewInput) {
    if (!this.periods) throw new ConflictException('重开预览服务未配置');
    await this.loadOwner(input.actorUserId, '重开关账');
    const period = commandBusinessMonth(input.command);
    const reason = commandText(input.command, 'reason');
    const target = await this.periods.previewReopen(period.date);
    return this.saveStructuredPreview(input, {
      command: { period: period.value, reason },
      display: { title: '重开关账', summary: `重开 ${period.value}，原因：${reason}`, period: period.value, reason },
      resourceVersions: { periodStart: period.date.toISOString(), closedPeriodId: target.closedPeriodId, closedAt: target.closedAt.toISOString(), periodState: 'CLOSED' },
      resourceType: 'closed-period', resourceId: target.closedPeriodId,
    });
  }

  private async saveStructuredPreview(
    input: StructuredActionPreviewInput,
    values: { command: Prisma.InputJsonObject; display: Prisma.InputJsonObject; resourceVersions: Prisma.InputJsonObject; resourceType: string; resourceId: string },
  ) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actionType = input.actionType;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId, actionType, schemaVersion: `${actionType}.v1`, riskLevel: PreviewRiskLevel.L2,
          normalizedCommandJson: values.command, displayJson: values.display, resourceVersionsJson: values.resourceVersions,
          idempotencyKey, status: PreviewStatus.PENDING, expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id, eventType: 'assistant.preview.created', requestId,
          resourceType: values.resourceType, resourceId: values.resourceId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1` },
        } });
        return { preview, audit };
      });
      return { previewId: created.preview.id, actionType, riskLevel: created.preview.riskLevel, command: created.preview.normalizedCommandJson,
        display: created.preview.displayJson, resourceVersions: created.preview.resourceVersionsJson,
        expiresAt: created.preview.expiresAt.toISOString(), auditEventId: created.audit.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType ||
        JSON.stringify(prior.normalizedCommandJson) !== JSON.stringify(values.command)) {
        throw new ConflictException('幂等键已用于不同的结构化操作预览');
      }
      const audit = await this.prisma.businessAuditEvent.findFirst({ where: { previewId: prior.id, eventType: 'assistant.preview.created' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (!audit) throw new ConflictException('幂等预览审计记录不存在');
      return { previewId: prior.id, actionType: prior.actionType, riskLevel: prior.riskLevel, command: prior.normalizedCommandJson,
        display: prior.displayJson, resourceVersions: prior.resourceVersionsJson,
        expiresAt: prior.expiresAt.toISOString(), auditEventId: audit.id };
    }
  }

  async confirmStructuredBusinessPreview(
    previewId: string,
    actor: AuthenticatedActor,
    idempotencyKey: string,
  ) {
    const manualTransactions = this.manualTransactions;
    const payrollService = this.payroll;
    const periods = this.periods;
    if (!manualTransactions || !payrollService || !periods) throw new ConflictException('结构化业务操作服务未配置');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      const supported: StructuredBusinessAction[] = ['manual-transaction.create', 'payroll.generate', 'payroll.pay', 'payroll.adjust', 'payroll.cancel-payment', 'ledger-entry.reversal', 'period.close', 'period.reopen'];
      if (!preview || !supported.includes(preview.actionType as StructuredBusinessAction)) throw new NotFoundException('结构化业务预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的结构化业务预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认该业务操作');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as { idempotencyKey?: string } | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('结构化业务预览已不能确认');
      if (preview.expiresAt <= new Date()) throw new ConflictException('结构化业务预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as Record<string, unknown>;
      const versions = preview.resourceVersionsJson as Record<string, unknown>;
      let receipt: Record<string, unknown>;
      try {
        if (preview.actionType === 'manual-transaction.create') {
          const kind = enumText(command, 'kind', Object.values(ManualTransactionKind));
          const amount = commandAmount(command, 'amount');
          const channel = enumText(command, 'channel', Object.values(PaymentChannel));
          const occurredAt = commandDateTime(command, 'occurredAt');
          const note = typeof command.note === 'string' ? command.note || undefined : undefined;
          const incomeCategory = command.incomeCategory === undefined ? undefined : enumText(command, 'incomeCategory', Object.values(ManualIncomeCategory));
          const expenseCategory = command.expenseCategory === undefined ? undefined : enumText(command, 'expenseCategory', Object.values(ManualExpenseCategory));
          const record = await manualTransactions.createInTransaction(tx, {
            kind, amount, channel, occurredAt, createdById: actor.id,
            ...(incomeCategory ? { incomeCategory } : {}), ...(expenseCategory ? { expenseCategory } : {}), ...(note ? { note } : {}),
          });
          receipt = { actionType: preview.actionType, manualTransactionId: record.id, kind, amount: amount.toFixed(2), occurredAt: occurredAt.toISOString(), idempotencyKey, executedAt: new Date().toISOString() };
        } else if (preview.actionType === 'payroll.generate') {
          const teacherId = commandText(command, 'teacherId');
          const period = commandBusinessMonth(command);
          const payroll = await payrollService.generateInTransaction(tx, { teacherId, periodStart: period.date, actorId: actor.id }, {
            teacherUpdatedAt: new Date(String(versions.teacherUpdatedAt)),
            courseRevenue: new Prisma.Decimal(String(versions.courseRevenue)),
          });
          receipt = { actionType: preview.actionType, payrollId: payroll.id, teacherId, period: period.value, netSalary: payroll.netSalary.toFixed(2), idempotencyKey, executedAt: new Date().toISOString() };
        } else if (preview.actionType === 'payroll.pay') {
          const payrollId = commandText(command, 'payrollId');
          const paidAt = commandDateTime(command, 'paidAt');
          const channel = enumText(command, 'channel', Object.values(PaymentChannel));
          const note = typeof command.note === 'string' ? command.note || undefined : undefined;
          const payroll = await payrollService.payInTransaction(tx, payrollId, { paidAt, channel, ...(note ? { note } : {}), actorId: actor.id }, Number(versions.payrollVersion));
          receipt = { actionType: preview.actionType, payrollId: payroll.id, status: payroll.status, paidAt: paidAt.toISOString(), channel, idempotencyKey, executedAt: new Date().toISOString() };
        } else if (preview.actionType === 'payroll.adjust') {
          const payrollId = commandText(command, 'payrollId');
          const baseSalary = command.baseSalary === undefined ? undefined : commandNonNegativeAmount(command, 'baseSalary');
          const commissionRate = command.commissionRate === undefined ? undefined : commandDecimal(command, 'commissionRate', 4);
          const bonusAmount = command.bonusAmount === undefined ? undefined : commandNonNegativeAmount(command, 'bonusAmount');
          const deductionAmount = command.deductionAmount === undefined ? undefined : commandNonNegativeAmount(command, 'deductionAmount');
          const bonusNote = typeof command.bonusNote === 'string' ? command.bonusNote || undefined : undefined;
          const deductionNote = typeof command.deductionNote === 'string' ? command.deductionNote || undefined : undefined;
          const payroll = await payrollService.adjustInTransaction(tx, payrollId, {
            ...(baseSalary ? { baseSalary } : {}), ...(commissionRate ? { commissionRate } : {}),
            ...(bonusAmount ? { bonusAmount } : {}), ...(deductionAmount ? { deductionAmount } : {}),
            ...(command.bonusAmount !== undefined ? { bonusNote } : {}), ...(command.deductionAmount !== undefined ? { deductionNote } : {}),
            actorId: actor.id,
          }, Number(versions.payrollVersion));
          const display = preview.displayJson as Record<string, unknown>;
          receipt = {
            actionType: preview.actionType, payrollId: payroll.id, status: payroll.status,
            beforeBaseSalary: display.beforeBaseSalary, afterBaseSalary: payroll.baseSalary.toFixed(2),
            beforeCommissionRate: display.beforeCommissionRate, afterCommissionRate: payroll.commissionRate.toFixed(4),
            baseSalary: payroll.baseSalary.toFixed(2), commissionRate: payroll.commissionRate.toFixed(4),
            commissionAmount: payroll.commissionAmount.toFixed(2), bonusAmount: payroll.bonusAmount.toFixed(2),
            deductionAmount: payroll.deductionAmount.toFixed(2), grossSalary: payroll.grossSalary.toFixed(2),
            netSalary: payroll.netSalary.toFixed(2), idempotencyKey, executedAt: new Date().toISOString(),
          };
        } else if (preview.actionType === 'payroll.cancel-payment') {
          const payrollId = commandText(command, 'payrollId');
          const reason = commandText(command, 'reason');
          const note = optionalText(command, 'note') ?? undefined;
          const payroll = await payrollService.cancelPaymentInTransaction(tx, payrollId, {
            actorId: actor.id, expectedVersion: Number(versions.payrollVersion), note: note ? `${reason}；${note}` : reason,
          });
          receipt = { actionType: preview.actionType, payrollId: payroll.id, teacherId: payroll.teacherId, status: payroll.status, reason, idempotencyKey, executedAt: new Date().toISOString() };
        } else if (preview.actionType === 'ledger-entry.reversal') {
          const entryId = commandText(command, 'entryId');
          const reason = commandText(command, 'reason');
          const note = optionalText(command, 'note') ?? undefined;
          const balance = await this.ledger.reverseEntryInTransaction(tx, {
            entryId, accountVersion: Number(versions.accountVersion), occurredAt: commandDateTime(command, 'occurredAt'),
            createdById: actor.id, commandId: idempotencyKey, note: note ? `${reason}；${note}` : reason,
          });
          receipt = { actionType: preview.actionType, entryId, accountId: balance.accountId, paidBalance: balance.paidBalance, giftBalance: balance.giftBalance, totalBalance: balance.totalBalance, reason, idempotencyKey, executedAt: new Date().toISOString() };
        } else if (preview.actionType === 'period.close') {
          const period = commandBusinessMonth(command);
          const closed = await periods.closeInTransaction(tx, period.date, actor.id);
          receipt = { actionType: preview.actionType, period: period.value, closedAt: closed.closedAt.toISOString(), idempotencyKey, executedAt: new Date().toISOString() };
        } else {
          const period = commandBusinessMonth(command);
          const reason = commandText(command, 'reason');
          const reopened = await periods.reopenInTransaction(tx, period.date, reason, actor.id);
          receipt = { actionType: preview.actionType, period: period.value, reopenedAt: reopened.reopenedAt?.toISOString() ?? null, reason, idempotencyKey, executedAt: new Date().toISOString() };
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new ConflictException('业务记录已存在，请重新预览');
        throw error;
      }
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: new Date() } });
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed', requestId: idempotencyKey,
        resourceType: preview.actionType, resourceId: previewId, detailJson: receipt as Prisma.InputJsonObject,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: { ...receipt, auditEventId: audit.id } };
    });
  }

  private async createLessonMutationPreview(actionType: LessonMutationAction, input: LessonMutationPreviewInput) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    const note = input.note?.trim() || undefined;
    const normalized = actionType === 'lesson.reschedule'
      ? await this.lessons.previewReschedule(input.lessonId, { startsAt: input.startsAt! }, actor)
      : actionType === 'lesson.cancel'
        ? await this.lessons.previewCancel(input.lessonId, note ? { note } : {}, actor)
        : actionType === 'lesson.complete'
          ? await this.lessons.previewComplete(input.lessonId, note ? { note } : {}, actor)
          : actionType === 'lesson.complete.reversal'
            ? await this.lessons.previewReverseCompletion(input.lessonId, note ? { note } : {}, actor)
            : await this.lessons.previewCompletionCorrection(input.lessonId, {
              correctedUnitPrice: input.correctedUnitPrice!,
              ...(note ? { note } : {}),
            }, actor);
    const command = this.jsonSafe(normalized.normalizedCommand) as Prisma.InputJsonObject;
    const display = this.jsonSafe(normalized.display) as Prisma.InputJsonObject;
    const resourceVersions = this.jsonSafe(normalized.resourceVersions) as Prisma.InputJsonObject;
    const riskLevel = actionType === 'lesson.complete' || actionType === 'lesson.complete.reversal' || actionType === 'lesson.complete.correction'
      ? PreviewRiskLevel.L2
      : PreviewRiskLevel.L1;
    const projected = this.projectLessonMutationPreview(actor, actionType, display, resourceVersions);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId, actionType, schemaVersion: `${actionType}.v1`, riskLevel,
          normalizedCommandJson: command, displayJson: display, resourceVersionsJson: resourceVersions,
          idempotencyKey, status: PreviewStatus.PENDING, expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id, eventType: 'assistant.preview.created', requestId,
          resourceType: 'lesson', resourceId: input.lessonId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1`, lessonId: input.lessonId },
        } });
        return { preview, audit };
      });
      return { previewId: created.preview.id, actionType: created.preview.actionType, riskLevel: created.preview.riskLevel,
        command: created.preview.normalizedCommandJson, display: projected.display,
        resourceVersions: projected.resourceVersions, expiresAt: created.preview.expiresAt.toISOString(),
        auditEventId: created.audit.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType ||
        JSON.stringify(prior.normalizedCommandJson) !== JSON.stringify(command)) {
        throw new ConflictException('幂等键已用于不同的课程操作预览');
      }
      const priorProjection = this.projectLessonMutationPreview(actor, actionType, prior.displayJson, prior.resourceVersionsJson);
      return { previewId: prior.id, actionType: prior.actionType, riskLevel: prior.riskLevel,
        command: prior.normalizedCommandJson, display: priorProjection.display,
        resourceVersions: priorProjection.resourceVersions, expiresAt: prior.expiresAt.toISOString() };
    }
  }

  async confirmLessonMutationPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      const supported: LessonMutationAction[] = ['lesson.reschedule', 'lesson.cancel', 'lesson.complete', 'lesson.complete.reversal', 'lesson.complete.correction'];
      if (!preview || !supported.includes(preview.actionType as LessonMutationAction)) throw new NotFoundException('课程操作预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的课程操作预览');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as Record<string, unknown> | null;
        const projectedReceipt = receipt ? this.projectLessonMutationReceipt(actor, preview.actionType, receipt) : null;
        if (receipt?.['idempotencyKey'] !== idempotencyKey) throw new ConflictException('课程操作预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: projectedReceipt ? { ...projectedReceipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('课程操作预览已不能确认');
      if ((preview.actionType === 'lesson.complete' || preview.actionType === 'lesson.complete.reversal' || preview.actionType === 'lesson.complete.correction') && preview.riskLevel !== PreviewRiskLevel.L2) {
        throw new ConflictException('课程操作预览风险级别已失效，请重新预览');
      }
      const now = new Date();
      if (preview.expiresAt <= now) throw new ConflictException('课程操作预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as {
        lessonId: string; startsAt?: string; endsAt?: string; correctedUnitPrice?: string; note: string | null;
      };
      const versions = preview.resourceVersionsJson as unknown as LessonMutationVersions & { courseDurationMinutes?: number };
      let lesson;
      if (preview.actionType === 'lesson.reschedule') {
        lesson = await this.lessons.rescheduleInTransaction(tx, command.lessonId,
          { startsAt: new Date(command.startsAt!) }, actor, {
            lessonVersion: versions.lessonVersion, accountVersion: versions.accountVersion!,
            courseDurationMinutes: versions.courseDurationMinutes!, endsAt: new Date(command.endsAt!),
          });
      } else if (preview.actionType === 'lesson.cancel') {
        lesson = await this.lessons.cancelInTransaction(tx, command.lessonId,
          command.note ? { note: command.note } : {}, actor,
          { lessonVersion: versions.lessonVersion, accountVersion: versions.accountVersion! });
      } else if (preview.actionType === 'lesson.complete') {
        lesson = await this.lessons.completeInTransaction(tx, command.lessonId,
          { commandId: idempotencyKey, ...(command.note ? { note: command.note } : {}) }, actor, versions);
      } else if (preview.actionType === 'lesson.complete.reversal') {
        lesson = await this.lessons.reverseCompletionInTransaction(tx, command.lessonId,
          { commandId: idempotencyKey, ...(command.note ? { note: command.note } : {}) }, actor, versions);
      } else {
        lesson = await this.lessons.correctCompletionAmountInTransaction(tx, command.lessonId, {
          commandId: idempotencyKey,
          correctedUnitPrice: new Prisma.Decimal(command.correctedUnitPrice!),
          ...(command.note ? { note: command.note } : {}),
        }, actor, versions as LessonConsumptionCorrectionVersions);
      }
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = {
        actionType: preview.actionType, lessonId: lesson.id, status: lesson.status,
        startsAt: lesson.startsAt.toISOString(), endsAt: lesson.endsAt.toISOString(),
        ...(lesson.completedAt ? { completedAt: lesson.completedAt.toISOString() } : {}),
        ...(lesson.unitPriceSnapshot ? { unitPriceSnapshot: lesson.unitPriceSnapshot } : {}),
        ...(preview.actionType === 'lesson.complete.correction' ? { correctedUnitPrice: lesson.unitPriceSnapshot ?? null } : {}),
        idempotencyKey, executedAt: now.toISOString(),
      };
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed', requestId: idempotencyKey,
        resourceType: 'lesson', resourceId: lesson.id, detailJson: receipt,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: {
        ...this.projectLessonMutationReceipt(actor, preview.actionType, receipt), auditEventId: audit.id,
      } };
    });
  }

  private projectLessonMutationPreview(
    actor: AuthenticatedActor,
    actionType: LessonMutationAction,
    display: unknown,
    resourceVersions: unknown,
  ): { display: Prisma.InputJsonObject; resourceVersions: Prisma.InputJsonObject } {
    if (actor.role !== 'TEACHER' || (actionType !== 'lesson.complete' && actionType !== 'lesson.complete.reversal')) {
      return { display: display as Prisma.InputJsonObject, resourceVersions: resourceVersions as Prisma.InputJsonObject };
    }
    return {
      display: projectScalarFields(display, TEACHER_COMPLETION_DISPLAY_FIELDS),
      resourceVersions: projectScalarFields(resourceVersions, TEACHER_COMPLETION_RESOURCE_VERSION_FIELDS),
    };
  }

  private projectLessonMutationReceipt(
    actor: AuthenticatedActor,
    actionType: string,
    receipt: Record<string, unknown>,
  ): Record<string, unknown> {
    if (actor.role !== 'TEACHER' || (actionType !== 'lesson.complete' && actionType !== 'lesson.complete.reversal')) {
      return receipt;
    }
    return projectScalarFields(receipt, TEACHER_COMPLETION_RECEIPT_FIELDS) as Record<string, unknown>;
  }

  async getPreview(previewId: string, actor: AuthenticatedActor) {
    const currentActor = await this.loadActor(actor.id);
    return this.prisma.$transaction(async (tx) => {
      let preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview) throw new NotFoundException('预览不存在');
      if (preview.actorUserId !== currentActor.id) throw new ForbiddenException('不能查看其他用户的预览');
      if (currentActor.role !== 'OWNER' && OWNER_ONLY_PREVIEW_ACTIONS.has(preview.actionType)) {
        throw new ForbiddenException('无权查看该业务预览');
      }
      if (currentActor.role === 'TEACHER' && LESSON_MUTATION_ACTIONS.has(preview.actionType as LessonMutationAction)) {
        await this.assertCurrentTeacherOwnsLesson(tx, preview.normalizedCommandJson, currentActor);
      }
      if(preview.status===PreviewStatus.PENDING&&preview.actionType==='student.final-refund'){
        const versions=preview.resourceVersionsJson as unknown as {studentId?:unknown;studentUpdatedAt?:unknown;accountVersions?:unknown};
        const accountVersions=Array.isArray(versions.accountVersions)?versions.accountVersions as Array<{accountId?:unknown;version?:unknown}>:[];
        const studentId=typeof versions.studentId==='string'?versions.studentId:null;
        const student=studentId?await tx.student.findUnique({where:{id:studentId},select:{updatedAt:true}}):null;
        const accounts=studentId?await tx.studentCourseAccount.findMany({where:{studentId},select:{id:true,version:true}}):[];
        const expectedAccounts=new Map(accountVersions.flatMap(item=>typeof item.accountId==='string'&&typeof item.version==='number'?[[item.accountId,item.version] as const]:[]));
        const stale=!student||typeof versions.studentUpdatedAt!=='string'||student.updatedAt.toISOString()!==versions.studentUpdatedAt
          ||accounts.length!==expectedAccounts.size||accounts.some(account=>expectedAccounts.get(account.id)!==account.version);
        if(stale){
          const updated=await tx.actionPreview.update({where:{id:preview.id},data:{status:PreviewStatus.STALE}});
          await tx.businessAuditEvent.create({data:{actorUserId:currentActor.id,previewId:preview.id,eventType:'assistant.preview.stale',requestId:`stale:${preview.id}`,resourceType:preview.actionType,resourceId:preview.id,detailJson:{reason:'退款相关余额或学生状态已变化'}}});
          preview=updated;
        }
      }

      const createdEvent = await tx.businessAuditEvent.findFirst({
        where: { previewId, eventType: 'assistant.preview.created' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const confirmedEvent = await tx.businessAuditEvent.findFirst({
        where: { previewId, eventType: 'assistant.preview.confirmed' },
        orderBy: { createdAt: 'asc' },
      });
      const isLessonMutation = (['lesson.reschedule', 'lesson.cancel', 'lesson.complete', 'lesson.complete.reversal', 'lesson.complete.correction'] as string[])
        .includes(preview.actionType);
      const projection = isLessonMutation
        ? this.projectLessonMutationPreview(currentActor, preview.actionType as LessonMutationAction, preview.displayJson, preview.resourceVersionsJson)
        : { display: preview.displayJson, resourceVersions: preview.resourceVersionsJson };
      const receipt = confirmedEvent?.detailJson as Record<string, unknown> | undefined;
      const projectedReceipt = receipt && isLessonMutation
        ? this.projectLessonMutationReceipt(currentActor, preview.actionType, receipt)
        : receipt ?? null;

      return {
        previewId: preview.id,
        actionType: preview.actionType,
        schemaVersion: preview.schemaVersion,
        riskLevel: this.authoritativeRiskLevel(preview.actionType, preview.riskLevel),
        status: preview.status,
        command: preview.normalizedCommandJson,
        display: projection.display,
        resourceVersions: projection.resourceVersions,
        expiresAt: preview.expiresAt.toISOString(),
        createdAt: preview.createdAt.toISOString(),
        updatedAt: preview.updatedAt.toISOString(),
        auditEventId: createdEvent?.id ?? null,
        receipt: projectedReceipt ? { ...projectedReceipt, auditEventId: confirmedEvent?.id } : null,
      };
    });
  }

  async getPreviewForUser(previewId: string, actorUserId: string) {
    return this.getPreview(previewId, await this.loadActor(actorUserId));
  }

  private authoritativeRiskLevel(actionType: string, persistedRiskLevel: PreviewRiskLevel): PreviewRiskLevel {
    return actionType === 'lesson.complete' || actionType === 'lesson.complete.reversal' || actionType === 'lesson.complete.correction' || OWNER_ONLY_PREVIEW_ACTIONS.has(actionType)
      ? PreviewRiskLevel.L2
      : persistedRiskLevel;
  }

  private async assertCurrentTeacherOwnsLesson(
    tx: Pick<PrismaService, 'lesson'>,
    normalizedCommand: unknown,
    actor: AuthenticatedActor,
  ): Promise<void> {
    const command = normalizedCommand as Record<string, unknown>;
    const lessonId = typeof command.lessonId === 'string' ? command.lessonId : undefined;
    if (!lessonId) throw new ConflictException('课程操作预览快照无效，请重新预览');
    const lesson = await tx.lesson.findUnique({ where: { id: lessonId }, select: { teacherId: true } });
    if (!lesson || actor.teacherId !== lesson.teacherId) {
      throw new ForbiddenException('无权查看其他教师的课程预览');
    }
  }

  async invalidatePreview(previewId: string, actorUserId: string, reason: string, requestId = previewId) {
    const normalizedReason = requireText(reason, 'reason');
    const normalizedRequestId = requireText(requestId, 'requestId');
    await this.loadActor(actorUserId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview) throw new NotFoundException('预览不存在');
      if (preview.actorUserId !== actorUserId) throw new ForbiddenException('不能失效其他用户的预览');
      if (preview.status === PreviewStatus.EXECUTED) throw new ConflictException('已执行的预览不能失效');
      if (preview.status === PreviewStatus.STALE || preview.status === PreviewStatus.CANCELLED) {
        return { previewId, status: preview.status };
      }

      const updated = await tx.actionPreview.update({
        where: { id: previewId },
        data: { status: PreviewStatus.CANCELLED },
      });
      await tx.businessAuditEvent.create({
        data: {
          actorUserId,
          previewId,
          eventType: 'assistant.preview.invalidated',
          requestId: normalizedRequestId,
          resourceType: 'action-preview',
          resourceId: previewId,
          detailJson: { reason: normalizedReason, status: updated.status },
        },
      });
      return { previewId: updated.id, status: updated.status };
    });
  }

  private jsonSafe(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.jsonSafe(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.jsonSafe(item)]));
    }
    return value;
  }

  async confirmFinalRefundPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    if (!this.refunds) throw new ConflictException('退学退款执行服务未配置');
    const refunds = this.refunds;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'student.final-refund') throw new NotFoundException('最终退学退款预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的退款预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('仅店主可确认退学退款');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as { idempotencyKey?: string } | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('退款预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('退款预览已不能确认');
      if (preview.expiresAt <= new Date()) throw new ConflictException('退款预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as {
        studentId: string; feeAmount: string; channel: PaymentChannel; occurredAt: string; note: string | null;
      };
      const versions = preview.resourceVersionsJson as unknown as {
        studentId: string; studentUpdatedAt: string; accountVersions: Array<{ accountId: string; version: number }>;
      };
      if (versions.studentId !== command.studentId) throw new ConflictException('退款预览学生快照无效');
      const lockedStudent = await tx.$queryRaw<Array<{ id: string; updatedAt: Date }>>`
        SELECT "id", "updatedAt" FROM "Student" WHERE "id" = ${command.studentId} FOR UPDATE
      `;
      if (lockedStudent.length !== 1 || lockedStudent[0]!.updatedAt.toISOString() !== versions.studentUpdatedAt) {
        throw new ConflictException('学生资料已变化，请重新预览');
      }
      const lockedAccounts = await tx.$queryRaw<Array<{ id: string; version: number }>>`
        SELECT "id", "version" FROM "StudentCourseAccount" WHERE "studentId" = ${command.studentId} ORDER BY "id" FOR UPDATE
      `;
      if (lockedAccounts.length !== versions.accountVersions.length || lockedAccounts.some((account, index) => {
        const expected = versions.accountVersions[index];
        return !expected || expected.accountId !== account.id || expected.version !== account.version;
      })) {
        throw new ConflictException('课程账户余额已变化，请重新预览');
      }
      const refund = await refunds.refundInTransaction(tx, {
        studentId: command.studentId,
        feeAmount: command.feeAmount,
        channel: command.channel,
        occurredAt: new Date(command.occurredAt),
        ...(command.note ? { note: command.note } : {}),
        commandId: idempotencyKey,
      }, actor);
      const now = new Date();
      await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = {
        actionType: preview.actionType,
        refundId: refund.id,
        studentId: refund.studentId,
        totalPaidRefund: refund.totalPaidRefund,
        feeAmount: refund.feeAmount,
        feePercentage: refund.feePercentage,
        actualRefundAmount: refund.actualRefundAmount,
        courses: refund.details,
        studentStatus: '退学',
        idempotencyKey,
        executedAt: now.toISOString(),
      } satisfies Prisma.InputJsonObject;
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'refund', resourceId: refund.id,
        detailJson: receipt,
      } });
      return { previewId, status: PreviewStatus.EXECUTED, receipt: { ...receipt, auditEventId: audit.id } };
    });
  }

  async createBatchLessonPreview(input: CreateBatchLessonsInput & {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
  }) {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    const batch = await this.lessons.previewBatch(input, actor);
    const actionType = 'lesson.schedule.weekly-batch';
    const normalizedCommand = {
      ...batch.normalizedCommand,
      firstStartsAt: batch.normalizedCommand.firstStartsAt.toISOString(),
      note: batch.normalizedCommand.note ?? null,
    };
    const resourceVersions = {
      ...batch.resourceVersions,
      teacherUpdatedAt: batch.resourceVersions.teacherUpdatedAt.toISOString(),
    };
    const display = {
      title: '每周批量排课',
      summary: `每周一节，共 ${batch.lessons.length} 节${batch.conflicts.length ? `，发现 ${batch.conflicts.length} 项时间冲突` : ''}`,
      lessons: batch.lessons.map((lesson, index) => ({
        week: index + 1,
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
      })),
      conflicts: batch.conflicts,
    };
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType,
          schemaVersion: `${actionType}.v1`,
          riskLevel: PreviewRiskLevel.L1,
          normalizedCommandJson: normalizedCommand as unknown as Prisma.InputJsonObject,
          displayJson: display as unknown as Prisma.InputJsonObject,
          resourceVersionsJson: resourceVersions as unknown as Prisma.InputJsonObject,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId, previewId: preview.id, eventType: 'assistant.preview.created', requestId,
          resourceType: 'lesson-batch', resourceId: input.accountId,
          detailJson: { actionType, schemaVersion: `${actionType}.v1`, weeks: input.weeks, conflictCount: batch.conflicts.length },
        } });
        return { preview, audit };
      });
      return { previewId: created.preview.id, actionType: created.preview.actionType, riskLevel: created.preview.riskLevel,
        command: created.preview.normalizedCommandJson, display: created.preview.displayJson,
        resourceVersions: created.preview.resourceVersionsJson,
        expiresAt: created.preview.expiresAt.toISOString(), auditEventId: created.audit.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== actionType) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const command = prior.normalizedCommandJson as { accountId?: string; teacherId?: string; firstStartsAt?: string; weeks?: number; note?: string | null };
      if (command.accountId !== normalizedCommand.accountId || command.teacherId !== normalizedCommand.teacherId ||
        command.firstStartsAt !== normalizedCommand.firstStartsAt || command.weeks !== normalizedCommand.weeks ||
        (command.note ?? null) !== normalizedCommand.note) {
        throw new ConflictException('幂等键已用于不同的批量排课请求');
      }
      const audit = await this.prisma.businessAuditEvent.findFirst({
        where: { previewId: prior.id, eventType: 'assistant.preview.created' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!audit) throw new ConflictException('幂等预览审计记录不存在');
      return { previewId: prior.id, actionType: prior.actionType, riskLevel: prior.riskLevel, command: prior.normalizedCommandJson,
        display: prior.displayJson, resourceVersions: prior.resourceVersionsJson, expiresAt: prior.expiresAt.toISOString(), auditEventId: audit.id };
    }
  }

  async confirmBatchLessonPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'lesson.schedule.weekly-batch') throw new NotFoundException('批量排课预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的排课预览');
      if (actor.role !== 'OWNER') throw new ForbiddenException('只有店主可以批量排课');
      if (preview.status === PreviewStatus.EXECUTED) {
        const event = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const receipt = event?.detailJson as { idempotencyKey?: string; lessonIds?: string[] } | null;
        if (receipt?.idempotencyKey !== idempotencyKey) throw new ConflictException('批量排课预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: receipt ? { ...receipt, auditEventId: event?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('批量排课预览已不能确认');
      const now = new Date();
      if (preview.expiresAt <= now) throw new ConflictException('批量排课预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as CreateBatchLessonsInput & { firstStartsAt: string; note: string | null };
      const versions = preview.resourceVersionsJson as unknown as {
        accountId: string; accountVersion: number; teacherId: string; teacherUpdatedAt: string;
      };
      const lessons = await this.lessons.createBatchInTransaction(tx, {
        ...command,
        firstStartsAt: new Date(command.firstStartsAt),
        ...(command.note ? { note: command.note } : {}),
      }, actor, {
        ...versions,
        teacherUpdatedAt: new Date(versions.teacherUpdatedAt),
      });
      const updated = await tx.actionPreview.update({ where: { id: previewId }, data: { status: PreviewStatus.EXECUTED, executedAt: now } });
      const receipt = { actionType: preview.actionType, lessonIds: lessons.map(({ id }) => id), count: lessons.length,
        idempotencyKey, executedAt: now.toISOString() };
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed', requestId: idempotencyKey,
        resourceType: 'lesson-batch', resourceId: preview.id, detailJson: receipt,
      } });
      return { previewId: updated.id, status: updated.status, receipt: { ...receipt, auditEventId: audit.id } };
    });
  }

  async createSingleLessonPreview(input: CreateSingleLessonInput & {
    actorUserId: string; runId: string; requestId: string; idempotencyKey: string;
  }): Promise<{ previewId: string; actionType: string; riskLevel: PreviewRiskLevel; command: Prisma.JsonValue; display: Prisma.JsonValue; expiresAt: string }> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const actor = await this.loadActor(actorUserId);
    const normalized = await this.lessons.previewSingle(input, actor);
    const [account, teacher] = await Promise.all([
      this.prisma.studentCourseAccount.findUnique({
        where: { id: normalized.normalizedCommand.accountId },
        select: { student: { select: { name: true } }, course: { select: { name: true } } },
      }),
      this.prisma.teacher.findUnique({
        where: { id: normalized.normalizedCommand.teacherId },
        select: { name: true },
      }),
    ]);
    if (!account) throw new NotFoundException('学生课程账户不存在');
    if (!teacher) throw new NotFoundException('授课教师不存在');
    const startsAt = normalized.normalizedCommand.startsAt.toISOString();
    const endsAt = normalized.normalizedCommand.endsAt.toISOString();
    const display = {
      title: '单节排课',
      summary: `${account.student.name} · ${account.course.name} · ${teacher.name}，请核对上课时间。`,
      studentName: account.student.name,
      courseName: account.course.name,
      teacherName: teacher.name,
      startsAt,
      endsAt,
    };
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({ data: {
          actorUserId,
          actionType: 'lesson.schedule.single',
          schemaVersion: 'lesson.schedule.single.v1',
          riskLevel: PreviewRiskLevel.L1,
          normalizedCommandJson: {
            ...normalized.normalizedCommand,
            startsAt: normalized.normalizedCommand.startsAt.toISOString(),
            endsAt: normalized.normalizedCommand.endsAt.toISOString(),
          } as unknown as Prisma.InputJsonObject,
          displayJson: display as Prisma.InputJsonObject,
          resourceVersionsJson: {
            ...normalized.resourceVersions,
            conflicts: normalized.resourceVersions.conflicts.map((conflict) => ({
              ...conflict,
              startsAt: conflict.startsAt.toISOString(),
              endsAt: conflict.endsAt.toISOString(),
            })),
          } as unknown as Prisma.InputJsonObject,
          idempotencyKey,
          status: PreviewStatus.PENDING,
          expiresAt,
        } });
        const audit = await tx.businessAuditEvent.create({ data: {
          actorUserId, runId: input.runId, previewId: preview.id,
          eventType: 'assistant.preview.created', requestId: input.requestId,
          resourceType: 'lesson', resourceId: input.accountId,
          detailJson: { actionType: 'lesson.schedule.single', schemaVersion: 'lesson.schedule.single.v1' },
        } });
        return { preview, audit };
      });
      return { previewId: result.preview.id, actionType: result.preview.actionType, riskLevel: result.preview.riskLevel,
        command: result.preview.normalizedCommandJson, display: result.preview.displayJson,
        expiresAt: result.preview.expiresAt.toISOString() };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const prior = await this.prisma.actionPreview.findUnique({ where: { idempotencyKey } });
      if (!prior || prior.actorUserId !== actorUserId || prior.actionType !== 'lesson.schedule.single') {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      const priorCommand = prior.normalizedCommandJson as { accountId?: string; teacherId?: string; startsAt?: string; note?: string | null };
      if (priorCommand.accountId !== normalized.normalizedCommand.accountId ||
        priorCommand.teacherId !== normalized.normalizedCommand.teacherId ||
        priorCommand.startsAt !== normalized.normalizedCommand.startsAt.toISOString() ||
        (priorCommand.note ?? null) !== (normalized.normalizedCommand.note ?? null)) {
        throw new ConflictException('幂等键已用于不同的排课请求');
      }
      return { previewId: prior.id, actionType: prior.actionType, riskLevel: prior.riskLevel,
        command: prior.normalizedCommandJson, display: prior.displayJson,
        expiresAt: prior.expiresAt.toISOString() };
    }
  }

  async confirmSingleLessonPreview(previewId: string, actor: AuthenticatedActor, idempotencyKey: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ActionPreview" WHERE "id" = ${previewId} FOR UPDATE`;
      const preview = await tx.actionPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actionType !== 'lesson.schedule.single') throw new NotFoundException('排课预览不存在');
      if (preview.actorUserId !== actor.id) throw new ForbiddenException('不能确认其他用户的排课预览');
      if (preview.status === PreviewStatus.EXECUTED) {
        const receipt = await tx.businessAuditEvent.findFirst({ where: { previewId, eventType: 'assistant.preview.confirmed' } });
        const detail = receipt?.detailJson as { idempotencyKey?: string; lessonId?: string; executedAt?: string } | null;
        if (detail?.idempotencyKey !== idempotencyKey) throw new ConflictException('排课预览已由其他确认请求执行');
        return { previewId, status: preview.status, receipt: detail ? { ...detail, auditEventId: receipt?.id } : null };
      }
      if (preview.status !== PreviewStatus.PENDING) throw new ConflictException('排课预览已不能确认');
      if (preview.expiresAt <= new Date()) throw new ConflictException('排课预览已过期，请重新预览');
      const command = preview.normalizedCommandJson as unknown as CreateSingleLessonInput & { endsAt: string };
      const snapshot = preview.resourceVersionsJson as unknown as {
        accountId: string; accountVersion: number; teacherId: string;
        conflicts: Array<{ id: string; version: number; startsAt: string; endsAt: string }>;
      };
      if (actor.role === 'TEACHER' && actor.teacherId !== command.teacherId) throw new ForbiddenException('不能为其他教师确认排课');
      const startsAt = new Date(command.startsAt);
      const endsAt = new Date(command.endsAt);
      const lesson = await this.lessons.createSingleInTransaction(tx, {
        ...command, startsAt, endsAt,
      }, actor, { ...snapshot, conflicts: snapshot.conflicts.map((conflict) => ({
        ...conflict, startsAt: new Date(conflict.startsAt), endsAt: new Date(conflict.endsAt),
      })) });
      const now = new Date();
      const updated = await tx.actionPreview.update({ where: { id: previewId }, data: {
        status: PreviewStatus.EXECUTED, executedAt: now,
      } });
      const audit = await tx.businessAuditEvent.create({ data: {
        actorUserId: actor.id, previewId, eventType: 'assistant.preview.confirmed',
        requestId: idempotencyKey, resourceType: 'lesson', resourceId: lesson.id,
        detailJson: { lessonId: lesson.id, idempotencyKey, executedAt: now.toISOString() },
      } });
      return { previewId: updated.id, status: updated.status, receipt: {
        lessonId: lesson.id, auditEventId: audit.id, idempotencyKey, executedAt: now.toISOString(),
      } };
    });
  }

  private async loadActor(userId: string): Promise<AuthenticatedActor> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: {
      id: true, username: true, role: true, isActive: true, teacher: { select: { id: true, isActive: true } },
    } });
    if (!user?.isActive) throw new ForbiddenException('Capability 用户不可用');
    if (user.role === 'TEACHER' && (!user.teacher?.isActive)) throw new ForbiddenException('教师账号不可用');
    return { id: user.id, username: user.username, role: user.role, ...(user.teacher ? { teacherId: user.teacher.id } : {}) };
  }

  private async loadOwner(userId: string, operation: string): Promise<AuthenticatedActor> {
    const actor = await this.loadActor(userId);
    if (actor.role !== 'OWNER') throw new ForbiddenException(`仅店主可预览${operation}`);
    return actor;
  }

  async createTechnicalSpikePreview(
    input: CreateTechnicalPreviewInput,
  ): Promise<TechnicalPreviewResponse> {
    const actorUserId = requireText(input.actorUserId, 'actorUserId');
    const runId = requireText(input.runId, 'runId');
    const requestId = requireText(input.requestId, 'requestId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const preview = await tx.actionPreview.create({
          data: {
            actorUserId,
            actionType: TECHNICAL_SPIKE_ACTION_TYPE,
            schemaVersion: TECHNICAL_SPIKE_SCHEMA_VERSION,
            riskLevel: PreviewRiskLevel.L1,
            normalizedCommandJson: TECHNICAL_SPIKE_COMMAND,
            displayJson: TECHNICAL_SPIKE_DISPLAY,
            resourceVersionsJson: TECHNICAL_SPIKE_RESOURCES,
            idempotencyKey,
            status: PreviewStatus.PENDING,
            expiresAt: new Date(
              (input.now ?? new Date()).getTime() + TECHNICAL_SPIKE_TTL_MS,
            ),
          },
        });

        const auditEvent = await tx.businessAuditEvent.create({
          data: {
            actorUserId,
            runId,
            previewId: preview.id,
            eventType: TECHNICAL_SPIKE_EVENT_TYPE,
            requestId,
            detailJson: {
              actionType: TECHNICAL_SPIKE_ACTION_TYPE,
              technicalSpike: true,
              businessWrite: false,
            },
          },
        });

        return { preview, auditEvent } satisfies CreatedPreview;
      });

      return this.toResponse(created);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      // 只在数据库唯一约束冲突后读取；这里没有“先查再插”的竞态窗口。
      const original = await this.findByIdempotencyKey(idempotencyKey);
      if (!original) throw error;
      if (original.preview.actorUserId !== actorUserId) {
        throw new ConflictException('幂等键已被其他请求使用');
      }
      return this.toResponse(original);
    }
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<CreatedPreview | null> {
    return this.prisma.$transaction(async (tx) => {
      const preview = await tx.actionPreview.findUnique({
        where: { idempotencyKey },
      });
      if (!preview) return null;

      const auditEvent = await tx.businessAuditEvent.findFirst({
        where: { previewId: preview.id },
        orderBy: { createdAt: 'asc' },
      });
      if (!auditEvent) return null;
      return { preview, auditEvent } satisfies CreatedPreview;
    });
  }

  private toResponse(created: CreatedPreview): TechnicalPreviewResponse {
    const { preview, auditEvent } = created;
    return {
      preview: {
        id: preview.id,
        actorUserId: preview.actorUserId,
        actionType: preview.actionType,
        schemaVersion: preview.schemaVersion,
        riskLevel: preview.riskLevel,
        normalizedCommandJson: preview.normalizedCommandJson,
        displayJson: preview.displayJson,
        resourceVersionsJson: preview.resourceVersionsJson,
        idempotencyKey: preview.idempotencyKey,
        status: preview.status,
        expiresAt: preview.expiresAt.toISOString(),
        createdAt: preview.createdAt.toISOString(),
        updatedAt: preview.updatedAt.toISOString(),
      },
      auditEventId: auditEvent.id,
      technicalSpike: true,
      businessWrite: false,
    };
  }
}
