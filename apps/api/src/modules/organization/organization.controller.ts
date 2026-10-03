import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { Prisma } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { ReplaceProfitSharesDto } from './dto/profit-shares.dto.js';
import { UpdateOrganizationDto } from './dto/update-organization.dto.js';
import { OrganizationService } from './organization.service.js';

/**
 * 机构设置（US-BD-07）。只有店主能改；读也要登录。
 *
 * GET /organization/profit-shares 单独拆出来是为了让前端少解析一次嵌套结构。
 */
@Controller('organization')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.TEACHER)
  get() {
    return this.organization.get();
  }

  @Patch()
  @Roles(UserRole.OWNER)
  update(@Body() dto: UpdateOrganizationDto) {
    return this.organization.update(dto as Prisma.OrganizationUpdateInput);
  }

  @Get('profit-shares')
  @Roles(UserRole.OWNER)
  listProfitShares() {
    return this.organization.listProfitShares();
  }

  @Put('profit-shares')
  @Roles(UserRole.OWNER)
  replaceProfitShares(@Body() dto: ReplaceProfitSharesDto) {
    return this.organization.replaceProfitShares(dto.rules);
  }
}
