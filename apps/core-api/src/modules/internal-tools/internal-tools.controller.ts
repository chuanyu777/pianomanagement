import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { LessonStatus } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';
import { RequiresCapability } from '../../common/capability/requires-capability.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import type { CapabilityRequest } from '../../common/capability/capability.guard.js';
import {
  InternalCourseAccountLedgerResponse,
  InternalMonthlyPayrollResponse,
  InternalMonthlyReportResponse,
  InternalCourseAccountResponse,
  InternalLessonsResponse,
  InternalDirectoryResponse,
  InternalArrearsAndFrozenResponse,
  InternalMonthlyConsumptionResponse,
  InternalPeriodPrecloseResponse,
} from './internal-tools.dto.js';
import { InternalToolsService } from './internal-tools.service.js';

class SystemStatusResponse {
  @ApiProperty({ type: String, enum: ['available'], example: 'available' })
  status!: 'available';

  @ApiProperty({ type: String, enum: ['Asia/Shanghai'], example: 'Asia/Shanghai' })
  businessTimezone!: 'Asia/Shanghai';

  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: string;
}

const CourseAccountCandidatesQuerySchema = z.object({
  studentName: z.string().trim().min(1).max(100),
  courseName: z.string().trim().min(1).max(100).optional(),
  match: z.literal('search').optional(),
}).strict();

const TeacherCandidatesQuerySchema = z.object({
  teacherName: z.string().trim().min(1).max(100),
  match: z.literal('search').optional(),
}).strict();

const StudentCandidatesQuerySchema = z.object({
  studentName: z.string().trim().min(1).max(100),
  match: z.literal('search').optional(),
}).strict();
const LessonCandidatesQuerySchema = z.object({
  studentName: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  match: z.literal('search').optional(),
}).strict();
const InternalLessonsQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  studentName: z.string().trim().min(1).max(100).optional(),
  courseName: z.string().trim().min(1).max(100).optional(),
  teacherName: z.string().trim().min(1).max(100).optional(),
  status: z.nativeEnum(LessonStatus).optional(),
  statusText: z.enum(['待上课', '已完成', '已取消']).optional(),
}).strict().superRefine((value, context) => {
  if (value.dateFrom > value.dateTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '日期范围不合法', path: ['dateTo'] });
  }
  if (value.status && value.statusText) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '课程状态参数不能重复', path: ['statusText'] });
  }
});
const InternalCourseAccountQuerySchema = z.object({
  accountId: z.string().uuid(),
}).strict();
const PayrollCandidatesQuerySchema = z.object({
  teacherName: z.string().trim().min(1).max(100),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
}).strict();
const InternalPeriodQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
}).strict();
const InternalLedgerQuerySchema = z.object({ accountId: z.string().uuid() }).strict();

