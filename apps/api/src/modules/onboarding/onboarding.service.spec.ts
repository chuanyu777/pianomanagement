import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { OrganizationService } from '../organization/organization.service.js';
import { OnboardingService, type OnboardingStatus } from './onboarding.service.js';

const dec = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

type OrgRow = Record<string, unknown>;

function createPrismaMock() {
  return {
    user: { count: vi.fn() },
    courseType: { count: vi.fn() },
    teacher: { count: vi.fn() },
    student: { count: vi.fn(), findMany: vi.fn() },
    enrollment: { count: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    incomeItem: { count: vi.fn() },
    expenseItem: { count: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function doneMap(status: OnboardingStatus): Record<string, boolean> {
  return Object.fromEntries(status.steps.map((step) => [step.key, step.done]));
}

describe('OnboardingService', () => {
  let prisma: PrismaMock;
  let organization: {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    markOnboardingCompleted: ReturnType<typeof vi.fn>;
  };
  let items: { seedDefaults: ReturnType<typeof vi.fn> };
  let service: OnboardingService;
  let orgRow: OrgRow;

  function resetOrg(over: OrgRow = {}): void {
    orgRow = {
      id: 'org',
      name: '未命名琴行',
      city: null,
      reporter: null,
      initialCashBalance: dec(0),
      previousMonthProfit: dec(0),
      previousMonthPayroll: dec(0),
      onboardingCompletedAt: null,
      ...over,
    };
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') return (arg as (client: PrismaMock) => unknown)(prisma);
      return Promise.all(arg as readonly unknown[]);
    });
    // 默认所有「至少一个」的计数都满足，个别用例再覆盖
    prisma.user.count.mockResolvedValue(1);
    prisma.courseType.count.mockResolvedValue(1);
    prisma.teacher.count.mockResolvedValue(1);
    prisma.student.count.mockResolvedValue(1);
    prisma.enrollment.count.mockResolvedValue(1);
    prisma.incomeItem.count.mockResolvedValue(1);
    prisma.expenseItem.count.mockResolvedValue(1);
    prisma.student.findMany.mockResolvedValue([]);
    prisma.enrollment.findMany.mockResolvedValue([]);
    prisma.enrollment.update.mockResolvedValue({ id: 'e1' });

    resetOrg();
    organization = {
      get: vi.fn().mockImplementation(() => Promise.resolve(orgRow)),
      update: vi.fn().mockImplementation((data: OrgRow) => {
        Object.assign(orgRow, data);
        return Promise.resolve(orgRow);
      }),
      markOnboardingCompleted: vi.fn().mockImplementation(() => {
        orgRow.onboardingCompletedAt = new Date('2026-10-03T00:00:00.000Z');
        return Promise.resolve(orgRow);
      }),
    };
    items = { seedDefaults: vi.fn().mockResolvedValue({ income: 7, expense: 13, deduction: 6 }) };

    service = new OnboardingService(
      prisma as unknown as PrismaService,
      organization as unknown as OrganizationService,
      items as unknown as ItemsService,
    );
  });

  describe('IW-01 分步向导', () => {
    it('返回 8 个步骤与完成状态；下一步未提交时 previousProfit / previousPayroll 未完成', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三', initialCashBalance: dec('1000') });

      const status = await service.getStatus();

      expect(status.completed).toBe(false);
      expect(status.completedAt).toBeNull();
      expect(status.steps.map((step) => step.key)).toEqual([
        'organization',
        'courseTypes',
        'people',
        'students',
        'cash',
        'previousProfit',
        'previousPayroll',
        'items',
      ]);
      expect(doneMap(status)).toEqual({
        organization: true,
        courseTypes: true,
        people: true,
        students: true,
        cash: true,
        previousProfit: false,
        previousPayroll: false,
        items: true,
      });
    });

    it('现金期初 = 0 时 cash 步未完成（口径是 > 0，不是已录入）', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三', initialCashBalance: dec(0) });

      const status = await service.getStatus();

      expect(doneMap(status).cash).toBe(false);
    });
  });

  describe('IW-02 接续数据', () => {
    it('提交 0 的上月盈利 / 应发工资后，两步都算已完成（0 不是「没录」）', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });

      await service.carryOver({
        initialCashBalance: 1000,
        previousMonthProfit: 0,
        previousMonthPayroll: 0,
      });
      const status = await service.getStatus();

      expect(doneMap(status).previousProfit).toBe(true);
      expect(doneMap(status).previousPayroll).toBe(true);
      expect(doneMap(status).cash).toBe(true);
    });

    it('机构三个值走 OrganizationService.update，只写本次传了的字段', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });
      prisma.student.findMany.mockResolvedValue([{ id: 's1' }]);
      prisma.enrollment.findMany.mockResolvedValue([{ id: 'e1', studentId: 's1' }]);

      await service.carryOver({
        initialCashBalance: 500,
        students: [
          {
            studentId: 's1',
            enrollments: [
              { enrollmentId: 'e1', initialPaidBalance: 3000, initialGiftBalance: 200, unitPrice: 250 },
            ],
          },
        ],
      });

      const orgData = organization.update.mock.calls[0][0] as Record<string, Prisma.Decimal>;
      expect(Object.keys(orgData)).toEqual(['initialCashBalance']);
      expect(orgData.initialCashBalance.equals(new Prisma.Decimal(500))).toBe(true);

      const updateArgs = prisma.enrollment.update.mock.calls[0][0] as {
        where: { id: string };
        data: { initialPaidBalance: Prisma.Decimal; initialGiftBalance: Prisma.Decimal; unitPrice: Prisma.Decimal };
      };
      expect(updateArgs.where).toEqual({ id: 'e1' });
      expect(updateArgs.data.initialPaidBalance.equals(new Prisma.Decimal(3000))).toBe(true);
      expect(updateArgs.data.initialGiftBalance.equals(new Prisma.Decimal(200))).toBe(true);
      expect(updateArgs.data.unitPrice.equals(new Prisma.Decimal(250))).toBe(true);
    });

    it('引用的 enrollment 不属于该 student → 400，且不写任何数据', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });
      prisma.student.findMany.mockResolvedValue([{ id: 's1' }]);
      prisma.enrollment.findMany.mockResolvedValue([{ id: 'e1', studentId: 's2' }]);

      await expect(
        service.carryOver({
          initialCashBalance: 500,
          students: [
            {
              studentId: 's1',
              enrollments: [
                { enrollmentId: 'e1', initialPaidBalance: 0, initialGiftBalance: 0, unitPrice: 300 },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(organization.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.enrollment.update).not.toHaveBeenCalled();
    });

    it('单价 ≤ 0 → 400，不写任何数据', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });
      prisma.student.findMany.mockResolvedValue([{ id: 's1' }]);
      prisma.enrollment.findMany.mockResolvedValue([{ id: 'e1', studentId: 's1' }]);

      await expect(
        service.carryOver({
          students: [
            {
              studentId: 's1',
              enrollments: [
                { enrollmentId: 'e1', initialPaidBalance: 0, initialGiftBalance: 0, unitPrice: 0 },
              ],
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(organization.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /onboarding/complete', () => {
    it('缺「上月应发工资」时 400，提示首月报表将不正确，且不写 onboardingCompletedAt', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });
      // 只提交了现金与上月盈利，没有提交上月应发工资
      await service.carryOver({ initialCashBalance: 1000, previousMonthProfit: 500 });

      let error: unknown;
      try {
        await service.complete();
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('首月报表将不正确');
      expect(organization.markOnboardingCompleted).not.toHaveBeenCalled();
      expect(orgRow.onboardingCompletedAt).toBeNull();
    });

    it('必要项齐全时：seed 默认模板、打上 onboardingCompletedAt，8 步全完成', async () => {
      resetOrg({ name: '星辰琴行', city: '上海', reporter: '张三' });
      await service.carryOver({
        initialCashBalance: 1000,
        previousMonthProfit: 0,
        previousMonthPayroll: 0,
      });

      const status = await service.complete();

      expect(items.seedDefaults).toHaveBeenCalledTimes(1);
      expect(organization.markOnboardingCompleted).toHaveBeenCalledTimes(1);
      expect(status.completed).toBe(true);
      expect(status.completedAt).toBe('2026-10-03T00:00:00.000Z');
      expect(status.steps.every((step) => step.done)).toBe(true);
    });
  });
});
