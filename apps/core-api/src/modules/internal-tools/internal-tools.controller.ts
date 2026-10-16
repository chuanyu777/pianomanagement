import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CapabilityGuard } from '../../common/capability/capability.guard.js';
import { RequiresCapability } from '../../common/capability/requires-capability.js';
import { InternalRequestGuard } from '../../common/internal-auth/internal-request.guard.js';

class SystemStatusResponse {
  @ApiProperty({ type: String, enum: ['available'], example: 'available' })
  status!: 'available';

  @ApiProperty({ type: String, enum: ['Asia/Shanghai'], example: 'Asia/Shanghai' })
  businessTimezone!: 'Asia/Shanghai';

  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: string;
}

@ApiTags('InternalTools')
@ApiHeader({ name: 'authorization', required: true, description: 'Bearer Capability' })
@ApiHeader({ name: 'x-internal-timestamp', required: true })
@ApiHeader({ name: 'x-internal-nonce', required: true })
@ApiHeader({ name: 'x-internal-signature', required: true })
@Controller('internal/tools')
@UseGuards(InternalRequestGuard, CapabilityGuard)
export class InternalToolsController {
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
}