@ApiTags('InternalTools')
@ApiHeader({ name: 'authorization', required: true, description: 'Bearer Capability' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-nonce', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@Controller('internal/tools')
@UseGuards(InternalRequestGuard, CapabilityGuard)
export class InternalToolsController {
  constructor(private readonly tools: InternalToolsService) {}

  @Get('system-status')
  @ApiOkResponse({ type: SystemStatusResponse })
  @RequiresCapability('READ')
  systemStatus(): SystemStatusResponse {
    return {
      status: 'available',
      businessTimezone: 'Asia/Shanghai',
      serverTime: new Date().toISOString(),
    } as const;
  }

  @Get('dashboard-summary')
  @ApiOkResponse({ description: '按数据库账号角色隔离的经营摘要' })
  @RequiresCapability('READ')
  dashboardSummary(@Req() request: CapabilityRequest) {
    return this.tools.dashboardSummary(request.capability!.sub);
  }

  @Get('directory')
  @ApiOkResponse({ type: InternalDirectoryResponse, description: '学生、教师和课程基础资料；不包含学生余额或教师薪酬配置' })
  @RequiresCapability('READ')
  directory(@Req() request: CapabilityRequest) {
    return this.tools.directory(request.capability!.sub);
  }

  @Get('arrears-frozen')
  @ApiOkResponse({ type: InternalArrearsAndFrozenResponse, description: '按课程实收负余额列欠费；冻结状态复用学生领域服务，退学生排除' })
  @RequiresCapability('READ')
  arrearsAndFrozen(@Req() request: CapabilityRequest) {
    return this.tools.arrearsAndFrozen(request.capability!.sub);
  }

  @Get('course-account-candidates')
  @ApiOkResponse({ description: '精确匹配的课程账户候选，不含余额或金额' })
  @ApiQuery({ name: 'studentName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'courseName', required: false, type: String, maxLength: 100 })
  @ApiQuery({ name: 'match', required: false, enum: ['search'], description: '启用不区分大小写的包含搜索；精确名称优先且不会替用户消除歧义' })
  @RequiresCapability('READ')
  courseAccountCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = CourseAccountCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.courseAccountCandidates(request.capability!.sub, parsed.data);
  }

  @Get('teacher-candidates')
  @ApiOkResponse({ description: '教师候选，仅包含教师 ID 与姓名' })
  @ApiQuery({ name: 'teacherName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'match', required: false, enum: ['search'], description: '启用不区分大小写的包含搜索；精确名称优先且不会替用户消除歧义' })
  @RequiresCapability('READ')
  teacherCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = TeacherCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.teacherCandidates(request.capability!.sub, parsed.data);
  }

  @Get('student-candidates')
  @ApiOkResponse({ description: '精确匹配的学生候选，仅包含学生 ID 与姓名' })
  @ApiQuery({ name: 'studentName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'match', required: false, enum: ['search'], description: '启用不区分大小写的包含搜索；精确名称优先且不会替用户消除歧义' })
  @RequiresCapability('READ')
  studentCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = StudentCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.studentCandidates(request.capability!.sub, parsed.data);
  }

  @Get('lesson-candidates')
  @ApiOkResponse({ description: '按学生和可选业务日期查询排课候选' })
  @ApiQuery({ name: 'studentName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'date', required: false, type: String, example: '2026-10-19' })
  @ApiQuery({ name: 'match', required: false, enum: ['search'], description: '启用不区分大小写的包含搜索；精确名称优先且不会替用户消除歧义' })
  @RequiresCapability('READ')
  lessonCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = LessonCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.lessonCandidates(request.capability!.sub, parsed.data);
  }

  @Get('lessons')
  @ApiOkResponse({ type: InternalLessonsResponse })
  @ApiQuery({ name: 'dateFrom', required: true, type: String, format: 'date', example: '2026-10-21' })
  @ApiQuery({ name: 'dateTo', required: true, type: String, format: 'date', example: '2026-10-21' })
  @ApiQuery({ name: 'studentName', required: false, type: String, maxLength: 100 })
  @ApiQuery({ name: 'courseName', required: false, type: String, maxLength: 100 })
  @ApiQuery({ name: 'teacherName', required: false, type: String, maxLength: 100 })
  @ApiQuery({ name: 'status', required: false, enum: LessonStatus })
  @ApiQuery({ name: 'statusText', required: false, enum: ['待上课', '已完成', '已取消'], description: '供自然语言编排使用的中文状态，由 Core 映射到领域枚举' })
  @RequiresCapability('READ')
  listLessons(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = InternalLessonsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.listLessons(request.capability!.sub, parsed.data);
  }

  @Get('course-account-detail')
  @ApiOkResponse({ type: InternalCourseAccountResponse })
  @ApiQuery({ name: 'accountId', required: true, type: String, format: 'uuid' })
  @RequiresCapability('READ')
  courseAccount(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = InternalCourseAccountQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.courseAccount(request.capability!.sub, parsed.data);
  }

  @Get('payroll-candidates')
  @ApiOkResponse({ description: '按老师和业务月份查询工资候选，仅包含安全选择所需字段' })
  @ApiQuery({ name: 'teacherName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10' })
  @RequiresCapability('READ')
  payrollCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = PayrollCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.payrollCandidates(request.capability!.sub, parsed.data);
  }

  @Get('monthly-report')
  @ApiOkResponse({ type: InternalMonthlyReportResponse })
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10', description: 'Asia/Shanghai 业务月份' })
  @RequiresCapability('READ')
  monthlyReport(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = InternalPeriodQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.monthlyReport(request.capability!.sub, parsed.data);
  }

  @Get('monthly-consumption')
  @ApiOkResponse({ type: InternalMonthlyConsumptionResponse, description: '按已确认课消及其冲正真实流水，按课程、教师、学生分别分组' })
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10', description: 'Asia/Shanghai 业务月份' })
  @RequiresCapability('READ')
  monthlyConsumption(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = InternalPeriodQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.monthlyConsumption(request.capability!.sub, parsed.data);
  }

  @Get('period-preclose')
  @ApiOkResponse({ type: InternalPeriodPrecloseResponse, description: '按 Core 月度数据事实返回待确认课、退款与流水异常、缺失工资；异常阻断等级待人工判断' })
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10', description: 'Asia/Shanghai 业务月份' })
  @RequiresCapability('READ')
  periodPreclose(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = InternalPeriodQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.periodPreclose(request.capability!.sub, parsed.data);
  }

  @Get('course-account-ledger')
  @ApiOkResponse({ type: InternalCourseAccountLedgerResponse })
  @ApiQuery({ name: 'accountId', required: true, type: String, format: 'uuid' })
  @RequiresCapability('READ')
  courseAccountLedger(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = InternalLedgerQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.courseAccountLedger(request.capability!.sub, parsed.data);
  }

  @Get('monthly-payroll')
  @ApiOkResponse({ type: InternalMonthlyPayrollResponse })
  @ApiQuery({ name: 'period', required: true, type: String, example: '2026-10', description: 'Asia/Shanghai 业务月份；店主查看全店，老师查看本人' })
  @RequiresCapability('READ')
  monthlyPayroll(@Query() query: unknown, @Req() request: CapabilityRequest) {
    const parsed = InternalPeriodQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.monthlyPayroll(request.capability!.sub, parsed.data);
  }
}
