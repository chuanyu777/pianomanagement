import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LedgerEntryKind, LessonStatus, PayrollStatus } from '../../generated/prisma/client.js';
import type {
  CourseAccountRead,
  InternalCourseAccountLedgerEntry,
  InternalCourseAccountLedgerRead,
  InternalLesson,
  InternalLessonsRead,
  InternalMonthlyPayrollItem,
  InternalMonthlyPayrollRead,
  InternalMonthlyReportRead,
  InternalDirectoryRead,
  InternalArrearsAndFrozenRead,
  InternalMonthlyConsumptionRead,
  InternalPrecloseRead,
} from './internal-tools.service.js';

export class InternalDirectoryStudentResponse {
  @ApiProperty({ type: String, format: 'uuid' }) studentId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ enum: ['STUDYING', 'FROZEN', 'WITHDRAWN'] }) enrollmentStatus!: 'STUDYING' | 'FROZEN' | 'WITHDRAWN';
}
export class InternalDirectoryTeacherResponse {
  @ApiProperty({ type: String, format: 'uuid' }) teacherId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Boolean }) isActive!: boolean;
}
export class InternalDirectoryCourseResponse {
  @ApiProperty({ type: String, format: 'uuid' }) courseId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, example: '200.00' }) defaultUnitPrice!: string;
  @ApiProperty({ type: Number, example: 60 }) defaultDurationMinutes!: number;
  @ApiProperty({ type: Boolean }) isActive!: boolean;
}
export class InternalDirectoryResponse implements InternalDirectoryRead {
  @ApiProperty({ type: InternalDirectoryStudentResponse, isArray: true }) students!: InternalDirectoryStudentResponse[];
  @ApiProperty({ type: InternalDirectoryTeacherResponse, isArray: true }) teachers!: InternalDirectoryTeacherResponse[];
  @ApiProperty({ type: InternalDirectoryCourseResponse, isArray: true }) courses!: InternalDirectoryCourseResponse[];
}

export class InternalArrearResponse {
  @ApiProperty({ type: String, format: 'uuid' }) studentId!: string;
  @ApiProperty({ type: String }) studentName!: string;
  @ApiProperty({ type: String, format: 'uuid' }) courseId!: string;
  @ApiProperty({ type: String }) courseName!: string;
  @ApiProperty({ type: String, example: '-10.00', description: '该课程账户实收余额，按课程独立判断欠费' }) paidBalance!: string;
}
export class InternalFrozenStudentResponse {
  @ApiProperty({ type: String, format: 'uuid' }) studentId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, example: '连续31天未完成课程' }) reason!: string;
}
export class InternalArrearsAndFrozenResponse implements InternalArrearsAndFrozenRead {
  @ApiProperty({ type: InternalArrearResponse, isArray: true }) arrears!: InternalArrearResponse[];
  @ApiProperty({ type: InternalFrozenStudentResponse, isArray: true }) frozenStudents!: InternalFrozenStudentResponse[];
}

export class InternalConsumptionGroupItemResponse {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, example: '150.00', description: '课消为正数，冲正按反向金额抵减' }) amount!: string;
}
export class InternalMonthlyConsumptionResponse implements InternalMonthlyConsumptionRead {
  @ApiProperty({ type: String, example: '2026-10' }) period!: string;
  @ApiProperty({ type: String, example: '480.00' }) totalAmount!: string;
  @ApiProperty({ type: InternalConsumptionGroupItemResponse, isArray: true }) courses!: InternalConsumptionGroupItemResponse[];
  @ApiProperty({ type: InternalConsumptionGroupItemResponse, isArray: true }) teachers!: InternalConsumptionGroupItemResponse[];
  @ApiProperty({ type: InternalConsumptionGroupItemResponse, isArray: true }) students!: InternalConsumptionGroupItemResponse[];
}

