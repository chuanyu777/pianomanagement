import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service.js';
import { CreateFirstOwnerDto } from './dto/create-first-owner.dto.js';

/**
 * 首次引导。**故意不加鉴权** —— 空库里没有任何账号可用于登录。
 * 安全性由 service 里的「users 表必须为空」保证，见 BootstrapService 注释。
 */
@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get('status')
  status() {
    return this.bootstrap.status();
  }

  @Post('owner')
  @HttpCode(HttpStatus.CREATED)
  createFirstOwner(@Body() dto: CreateFirstOwnerDto) {
    return this.bootstrap.createFirstOwner(dto);
  }
}
