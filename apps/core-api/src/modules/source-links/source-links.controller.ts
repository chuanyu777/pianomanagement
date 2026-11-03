import { BadRequestException, Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { UserRole } from '../../generated/prisma/client.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { SourceLinksService } from './source-links.service.js';

class SourceLinkResponse { @ApiProperty({ type: String }) path!: string; }
@ApiTags('Source links')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.TEACHER)
@Controller('source-links')
export class SourceLinksController {
  constructor(private readonly service: SourceLinksService) {}
  @Get(':type/:id')
  @ApiOkResponse({ type: SourceLinkResponse })
  resolve(@Param('type') type: string, @Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const parsedType = z.enum(['student', 'courseAccount', 'ledgerEntry', 'lesson', 'report']).safeParse(type);
    if (!parsedType.success || !(parsedType.data === 'report' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(id) : z.uuid().safeParse(id).success)) throw new BadRequestException('请求参数不合法');
    return this.service.resolve(request.actor!, parsedType.data, id);
  }
}
