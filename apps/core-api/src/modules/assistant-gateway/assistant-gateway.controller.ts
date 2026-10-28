import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AssistantGatewayService } from './assistant-gateway.service.js';

const UUID = z.string().uuid();
const StartSchema = z.object({ message: z.string().trim().min(1).max(4000), threadId: UUID.optional(), clientRequestId: z.string().trim().min(1).max(200).optional() }).strict();
const ResumeSchema = z.object({ threadId: UUID, approved: z.boolean() }).strict();
class StartBody { @ApiProperty({ type: String, maxLength: 4000 }) message!: string; @ApiProperty({ type: String, required: false, format: 'uuid' }) threadId?: string; @ApiProperty({ type: String, required: false }) clientRequestId?: string; }
class ResumeBody { @ApiProperty({ type: String, format: 'uuid' }) threadId!: string; @ApiProperty({ type: Boolean }) approved!: boolean; }
class RunResponse { @ApiProperty({ type: String, format: 'uuid' }) runId!: string; @ApiProperty({ type: String, format: 'uuid' }) threadId!: string; @ApiProperty({ type: String, enum: ['queued', 'running', 'waiting_for_input', 'completed', 'failed'] }) status!: string; }
class TaskSummaryResponse { @ApiProperty({ type: String, format: 'uuid' }) threadId!: string; @ApiProperty({ type: String }) title!: string; @ApiProperty({ type: String, format: 'date-time' }) lastActivityAt!: string; @ApiProperty({ type: String, nullable: true }) latestStatus!: string | null; }
class TaskMessageResponse { @ApiProperty({ type: String, format: 'uuid' }) id!: string; @ApiProperty({ enum: ['user', 'assistant'] }) role!: string; @ApiProperty({ type: String }) content!: string; @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string; }
class HistoricalPreviewReferenceResponse { @ApiProperty({ type: String, format: 'uuid' }) previewId!: string; @ApiProperty({ type: String }) actionType!: string; @ApiProperty({ type: String }) schemaVersion!: string; @ApiProperty({ type: String, enum: ['L0', 'L1', 'L2'] }) riskLevel!: string; }
class TaskDetailResponse extends TaskSummaryResponse { @ApiProperty({ type: TaskMessageResponse, isArray: true }) messages!: TaskMessageResponse[]; @ApiProperty({ type: Object, nullable: true }) workspace!: Record<string, unknown> | null; @ApiProperty({ type: HistoricalPreviewReferenceResponse, isArray: true }) historicalPreviews!: HistoricalPreviewReferenceResponse[]; }
function actor(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['actor']> {
  if (!request.actor) throw new BadRequestException('登录状态无效或已过期');
  return request.actor;
}
type SseResponse = { status(code: number): SseResponse; setHeader(name: string, value: string): SseResponse; flushHeaders(): void; write(chunk: Uint8Array): void; end(): void; };

@ApiTags('Assistant gateway') @ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.OWNER, UserRole.TEACHER) @Controller('assistant')
export class AssistantGatewayController {
  constructor(private readonly gateway: AssistantGatewayService) {}
  @Get('tasks') @ApiOkResponse({ type: TaskSummaryResponse, isArray: true })
  listTasks(@Req() request: AuthenticatedRequest) {
    const currentActor = actor(request);
    return this.gateway.listThreads({ userId: currentActor.id, role: currentActor.role, ...(currentActor.teacherId ? { teacherId: currentActor.teacherId } : {}) });
  }
  @Get('tasks/:threadId') @ApiOkResponse({ type: TaskDetailResponse })
  getTask(@Param('threadId') threadId: string, @Req() request: AuthenticatedRequest) {
    if (!UUID.safeParse(threadId).success) throw new BadRequestException('请求参数不合法');
    const currentActor = actor(request);
    return this.gateway.getThread({ userId: currentActor.id, role: currentActor.role, ...(currentActor.teacherId ? { teacherId: currentActor.teacherId } : {}), threadId });
  }
  @Post('runs') @ApiBody({ type: StartBody }) @ApiOkResponse({ type: RunResponse })
  start(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = StartSchema.safeParse(body); if (!parsed.success) throw new BadRequestException('请求参数不合法');
    const currentActor = actor(request);
    return this.gateway.startRun({ userId: currentActor.id, role: currentActor.role, ...(currentActor.teacherId ? { teacherId: currentActor.teacherId } : {}), message: parsed.data.message, ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}), ...(parsed.data.clientRequestId ? { clientRequestId: parsed.data.clientRequestId } : {}) });
  }
  @Post('runs/:runId/resume') @ApiBody({ type: ResumeBody }) @ApiOkResponse({ type: RunResponse })
  resume(@Param('runId') runId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = ResumeSchema.safeParse(body); if (!UUID.safeParse(runId).success || !parsed.success) throw new BadRequestException('请求参数不合法');
    const currentActor = actor(request);
    return this.gateway.resumeRun({ userId: currentActor.id, role: currentActor.role, ...(currentActor.teacherId ? { teacherId: currentActor.teacherId } : {}), runId, threadId: parsed.data.threadId, input: { approved: parsed.data.approved } });
  }
  @Get('runs/:runId/events')
  async events(@Param('runId') runId: string, @Headers('x-thread-id') threadId: string | undefined, @Headers('last-event-id') lastEventId: string | undefined, @Req() request: AuthenticatedRequest, @Res() response: SseResponse): Promise<void> {
    if (!UUID.safeParse(runId).success || !UUID.safeParse(threadId).success) throw new BadRequestException('请求参数不合法');
    const currentActor = actor(request);
    const stream = await this.gateway.openRunEvents({ userId: currentActor.id, role: currentActor.role, ...(currentActor.teacherId ? { teacherId: currentActor.teacherId } : {}), runId, threadId: threadId!, ...(lastEventId ? { lastEventId } : {}) });
    response.status(200).setHeader('Content-Type', stream.contentType).setHeader('Cache-Control', stream.cacheControl).setHeader('Connection', 'keep-alive').flushHeaders();
    const reader = stream.body.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; response.write(value); } } finally { response.end(); await reader.cancel(); }
  }
}
