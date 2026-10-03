import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AutoSource } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateDeductionItemDto } from './dto/create-deduction-item.dto.js';
import { CreateExpenseItemDto } from './dto/create-expense-item.dto.js';
import { CreateIncomeItemDto } from './dto/create-income-item.dto.js';
import { UpdateDeductionItemDto } from './dto/update-deduction-item.dto.js';
import { UpdateExpenseItemDto } from './dto/update-expense-item.dto.js';
import { UpdateIncomeItemDto } from './dto/update-income-item.dto.js';

/**
 * Prisma 唯一约束冲突的错误码。用鸭子类型判断而不是 import 生成产物的错误类，
 * 生成产物换结构时这里不会跟着炸。
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 默认模板。**只在这里写一份**，seedDefaults 幂等地把它灌进清单。
 * 收入/支出项的顺序即 sortOrder：手工类在前、自动类在后（支出项反过来，自动取数的先展示）。
 */
const INCOME_DEFAULTS: { name: string; autoSource: AutoSource | null }[] = [
  { name: '钢琴', autoSource: null },
  { name: '听力', autoSource: null },
  { name: '基本功', autoSource: null },
  { name: '集训', autoSource: null },
  { name: '书', autoSource: null },
  { name: '课时消费', autoSource: AutoSource.LESSON_CONSUMPTION },
  { name: '退费手续费', autoSource: AutoSource.REFUND_FEE },
];

const EXPENSE_DEFAULTS: { name: string; autoSource: AutoSource | null }[] = [
  { name: '工资', autoSource: AutoSource.PAYROLL_ACCRUED },
  { name: '赠课成本', autoSource: AutoSource.GIFT_COST },
  { name: '利润分配', autoSource: AutoSource.PROFIT_SHARE },
  { name: '退费', autoSource: AutoSource.REFUND_PAID },
  { name: '水电', autoSource: null },
  { name: '物业', autoSource: null },
  { name: '房租', autoSource: null },
  { name: '电话', autoSource: null },
  { name: '办公', autoSource: null },
  { name: '维修', autoSource: null },
  { name: '宽带', autoSource: null },
  { name: '刷卡手续费', autoSource: null },
  { name: '其它', autoSource: null },
];

const DEDUCTION_DEFAULTS: string[] = ['社保', '公积金', '培训', '请假', '罚款', '个税'];

const ITEM_ORDER = [{ sortOrder: 'asc' }, { name: 'asc' }] as const;

/**
 * 收支项目清单（US-BD-08）：收入项 / 支出项 / 工资代扣项三类。
 *
 * 三类行为完全一样（CRUD + 排序 + 启停），只是指向不同的表、有各自的引用检查，
 * 所以这里**显式写三遍**而不是造一层泛型 —— 泛型会把 Prisma 的 delegate 变成联合类型，
 * 读起来更绕，还容易在字段差异（只有代扣项没有 autoSource / isDefault）上出错。
 *
 * 删除一律先查引用：被业务数据引用的项不能删（数据库的 Restrict 是最后一道兜底，
 * 但那句报错前端看不懂），引导改用「停用」以保留历史口径。
 */