export class InternalPendingLessonResponse {
  @ApiProperty({ type: String, format: 'uuid' }) lessonId!: string;
  @ApiProperty({ type: String }) studentName!: string;
  @ApiProperty({ type: String }) courseName!: string;
  @ApiProperty({ type: String }) teacherName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endsAt!: string;
}
export class InternalRefundAnomalyResponse {
  @ApiProperty({ type: String, format: 'uuid' }) refundId!: string;
  @ApiProperty({ type: String }) studentName!: string;
  @ApiProperty({ type: String }) issue!: string;
}
export class InternalMissingPayrollTeacherResponse {
  @ApiProperty({ type: String, format: 'uuid' }) teacherId!: string;
  @ApiProperty({ type: String }) teacherName!: string;
}
export class InternalUnpaidPayrollResponse {
  @ApiProperty({ type: String, format: 'uuid' }) payrollId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) teacherId!: string;
  @ApiProperty({ type: String }) teacherName!: string;
  @ApiProperty({ type: String }) netSalary!: string;
}
export class InternalPrecloseBlockerResponse {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: Number }) count!: number;
  @ApiProperty({ type: String }) message!: string;
}
export class InternalLedgerAnomalyResponse {
  @ApiProperty({ type: String, format: 'uuid' }) entryId!: string;
  @ApiProperty({ type: String }) kind!: string;
  @ApiProperty({ type: String }) issue!: string;
}
export class InternalPrecloseReminderResponse {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean, enum: [true], description: '需人工判断，不表示该项阻断关账' }) requiresHumanJudgment!: true;
}
export class InternalPeriodPrecloseResponse implements InternalPrecloseRead {
  @ApiProperty({ type: String, example: '2026-10' }) period!: string;
  @ApiProperty({ type: Boolean, description: '目标月当前是否处于已关账状态' }) closed!: boolean;
  @ApiProperty({ type: InternalPendingLessonResponse, isArray: true }) pendingLessons!: InternalPendingLessonResponse[];
  @ApiProperty({ type: InternalRefundAnomalyResponse, isArray: true }) refundAnomalies!: InternalRefundAnomalyResponse[];
  @ApiProperty({ type: InternalMissingPayrollTeacherResponse, isArray: true }) missingPayrollTeachers!: InternalMissingPayrollTeacherResponse[];
  @ApiProperty({ type: InternalUnpaidPayrollResponse, isArray: true }) unpaidPayrolls!: InternalUnpaidPayrollResponse[];
  @ApiProperty({ type: InternalLedgerAnomalyResponse, isArray: true }) ledgerAnomalies!: InternalLedgerAnomalyResponse[];
  @ApiProperty({ type: InternalPrecloseBlockerResponse, isArray: true }) blockers!: InternalPrecloseBlockerResponse[];
  @ApiProperty({ type: InternalPrecloseReminderResponse, isArray: true }) reminders!: InternalPrecloseReminderResponse[];
}

export class InternalPeriodQueryDto {
  @ApiProperty({ type: String, pattern: '^\\d{4}-(0[1-9]|1[0-2])$', example: '2026-10' })
  period!: string;
}

export class InternalMonthlyReportResponse implements InternalMonthlyReportRead {
  @ApiProperty({ type: String, example: '2026-10' })
  period!: string;

  @ApiProperty({ type: () => InternalMonthlyReportValuesResponse, description: '由 ReportsService.monthly 返回的确定性月报' })
  report!: InternalMonthlyReportRead['report'];
}

export class InternalMonthlyReportValuesResponse {
  @ApiProperty({ type: String, format: 'date-time' })
  periodStart!: string;

  @ApiProperty({ type: String, example: '1000.00' })
  cashIncome!: string;

  @ApiProperty({ type: String, example: '200.00' })
  cashExpense!: string;

  @ApiProperty({ type: String, example: '800.00' })
  cashNet!: string;

  @ApiProperty({ type: String, example: '900.00' })
  lessonIncome!: string;

  @ApiProperty({ type: String, example: '10.00' })
  refundFeeIncome!: string;

  @ApiProperty({ type: String, example: '100.00' })
  manualIncome!: string;

  @ApiProperty({ type: String, example: '300.00' })
  payrollCost!: string;

  @ApiProperty({ type: String, example: '20.00' })
  giftCost!: string;

  @ApiProperty({ type: String, example: '50.00' })
  manualExpense!: string;

  @ApiProperty({ type: String, example: '640.00' })
  operatingProfit!: string;

  @ApiProperty({ type: String, example: '2480.00' })
  operatingExpense!: string;

  @ApiProperty({ type: String, example: '2670.00' })
  operatingIncome!: string;

  @ApiProperty({ type: String, example: '570.00', description: '经营利润与现金净额之间的时间性差异' })
  cashOperatingGap!: string;
}

export class InternalCourseAccountLedgerQueryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;
}

export class InternalCourseAccountLedgerEntryResponse implements InternalCourseAccountLedgerEntry {
  @ApiProperty({ type: String, format: 'uuid' })
  entryId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: string;

