import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  AssistantStatusService,
  type AssistantStatus,
} from './assistant-status.service.js';

class AssistantComponentStatusResponse {
  @ApiProperty({ type: Boolean, example: true })
  available!: boolean;
}

class AssistantStatusResponse {
  @ApiProperty({ type: Boolean, example: true })
  available!: boolean;

  @ApiProperty({ type: AssistantComponentStatusResponse })
  core!: AssistantComponentStatusResponse;

  @ApiProperty({ type: AssistantComponentStatusResponse })
  agentRuntime!: AssistantComponentStatusResponse;

  @ApiProperty({ type: String, format: 'date-time' })
  checkedAt!: string;

  @ApiProperty({ type: String, enum: ['AI 助手已连接', 'AI 助手暂不可用'] })
  message!: AssistantStatus['message'];
}

@ApiTags('Assistant')
@Controller('assistant')
export class AssistantStatusController {
  constructor(private readonly statusService: AssistantStatusService) {}

  @Get('status')
  @ApiOperation({
    summary: '查询 AI 助手可用性',
    description:
      '返回 Core 数据库和 Agent Runtime 健康检查结果，不包含业务数据。依赖不可用时仍以 200 返回安全降级状态。',
  })
  @ApiOkResponse({ type: AssistantStatusResponse })
  getStatus(): Promise<AssistantStatus> {
    return this.statusService.getStatus();
  }
}
