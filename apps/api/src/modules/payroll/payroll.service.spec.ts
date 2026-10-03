import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Prisma, UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import type { PayrollComputation, PayrollTotalsPrisma } from './payroll-totals.js';
import {
  computePayrollForTeacher,
  computePayrollSheet,
  computePeriodTotals,
} from './payroll-totals.js';
import { OPTIONAL_PAYROLL_COLUMNS, PayrollService } from './payroll.service.js';
import type { UpsertPayrollDto } from './dto/upsert-payroll.dto.js';

/**
 * 只替换 service 用到的三个汇总函数：
 * 汇总本身的语义归 payroll-totals.ts（已冻结），本文件只测 service 的编排、
 * 事务、权限与序列化。课消奖比例那条用 vi.importActual 调真实实现验证。
 */
vi.mock('./payroll-totals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payroll-totals.js')>();
  return {
    ...actual,
    computePayrollSheet: vi.fn(),
    computePayrollForTeacher: vi.fn(),
    computePeriodTotals: vi.fn(),
  };
});

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};
const TEACHER: AuthenticatedUser = {
  id: 'user-t1',
  username: 'teacher',
  displayName: '张老师',
  role: UserRole.TEACHER,
};

function makeRow(overrides: Partial<PayrollComputation> = {}): PayrollComputation {
  return {
    teacherId: 't1',
    teacherName: '张老师',
    teacherStatus: 'ACTIVE',
    attendanceExpected: 20,
    attendanceActual: 18,
    attendanceAbsent: 2,
    baseSalary: dec('5000'),
    pianoBonus: dec('300'),
    recruitBonus: dec('200'),
    performance: dec('1000'),
    commissionRate: dec('0.1'),
    commission: dec('100'),
    grossSalary: dec('5600'),
    deductions: [{ deductionItemId: 'd1', name: '社保', amount: dec('400') }],
    totalDeduction: dec('400'),
    netSalary: dec('5200'),
    confirmedLessonCount: 9,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    payroll: { upsert: vi.fn().mockResolvedValue({ id: 'p1' }) },
    payrollDeduction: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    teacher: { findUnique: vi.fn() },
    deductionItem: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn() },
    // 顶层这些写方法存在只是为了断言「重算没碰它们」
    payroll: { upsert: vi.fn(), update: vi.fn() },
    payrollDeduction: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { prisma, tx };
}

