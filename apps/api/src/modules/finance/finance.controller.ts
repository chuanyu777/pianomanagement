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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateManualIncomeDto } from './dto/create-manual-income.dto.js';
import { CreateOtherExpenseDto } from './dto/create-other-expense.dto.js';
import { ListManualIncomesQueryDto } from './dto/list-manual-incomes.dto.js';
import { ListOtherExpensesQueryDto } from './dto/list-other-expenses.dto.js';
import { StatementQueryDto } from './dto/statement-query.dto.js';
import { UpdateManualIncomeDto } from './dto/update-manual-income.dto.js';
import { UpdateOtherExpenseDto } from './dto/update-other-expense.dto.js';
import { FinanceService } from './finance.service.js';

/**
 * 收支（US-IE-01/02/03/04）。整块只对店主开放 —— 收支表是经营数据，授课老师无权。
 * controller 只做参数绑定与转发，业务规则在 service。
 */
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('income-statement')
  buildIncomeStatement(@Query() query: StatementQueryDto) {
    return this.finance.buildIncomeStatement(query.period);
  }

  @Get('expense-statement')
  buildExpenseStatement(@Query() query: StatementQueryDto) {
    return this.finance.buildExpenseStatement(query.period);
  }

  @Get('summary')
  buildSummary(@Query() query: StatementQueryDto) {
    return this.finance.buildSummary(query.period);
  }

  @Get('other-expenses')
  listOtherExpenses(@Query() query: ListOtherExpensesQueryDto) {
    return this.finance.listOtherExpenses(query);
  }

  @Post('other-expenses')
  createOtherExpense(@Body() dto: CreateOtherExpenseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.finance.createOtherExpense(dto, actor);
  }

  @Patch('other-expenses/:id')
  updateOtherExpense(@Param('id') id: string, @Body() dto: UpdateOtherExpenseDto) {
    return this.finance.updateOtherExpense(id, dto);
  }

  @Delete('other-expenses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOtherExpense(@Param('id') id: string): Promise<void> {
    await this.finance.removeOtherExpense(id);
  }

  @Get('manual-incomes')
  listManualIncomes(@Query() query: ListManualIncomesQueryDto) {
    return this.finance.listManualIncomes(query);
  }

  @Post('manual-incomes')
  createManualIncome(@Body() dto: CreateManualIncomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.finance.createManualIncome(dto, actor);
  }

  @Patch('manual-incomes/:id')
  updateManualIncome(@Param('id') id: string, @Body() dto: UpdateManualIncomeDto) {
    return this.finance.updateManualIncome(id, dto);
  }

  @Delete('manual-incomes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeManualIncome(@Param('id') id: string): Promise<void> {
    await this.finance.removeManualIncome(id);
  }
}
