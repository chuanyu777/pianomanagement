import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateGiftDto } from './dto/create-gift.dto.js';
import { ListGiftsQueryDto } from './dto/list-gifts.dto.js';
import { GiftsService } from './gifts.service.js';

/** 赠送 / 撤销 / 查询（US-GL-01/02/03）。整块只对店主开放。 */
@Controller('gifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class GiftsController {
  constructor(private readonly gifts: GiftsService) {}

  @Get()
  list(@Query() query: ListGiftsQueryDto) {
    return this.gifts.listGrants(query);
  }

  /** 按活动汇总营销成本（US-GL-02）。放在 :id 路由之前，避免被当成 id。 */
  @Get('summary/by-activity')
  summaryByActivity() {
    return this.gifts.summaryByActivity();
  }

  @Post()
  create(@Body() dto: CreateGiftDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.gifts.createGift(dto, actor);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.gifts.revokeGift(id, actor);
  }
}