describe('PayrollService', () => {
  let prisma: ReturnType<typeof createPrismaMock>['prisma'];
  let tx: ReturnType<typeof createPrismaMock>['tx'];
  let periods: { assertOpen: ReturnType<typeof vi.fn> };
  let service: PayrollService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computePayrollSheet).mockReset();
    vi.mocked(computePayrollForTeacher).mockReset();
    vi.mocked(computePeriodTotals).mockReset();

    const created = createPrismaMock();
    prisma = created.prisma;
    tx = created.tx;
    periods = { assertOpen: vi.fn().mockResolvedValue(undefined) };
    service = new PayrollService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
    );
  });

  describe('getSheet（US-PR-01）', () => {
    it('逐行序列化成两位小数字符串，底部给出四项合计', async () => {
      vi.mocked(computePayrollSheet).mockResolvedValue([
        makeRow(),
        makeRow({
          teacherId: 't2',
          teacherName: '李老师',
          baseSalary: dec('4000'),
          pianoBonus: dec('0'),
          recruitBonus: dec('0'),
          performance: dec('500'),
          commission: dec('50'),
          grossSalary: dec('4050'),
          deductions: [],
          totalDeduction: dec('0'),
          netSalary: dec('4050'),
          confirmedLessonCount: 5,
        }),
      ]);

      const sheet = await service.getSheet('2026-10');

      expect(computePayrollSheet).toHaveBeenCalledWith(prisma, '2026-10');
      expect(sheet.period).toBe('2026-10');
      expect(sheet.rows).toHaveLength(2);
      expect(sheet.rows[0]).toMatchObject({
        teacherId: 't1',
        teacherName: '张老师',
        attendance: { expected: 20, actual: 18, absent: 2 },
        baseSalary: '5000.00',
        performance: '1000.00',
        commissionRate: '0.10',
        commission: '100.00',
        grossSalary: '5600.00',
        deductions: [{ deductionItemId: 'd1', name: '社保', amount: '400.00' }],
        totalDeduction: '400.00',
        netSalary: '5200.00',
        confirmedLessonCount: 9,
      });
      expect(sheet.totals).toEqual({
        grossTotal: '9650.00',
        netTotal: '9250.00',
        performanceTotal: '1500.00',
        totalDeduction: '400.00',
      });
    });
  });

  describe('recompute（US-PR-03）', () => {
    it('重新汇总并返回结果，全程不写任何工资数据（幂等）', async () => {
      vi.mocked(computePayrollSheet).mockResolvedValue([
        makeRow(),
        makeRow({ performance: dec('500'), confirmedLessonCount: 5 }),
      ]);

      const result = await service.recompute('2026-10');

      expect(result).toEqual({
        period: '2026-10',
        recomputed: true,
        performanceTotal: '1500.00',
        lessonCount: 14,
      });
      expect(prisma.payroll.upsert).not.toHaveBeenCalled();
      expect(prisma.payroll.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('upsertEntry（US-PR-06）', () => {
    it('老师不存在 → 404，且不写库', async () => {
      prisma.teacher.findUnique.mockResolvedValue(null);

      await expect(
        service.upsertEntry('nope', { period: '2026-10', baseSalary: 5000 } as UpsertPayrollDto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('关账月 → 409，且不写库', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      periods.assertOpen.mockRejectedValue(new ConflictException('已关账'));

      await expect(
        service.upsertEntry('t1', { period: '2026-10' } as UpsertPayrollDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(periods.assertOpen).toHaveBeenCalledWith('2026-10');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('引用不存在的代扣项 → 400，且不写库', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      prisma.deductionItem.findMany.mockResolvedValue([{ id: 'd1' }]);

      await expect(
        service.upsertEntry('t1', {
          period: '2026-10',
          deductions: [
            { deductionItemId: 'd1', amount: 100 },
            { deductionItemId: 'd2', amount: 50 },
          ],
        } as UpsertPayrollDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('只提交传了的字段，未传字段不出现在 update data 里', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      vi.mocked(computePayrollForTeacher).mockResolvedValue(makeRow());

      await service.upsertEntry('t1', {
        period: '2026-10',
        baseSalary: 5000,
        pianoBonus: 300,
      } as UpsertPayrollDto);

      const call = tx.payroll.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ teacherId_period: { teacherId: 't1', period: '2026-10' } });
      expect(call.create).toMatchObject({ teacherId: 't1', period: '2026-10' });
      expect(call.create.baseSalary.toString()).toBe('5000');
      expect(Object.keys(call.update).sort()).toEqual(['baseSalary', 'pianoBonus']);
      expect(call.update.baseSalary.toString()).toBe('5000');
      expect(call.update.pianoBonus.toString()).toBe('300');
      expect(call.update).not.toHaveProperty('recruitBonus');
      expect(call.update).not.toHaveProperty('commissionRate');
      expect(call.update).not.toHaveProperty('attendanceExpected');
      // 没传 deductions 时不得动代扣项
      expect(tx.payrollDeduction.deleteMany).not.toHaveBeenCalled();
      expect(tx.payrollDeduction.createMany).not.toHaveBeenCalled();
    });

    it('代扣项在同一事务里先删后建', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      prisma.deductionItem.findMany.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
      vi.mocked(computePayrollForTeacher).mockResolvedValue(makeRow());

      await service.upsertEntry('t1', {
        period: '2026-10',
        deductions: [
          { deductionItemId: 'd1', amount: 100 },
          { deductionItemId: 'd2', amount: 50.5 },
        ],
      } as UpsertPayrollDto);

      expect(prisma.deductionItem.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['d1', 'd2'] } },
        select: { id: true },
      });
      expect(tx.payrollDeduction.deleteMany).toHaveBeenCalledWith({ where: { payrollId: 'p1' } });
      const createCall = tx.payrollDeduction.createMany.mock.calls[0][0];
      expect(createCall.data).toHaveLength(2);
      expect(createCall.data[0]).toMatchObject({ payrollId: 'p1', deductionItemId: 'd1' });
      expect(createCall.data[0].amount.toString()).toBe('100');
      expect(createCall.data[1].amount.toString()).toBe('50.5');
      expect(tx.payrollDeduction.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.payrollDeduction.createMany.mock.invocationCallOrder[0],
      );
    });

    it('传空数组表示清空代扣项：只删不建', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      vi.mocked(computePayrollForTeacher).mockResolvedValue(makeRow({ deductions: [], totalDeduction: dec('0'), netSalary: dec('5600') }));

      await service.upsertEntry('t1', { period: '2026-10', deductions: [] } as UpsertPayrollDto);

      expect(tx.payrollDeduction.deleteMany).toHaveBeenCalledWith({ where: { payrollId: 'p1' } });
      expect(tx.payrollDeduction.createMany).not.toHaveBeenCalled();
    });
  });

  describe('getMine（US-PR-07）', () => {
    it('TEACHER 没关联老师 → 403，不算工资', async () => {
      prisma.user.findUnique.mockResolvedValue({ teacherId: null });

      await expect(service.getMine(TEACHER, '2026-10')).rejects.toBeInstanceOf(ForbiddenException);
      expect(computePayrollForTeacher).not.toHaveBeenCalled();
    });

    it('TEACHER 只取自己关联老师那条', async () => {
      prisma.user.findUnique.mockResolvedValue({ teacherId: 't1' });
      vi.mocked(computePayrollForTeacher).mockResolvedValue(makeRow());

      const result = await service.getMine(TEACHER, '2026-10');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: TEACHER.id },
        select: { teacherId: true },
      });
      expect(computePayrollForTeacher).toHaveBeenCalledWith(prisma, 't1', '2026-10');
      expect(result).toMatchObject({ period: '2026-10', teacherId: 't1', confirmedLessonCount: 9 });
    });

    it('OWNER 没关联老师 → 404（不是 403）', async () => {
      prisma.user.findUnique.mockResolvedValue({ teacherId: null });

      await expect(service.getMine(OWNER, '2026-10')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getTotals（US-PR-05 两口径）', () => {
    it('应发取本月、现金取口径并附上期月份', async () => {
      vi.mocked(computePeriodTotals).mockResolvedValue({
        accruedTotal: dec('12345.6'),
        cashTotal: dec('10000'),
      });

      const result = await service.getTotals('2026-10');

      expect(result).toEqual({
        period: '2026-10',
        accruedTotal: '12345.60',
        cashTotal: '10000.00',
        previousPeriod: '2026-09',
      });
    });
  });

  describe('getColumns（US-PR-04 可选列）', () => {
    it('返回可选列定义，默认关闭', () => {
      expect(service.getColumns()).toEqual([
        { key: 'baseSalary', label: '应发基础工资', defaultEnabled: false },
        { key: 'pianoBonus', label: '钢琴', defaultEnabled: false },
      ]);
      expect(OPTIONAL_PAYROLL_COLUMNS).toHaveLength(2);
    });
  });
});

/**
 * 直接调用 payroll-totals 的真实实现，证明「改比例 → 课消奖/应发即时变化」，
 * 也证明本模块复用的是那份权威实现（没有另写一套口径）。
 */
describe('课消奖比例优先级（复用 payroll-totals 的真实实现）', () => {
  it('工资表逐月比例覆盖老师档案，改比例后课消奖与应发同步变化', async () => {
    const actual = await vi.importActual<typeof import('./payroll-totals.js')>('./payroll-totals.js');

    const totalsPrisma = {
      teacher: {
        findUnique: vi.fn().mockResolvedValue({
          id: 't1',
          name: '张老师',
          status: 'ACTIVE',
          commissionRate: dec('0.1'),
        }),
      },
      lesson: {
        count: vi.fn().mockResolvedValue(1),
        aggregate: vi
          .fn()
          .mockResolvedValue({ _sum: { unitPriceSnapshot: dec('1000') }, _count: { _all: 1 } }),
      },
      payroll: { findUnique: vi.fn() },
      organization: { findFirst: vi.fn().mockResolvedValue({ defaultCommissionRate: dec('0.15') }) },
    };
    const payrollRow = (commissionRate: Prisma.Decimal | null) => ({
      baseSalary: dec('0'),
      pianoBonus: dec('0'),
      recruitBonus: dec('0'),
      commissionRate,
      deductions: [],
    });

    totalsPrisma.payroll.findUnique.mockResolvedValue(payrollRow(null));
    const before = await actual.computePayrollForTeacher(
      totalsPrisma as unknown as PayrollTotalsPrisma,
      't1',
      '2026-10',
    );

    totalsPrisma.payroll.findUnique.mockResolvedValue(payrollRow(dec('0.2')));
    const after = await actual.computePayrollForTeacher(
      totalsPrisma as unknown as PayrollTotalsPrisma,
      't1',
      '2026-10',
    );

    expect(before?.commission.toString()).toBe('100'); // 1000 × 老师档案 0.1
    expect(after?.commission.toString()).toBe('200'); // 1000 × 工资表逐月 0.2
    expect(after?.grossSalary.minus(before?.grossSalary ?? dec('0')).toString()).toBe('100');
  });
});
