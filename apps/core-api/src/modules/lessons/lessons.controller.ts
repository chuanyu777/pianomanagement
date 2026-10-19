import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { LessonsService } from './lessons.service.js';
import {
  CancelLessonBody,
  CreateBatchLessonsBody,
  CompleteLessonBody,
  CreateLessonBody,
  LessonResponse,
  RescheduleLessonBody,
} from './lessons.dto.js';
import { z } from 'zod';

const IdSchema = z.string().uuid();
const DateTimeSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const CreateSchema = z.object({
  accountId: IdSchema,
  teacherId: IdSchema.optional(),
  startsAt: DateTimeSchema,
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();
const CreateBatchSchema = z.object({
  accountId: IdSchema,
  teacherId: IdSchema,
  firstStartsAt: DateTimeSchema,
  weeks: z.number().int().min(1).max(52),
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();
const RescheduleSchema = z.object({ startsAt: DateTimeSchema }).strict();
const CancelSchema = z.object({ note: z.string().trim().min(1).max(2000).optional() }).strict();
const CompleteSchema = z.object({ note: z.string().trim().min(1).max(2000).optional() }).strict();

function actorFrom(request: AuthenticatedRequest): AuthenticatedActor {
  if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
  return request.actor;
}

function parseId(value: string): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('请求参数不合法');
  return parsed.data;
}

@ApiTags('Lessons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.TEACHER)
@Controller('lessons')
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @Post()
  @ApiBody({ type: CreateLessonBody })
  @ApiCreatedResponse({ type: LessonResponse })
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const actor = actorFrom(request);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const teacherId = actor.role === UserRole.TEACHER ? actor.teacherId : parsed.data.teacherId;
    if (!teacherId) throw new BadRequestException('请指定授课教师');
    return this.lessons.createSingle({
      accountId: parsed.data.accountId,
      teacherId,
      startsAt: parsed.data.startsAt,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    }, actor);
  }

  @Post('batch')
  @Roles(UserRole.OWNER)
  @ApiBody({ type: CreateBatchLessonsBody })
  @ApiCreatedResponse({ type: LessonResponse, isArray: true })
  createBatch(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = CreateBatchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.lessons.createBatch({
      accountId: parsed.data.accountId,
      teacherId: parsed.data.teacherId,
      firstStartsAt: parsed.data.firstStartsAt,
      weeks: parsed.data.weeks,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    }, actorFrom(request));
  }

  @Get()
  @ApiOkResponse({ type: LessonResponse, isArray: true })
  list(@Req() request: AuthenticatedRequest) {
    return this.lessons.listForActor(actorFrom(request));
  }

  @Patch(':id/reschedule')
  @ApiBody({ type: RescheduleLessonBody })
  @ApiOkResponse({ type: LessonResponse })
  reschedule(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsedId = parseId(id);
    const parsed = RescheduleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.lessons.reschedule(parsedId, parsed.data, actorFrom(request));
  }

  @Post(':id/cancel')
  @ApiBody({ type: CancelLessonBody })
  @ApiOkResponse({ type: LessonResponse })
  cancel(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsedId = parseId(id);
    const parsed = CancelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.lessons.cancel(parsedId, parsed.data, actorFrom(request));
  }

  @Post(':id/complete')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: CompleteLessonBody })
  @ApiOkResponse({ type: LessonResponse })
  complete(
    @Param('id') id: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.lessons.complete(parseId(id), { ...parsed.data, commandId: parseId(commandId ?? '') }, actorFrom(request));
  }

  @Post(':id/complete/reversal')
  @Roles(UserRole.OWNER)
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: CompleteLessonBody })
  @ApiOkResponse({ type: LessonResponse })
  reverseCompletion(
    @Param('id') id: string,
    @Headers('idempotency-key') commandId: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请求参数不合法');
    return this.lessons.reverseCompletion(
      parseId(id),
      { ...parsed.data, commandId: parseId(commandId ?? '') },
      actorFrom(request),
    );
  }
}
