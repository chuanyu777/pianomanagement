import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';
import { RequiresCapability } from '../../common/capability/requires-capability.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';
import type { CapabilityRequest } from '../../common/capability/capability.guard.js';
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
  courseName: z.string().trim().min(1).max(100),
}).strict();

const TeacherCandidatesQuerySchema = z.object({
  teacherName: z.string().trim().min(1).max(100),
}).strict();

const StudentCandidatesQuerySchema = z.object({
  studentName: z.string().trim().min(1).max(100),
}).strict();
const LessonCandidatesQuerySchema = z.object({
  studentName: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
const PayrollCandidatesQuerySchema = z.object({
  teacherName: z.string().trim().min(1).max(100),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
}).strict();

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

  @Get('course-account-candidates')
  @ApiOkResponse({ description: '精确匹配的课程账户候选，不含余额或金额' })
  @ApiQuery({ name: 'studentName', required: true, type: String, maxLength: 100 })
  @ApiQuery({ name: 'courseName', required: true, type: String, maxLength: 100 })
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
  @RequiresCapability('READ')
  lessonCandidates(
    @Query() query: unknown,
    @Req() request: CapabilityRequest,
  ) {
    const parsed = LessonCandidatesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.tools.lessonCandidates(request.capability!.sub, parsed.data);
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
}