@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  listIncome() {
    return this.prisma.incomeItem.findMany({ orderBy: [...ITEM_ORDER] });
  }

  async getIncome(id: string) {
    const found = await this.prisma.incomeItem.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('收入项不存在');
    return found;
  }

  async createIncome(dto: CreateIncomeItemDto) {
    try {
      return await this.prisma.incomeItem.create({
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
          autoSource: dto.autoSource ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`收入项「${dto.name}」已存在`);
      throw error;
    }
  }

  async updateIncome(id: string, dto: UpdateIncomeItemDto) {
    await this.getIncome(id);

    const data: {
      name?: string;
      sortOrder?: number;
      isActive?: boolean;
      autoSource?: AutoSource | null;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.autoSource !== undefined) data.autoSource = dto.autoSource;

    try {
      return await this.prisma.incomeItem.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`收入项「${dto.name}」已存在`);
      throw error;
    }
  }

  async removeIncome(id: string): Promise<void> {
    const found = await this.getIncome(id);

    const [ledgerCount, manualCount] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.count({ where: { incomeItemId: id } }),
      this.prisma.manualIncome.count({ where: { incomeItemId: id } }),
    ]);

    if (ledgerCount > 0 || manualCount > 0) {
      throw new ConflictException(
        `收入项「${found.name}」已被 ${ledgerCount} 条交费流水、${manualCount} 条手工补录收入引用，不能删除；不再使用请改为停用`,
      );
    }

    await this.prisma.incomeItem.delete({ where: { id } });
  }

  listExpense() {
    return this.prisma.expenseItem.findMany({ orderBy: [...ITEM_ORDER] });
  }

  async getExpense(id: string) {
    const found = await this.prisma.expenseItem.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('支出项不存在');
    return found;
  }

  async createExpense(dto: CreateExpenseItemDto) {
    try {
      return await this.prisma.expenseItem.create({
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
          autoSource: dto.autoSource ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`支出项「${dto.name}」已存在`);
      throw error;
    }
  }

  async updateExpense(id: string, dto: UpdateExpenseItemDto) {
    await this.getExpense(id);

    const data: {
      name?: string;
      sortOrder?: number;
      isActive?: boolean;
      autoSource?: AutoSource | null;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.autoSource !== undefined) data.autoSource = dto.autoSource;

    try {
      return await this.prisma.expenseItem.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`支出项「${dto.name}」已存在`);
      throw error;
    }
  }

  async removeExpense(id: string): Promise<void> {
    const found = await this.getExpense(id);

    const otherExpenseCount = await this.prisma.otherExpense.count({
      where: { expenseItemId: id },
    });

    if (otherExpenseCount > 0) {
      throw new ConflictException(
        `支出项「${found.name}」已被 ${otherExpenseCount} 条其它支出引用，不能删除；不再使用请改为停用`,
      );
    }

    await this.prisma.expenseItem.delete({ where: { id } });
  }

  listDeduction() {
    return this.prisma.deductionItem.findMany({ orderBy: [...ITEM_ORDER] });
  }

  async getDeduction(id: string) {
    const found = await this.prisma.deductionItem.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('代扣项不存在');
    return found;
  }

  async createDeduction(dto: CreateDeductionItemDto) {
    try {
      return await this.prisma.deductionItem.create({
        data: {
          name: dto.name,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`代扣项「${dto.name}」已存在`);
      throw error;
    }
  }

  async updateDeduction(id: string, dto: UpdateDeductionItemDto) {
    await this.getDeduction(id);

    const data: { name?: string; sortOrder?: number; isActive?: boolean } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      return await this.prisma.deductionItem.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`代扣项「${dto.name}」已存在`);
      throw error;
    }
  }

  async removeDeduction(id: string): Promise<void> {
    const found = await this.getDeduction(id);

    const payrollDeductionCount = await this.prisma.payrollDeduction.count({
      where: { deductionItemId: id },
    });

    if (payrollDeductionCount > 0) {
      throw new ConflictException(
        `代扣项「${found.name}」已被 ${payrollDeductionCount} 条工资代扣引用，不能删除；不再使用请改为停用`,
      );
    }

    await this.prisma.deductionItem.delete({ where: { id } });
  }

  /**
   * 灌入默认模板（US-BD-08）。幂等：靠 `skipDuplicates` 让数据库按 `name` 唯一约束跳过已存在的行，
   * 而不是「先查再插」—— 先查再插在并发下会插进两份重复项。
   * 不覆盖用户改过的项（包括名称与排序），只补缺。
   */
  async seedDefaults(): Promise<{ income: number; expense: number; deduction: number }> {
    const [income, expense, deduction] = await Promise.all([
      this.prisma.incomeItem.createMany({
        data: INCOME_DEFAULTS.map((row, index) => ({
          name: row.name,
          sortOrder: index,
          isActive: true,
          isDefault: true,
          autoSource: row.autoSource,
        })),
        skipDuplicates: true,
      }),
      this.prisma.expenseItem.createMany({
        data: EXPENSE_DEFAULTS.map((row, index) => ({
          name: row.name,
          sortOrder: index,
          isActive: true,
          isDefault: true,
          autoSource: row.autoSource,
        })),
        skipDuplicates: true,
      }),
      this.prisma.deductionItem.createMany({
        data: DEDUCTION_DEFAULTS.map((name, index) => ({
          name,
          sortOrder: index,
          isActive: true,
        })),
        skipDuplicates: true,
      }),
    ]);

    return { income: income.count, expense: expense.count, deduction: deduction.count };
  }
}