  @ApiProperty({ enum: LedgerEntryKind })
  kind!: LedgerEntryKind;

  @ApiProperty({ type: String, example: '200.00', description: '该业务流水的总金额绝对值' })
  amount!: string;

  @ApiProperty({ type: String, example: '100.00' })
  paidDelta!: string;

  @ApiProperty({ type: String, example: '0.00' })
  giftDelta!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, description: '创建该流水的 Core 用户名' })
  operator!: string;
}

export class InternalCourseAccountLedgerResponse implements InternalCourseAccountLedgerRead {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: InternalCourseAccountLedgerEntryResponse, isArray: true })
  entries!: InternalCourseAccountLedgerEntryResponse[];
}

export class InternalMonthlyPayrollItemResponse implements InternalMonthlyPayrollItem {
  @ApiProperty({ type: String, format: 'uuid' })
  payrollId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  teacherId!: string;

  @ApiProperty({ type: String })
  teacherName!: string;

  @ApiProperty({ type: String, example: '12000.00' })
  courseRevenue!: string;

  @ApiProperty({ type: String, example: '3000.00' })
  baseSalary!: string;

  @ApiProperty({ type: String, example: '10.0000' })
  commissionRate!: string;

  @ApiProperty({ type: String, example: '1200.00' })
  commissionAmount!: string;

  @ApiProperty({ type: String, example: '200.00' })
  bonusAmount!: string;

  @ApiProperty({ type: String, nullable: true })
  bonusNote!: string | null;

  @ApiProperty({ type: String, example: '50.00' })
  deductionAmount!: string;

  @ApiProperty({ type: String, nullable: true })
  deductionNote!: string | null;

  @ApiProperty({ type: String, example: '4400.00' })
  grossSalary!: string;

  @ApiProperty({ type: String, example: '4350.00' })
  netSalary!: string;

  @ApiProperty({ enum: PayrollStatus })
  status!: PayrollStatus;
}

export class InternalMonthlyPayrollResponse implements InternalMonthlyPayrollRead {
  @ApiProperty({ type: String, example: '2026-10' })
  period!: string;

  @ApiProperty({ type: InternalMonthlyPayrollItemResponse, isArray: true })
  payrolls!: InternalMonthlyPayrollItemResponse[];
}

export class InternalLessonResponse implements InternalLesson {
  @ApiProperty({ type: String, format: 'uuid' })
  lessonId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  teacherId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ type: String, minLength: 1 })
  studentName!: string;

  @ApiProperty({ type: String, minLength: 1 })
  courseName!: string;

  @ApiProperty({ type: String, minLength: 1 })
  teacherName!: string;

  @ApiProperty({ type: String, example: '待上课' })
  statusLabel!: string;

  @ApiProperty({ enum: LessonStatus })
  status!: LessonStatus;
}

export class InternalLessonsResponse implements Omit<InternalLessonsRead, 'lessons'> {
  @ApiProperty({ type: String, format: 'date', example: '2026-10-21', description: '单日查询时等于 dateFrom；多日查询时为范围起始业务日' })
  businessDate!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-21' })
  dateFrom!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-22' })
  dateTo!: string;

  @ApiProperty({ type: InternalLessonResponse, isArray: true })
  lessons!: InternalLessonResponse[];
}

export class InternalCourseAccountResponse implements CourseAccountRead {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  version!: number;

  @ApiProperty({ type: String, minLength: 1 })
  studentName!: string;

  @ApiProperty({ type: String, minLength: 1 })
  courseName!: string;

  @ApiProperty({ type: String, example: '200.00' })
  currentUnitPrice!: string;

  @ApiProperty({ type: String, example: '300.00' })
  paidBalance!: string;

  @ApiProperty({ type: String, example: '50.00' })
  giftBalance!: string;

  @ApiProperty({ type: String, example: '350.00' })
  totalBalance!: string;
}

export class InternalLessonsQueryDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-10-21' })
  dateFrom!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-10-21' })
  dateTo!: string;

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  studentName?: string;

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  courseName?: string;

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  teacherName?: string;

  @ApiPropertyOptional({ enum: LessonStatus })
  status?: LessonStatus;

  @ApiPropertyOptional({ enum: ['待上课', '已完成', '已取消'] })
  statusText?: '待上课' | '已完成' | '已取消';
}

export class InternalCourseAccountQueryDto {
  @ApiProperty({ type: String, format: 'uuid', description: '由 course-account-candidates 返回的精确账户 ID' })
  accountId!: string;

}
