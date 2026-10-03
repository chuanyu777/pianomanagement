import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateDeductionItemDto } from './dto/create-deduction-item.dto.js';
import { CreateExpenseItemDto } from './dto/create-expense-item.dto.js';
import { CreateIncomeItemDto } from './dto/create-income-item.dto.js';
import { UpdateDeductionItemDto } from './dto/update-deduction-item.dto.js';
import { UpdateExpenseItemDto } from './dto/update-expense-item.dto.js';
import { UpdateIncomeItemDto } from './dto/update-income-item.dto.js';
import { ItemsService } from './items.service.js';

/**
 * 收支项目清单（US-BD-08）。基础资料，整块只对店主开放。
 * JwtAuthGuard 管「有没有登录」，RolesGuard 管「角色够不够」，两个一起挂才完整。
 */
@Controller('items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post('seed-defaults')
  seedDefaults() {
    return this.items.seedDefaults();
  }

  @Get('income')
  listIncome() {
    return this.items.listIncome();
  }

  @Get('income/:id')
  getIncome(@Param('id') id: string) {
    return this.items.getIncome(id);
  }

  @Post('income')
  createIncome(@Body() dto: CreateIncomeItemDto) {
    return this.items.createIncome(dto);
  }

  @Patch('income/:id')
  updateIncome(@Param('id') id: string, @Body() dto: UpdateIncomeItemDto) {
    return this.items.updateIncome(id, dto);
  }

  @Delete('income/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeIncome(@Param('id') id: string): Promise<void> {
    await this.items.removeIncome(id);
  }

  @Get('expense')
  listExpense() {
    return this.items.listExpense();
  }

  @Get('expense/:id')
  getExpense(@Param('id') id: string) {
    return this.items.getExpense(id);
  }

  @Post('expense')
  createExpense(@Body() dto: CreateExpenseItemDto) {
    return this.items.createExpense(dto);
  }

  @Patch('expense/:id')
  updateExpense(@Param('id') id: string, @Body() dto: UpdateExpenseItemDto) {
    return this.items.updateExpense(id, dto);
  }

  @Delete('expense/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeExpense(@Param('id') id: string): Promise<void> {
    await this.items.removeExpense(id);
  }

  @Get('deduction')
  listDeduction() {
    return this.items.listDeduction();
  }

  @Get('deduction/:id')
  getDeduction(@Param('id') id: string) {
    return this.items.getDeduction(id);
  }

  @Post('deduction')
  createDeduction(@Body() dto: CreateDeductionItemDto) {
    return this.items.createDeduction(dto);
  }

  @Patch('deduction/:id')
  updateDeduction(@Param('id') id: string, @Body() dto: UpdateDeductionItemDto) {
    return this.items.updateDeduction(id, dto);
  }

  @Delete('deduction/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDeduction(@Param('id') id: string): Promise<void> {
    await this.items.removeDeduction(id);
  }
}
