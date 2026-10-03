import { ConflictException, NotFoundException } from '@nestjs/common';
import { AutoSource } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ItemsService } from './items.service.js';

/**
 * 只 mock 用得到的方法，不做「内存数据库替身」——
 * 替身会自己长出一套语义，测出来的绿可能是替身的绿。
 */
function createPrismaMock() {
  return {
    incomeItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
    },
    expenseItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
    },
    deductionItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
    },
    ledgerEntry: { count: vi.fn() },
    manualIncome: { count: vi.fn() },
    otherExpense: { count: vi.fn() },
    payrollDeduction: { count: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('ItemsService', () => {
  let prisma: PrismaMock;
  let service: ItemsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    service = new ItemsService(prisma as unknown as PrismaService);
  });

  describe('收入项', () => {
    it('列表按 sortOrder、name 升序（含停用项，维护页要看得到）', async () => {
      prisma.incomeItem.findMany.mockResolvedValue([{ id: 'i1' }]);

      const result = await service.listIncome();

      expect(prisma.incomeItem.findMany).toHaveBeenCalledWith({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      expect(result).toEqual([{ id: 'i1' }]);
    });

    it('查不到时报 404', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue(null);
      await expect(service.getIncome('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('新建时未传 sortOrder / isActive / autoSource 落到默认值', async () => {
      prisma.incomeItem.create.mockResolvedValue({ id: 'i1' });

      await service.createIncome({ name: '钢琴' });

      expect(prisma.incomeItem.create).toHaveBeenCalledWith({
        data: { name: '钢琴', sortOrder: 0, isActive: true, autoSource: null },
      });
    });

    it('新建自动取数项时带上 autoSource', async () => {
      prisma.incomeItem.create.mockResolvedValue({ id: 'i2' });

      await service.createIncome({ name: '课时消费', autoSource: AutoSource.LESSON_CONSUMPTION });

      expect(prisma.incomeItem.create).toHaveBeenCalledWith({
        data: {
          name: '课时消费',
          sortOrder: 0,
          isActive: true,
          autoSource: AutoSource.LESSON_CONSUMPTION,
        },
      });
    });

    it('重名撞唯一约束（P2002）转成 409', async () => {
      prisma.incomeItem.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );

      await expect(service.createIncome({ name: '钢琴' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('被台账流水引用时不能删（409），提示改用停用', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue({ id: 'i1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([3, 0]);

      await expect(service.removeIncome('i1')).rejects.toThrow(/停用/);
      expect(prisma.incomeItem.delete).not.toHaveBeenCalled();
    });

    it('被手工补录收入引用时不能删（409）', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue({ id: 'i1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([0, 2]);

      await expect(service.removeIncome('i1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.incomeItem.delete).not.toHaveBeenCalled();
    });

    it('没有任何引用时才真删', async () => {
      prisma.incomeItem.findUnique.mockResolvedValue({ id: 'i1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([0, 0]);
      prisma.incomeItem.delete.mockResolvedValue({ id: 'i1' });

      await service.removeIncome('i1');

      expect(prisma.incomeItem.delete).toHaveBeenCalledWith({ where: { id: 'i1' } });
    });
  });

  describe('支出项', () => {
    it('编辑只提交传了的字段（停用只改 isActive）', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.expenseItem.update.mockResolvedValue({ id: 'e1', isActive: false });

      await service.updateExpense('e1', { isActive: false });

      expect(prisma.expenseItem.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { isActive: false },
      });
    });

    it('被其它支出引用时不能删（409）', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({ id: 'e1', name: '水电' });
      prisma.otherExpense.count.mockResolvedValue(4);

      await expect(service.removeExpense('e1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.expenseItem.delete).not.toHaveBeenCalled();
    });

    it('无引用时真删', async () => {
      prisma.expenseItem.findUnique.mockResolvedValue({ id: 'e1', name: '水电' });
      prisma.otherExpense.count.mockResolvedValue(0);
      prisma.expenseItem.delete.mockResolvedValue({ id: 'e1' });

      await service.removeExpense('e1');

      expect(prisma.expenseItem.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });
  });

  describe('代扣项', () => {
    it('被工资代扣引用时不能删（409）', async () => {
      prisma.deductionItem.findUnique.mockResolvedValue({ id: 'd1', name: '社保' });
      prisma.payrollDeduction.count.mockResolvedValue(2);

      await expect(service.removeDeduction('d1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.deductionItem.delete).not.toHaveBeenCalled();
    });

    it('无引用时真删', async () => {
      prisma.deductionItem.findUnique.mockResolvedValue({ id: 'd1', name: '社保' });
      prisma.payrollDeduction.count.mockResolvedValue(0);
      prisma.deductionItem.delete.mockResolvedValue({ id: 'd1' });

      await service.removeDeduction('d1');

      expect(prisma.deductionItem.delete).toHaveBeenCalledWith({ where: { id: 'd1' } });
    });
  });

  describe('seedDefaults', () => {
    it('用 createMany + skipDuplicates 幂等写入（已存在同名的跳过，不重复插）', async () => {
      prisma.incomeItem.createMany.mockResolvedValue({ count: 7 });
      prisma.expenseItem.createMany.mockResolvedValue({ count: 13 });
      prisma.deductionItem.createMany.mockResolvedValue({ count: 6 });

      const result = await service.seedDefaults();

      expect(prisma.incomeItem.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
      expect(prisma.expenseItem.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
      expect(prisma.deductionItem.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
      expect(result).toEqual({ income: 7, expense: 13, deduction: 6 });
    });

    it('收入项模板：5 个手工项 + 2 个自动项，顺序与 autoSource 正确', async () => {
      prisma.incomeItem.createMany.mockResolvedValue({ count: 0 });
      prisma.expenseItem.createMany.mockResolvedValue({ count: 0 });
      prisma.deductionItem.createMany.mockResolvedValue({ count: 0 });

      await service.seedDefaults();

      const data = prisma.incomeItem.createMany.mock.calls[0][0].data as {
        name: string;
        autoSource: AutoSource | null;
        isDefault: boolean;
      }[];
      expect(data.map((row) => row.name)).toEqual([
        '钢琴',
        '听力',
        '基本功',
        '集训',
        '书',
        '课时消费',
        '退费手续费',
      ]);
      expect(data.find((row) => row.name === '钢琴')?.autoSource).toBeNull();
      expect(data.find((row) => row.name === '课时消费')?.autoSource).toBe(
        AutoSource.LESSON_CONSUMPTION,
      );
      expect(data.find((row) => row.name === '退费手续费')?.autoSource).toBe(
        AutoSource.REFUND_FEE,
      );
      expect(data.every((row) => row.isDefault)).toBe(true);
    });

    it('支出项模板：自动类在前、手工类在后，autoSource 正确', async () => {
      prisma.incomeItem.createMany.mockResolvedValue({ count: 0 });
      prisma.expenseItem.createMany.mockResolvedValue({ count: 0 });
      prisma.deductionItem.createMany.mockResolvedValue({ count: 0 });

      await service.seedDefaults();

      const data = prisma.expenseItem.createMany.mock.calls[0][0].data as {
        name: string;
        autoSource: AutoSource | null;
      }[];
      expect(data.map((row) => row.name)).toEqual([
        '工资',
        '赠课成本',
        '利润分配',
        '退费',
        '水电',
        '物业',
        '房租',
        '电话',
        '办公',
        '维修',
        '宽带',
        '刷卡手续费',
        '其它',
      ]);
      expect(data.find((row) => row.name === '工资')?.autoSource).toBe(
        AutoSource.PAYROLL_ACCRUED,
      );
      expect(data.find((row) => row.name === '水电')?.autoSource).toBeNull();
    });

    it('代扣项模板', async () => {
      prisma.incomeItem.createMany.mockResolvedValue({ count: 0 });
      prisma.expenseItem.createMany.mockResolvedValue({ count: 0 });
      prisma.deductionItem.createMany.mockResolvedValue({ count: 0 });

      await service.seedDefaults();

      const data = prisma.deductionItem.createMany.mock.calls[0][0].data as { name: string }[];
      expect(data.map((row) => row.name)).toEqual([
        '社保',
        '公积金',
        '培训',
        '请假',
        '罚款',
        '个税',
      ]);
    });
  });
});
