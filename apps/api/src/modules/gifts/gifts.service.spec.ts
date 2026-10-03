import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { LedgerKind, LessonStatus, Prisma, UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import type { CreateGiftDto } from './dto/create-gift.dto.js';
import { GiftsService } from './gifts.service.js';

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

/**
 * 只 mock 用到的方法，不做「内存数据库替身」。
 * `$transaction` 两种形态都要支持：数组形态（列表）与回调形态（建赠 / 撤销）。
 */
function createPrismaMock() {
  return {
    enrollment: { findUnique: vi.fn() },
    giftGrant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
    },
    ledgerEntry: { create: vi.fn() },
    lesson: { count: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

const VALID_DTO: CreateGiftDto = {
  enrollmentId: 'e1',
  lessons: 10,
  activityName: '双十一活动',
};

describe('GiftsService', () => {
  let prisma: PrismaMock;
  let periods: { assertOpenForDate: ReturnType<typeof vi.fn> };
  let service: GiftsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    periods = { assertOpenForDate: vi.fn().mockResolvedValue(undefined) };
    service = new GiftsService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
    );
  });

  function expectDelta(actual: Prisma.Decimal, expected: string): void {
    expect(actual.equals(new Prisma.Decimal(expected))).toBe(true);
  }

  /** 铺一个「可建赠」的通用桩：报名关系存在 + giftGrant.create 返回带 id 的实体。 */
  function stubGrantable(options: { unitPrice?: string } = {}): void {
    prisma.enrollment.findUnique.mockResolvedValue({
      id: 'e1',
      unitPrice: new Prisma.Decimal(options.unitPrice ?? '300'),
    });
    prisma.giftGrant.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'g1', ...args.data }),
    );
    prisma.ledgerEntry.create.mockResolvedValue({ id: 'entry1' });
  }

  describe('createGift', () => {
    it('默认折算单价取该报名关系的 unitPrice，amount = lessons × unitPrice', async () => {
      stubGrantable({ unitPrice: '300' });

      await service.createGift({ ...VALID_DTO, lessons: 10 }, OWNER);

      const grant = prisma.giftGrant.create.mock.calls[0][0].data;
      expect((grant.unitPrice as Prisma.Decimal).equals(new Prisma.Decimal('300'))).toBe(true);
      expect((grant.amount as Prisma.Decimal).equals(new Prisma.Decimal('3000'))).toBe(true);
      expect(grant.lessons).toBe(10);
      expect(grant.enrollmentId).toBe('e1');
      expect(grant.activityName).toBe('双十一活动');
      expect(grant.grantedById).toBe('owner-1');
    });

    it('传入 unitPrice 时覆盖报名关系单价', async () => {
      stubGrantable({ unitPrice: '300' });

      await service.createGift({ ...VALID_DTO, lessons: 4, unitPrice: 250 }, OWNER);

      const grant = prisma.giftGrant.create.mock.calls[0][0].data;
      expect((grant.unitPrice as Prisma.Decimal).equals(new Prisma.Decimal('250'))).toBe(true);
      expect((grant.amount as Prisma.Decimal).equals(new Prisma.Decimal('1000'))).toBe(true);
    });

    it('金额按分四舍五入：3 × 120.5 = 361.5', async () => {
      stubGrantable();

      await service.createGift({ ...VALID_DTO, lessons: 3, unitPrice: 120.5 }, OWNER);

      const grant = prisma.giftGrant.create.mock.calls[0][0].data;
      expectDelta(grant.amount as Prisma.Decimal, '361.5');
    });

    it('写 GIFT 流水：进赠送池（giftDelta = +amount），实收池不动，并挂上 giftGrantId', async () => {
      stubGrantable({ unitPrice: '300' });

      await service.createGift({ ...VALID_DTO, lessons: 10 }, OWNER);

      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(entry.kind).toBe(LedgerKind.GIFT);
      expect(entry.enrollmentId).toBe('e1');
      expect(entry.giftGrantId).toBe('g1');
      expect(entry.createdById).toBe('owner-1');
      expectDelta(entry.giftDelta, '3000');
      expect((entry.paidDelta as Prisma.Decimal).isZero()).toBe(true);
    });

    it('grantedAt 不传时默认当前时间，并同时用于赠课流水与关账校验', async () => {
      stubGrantable();

      await service.createGift(VALID_DTO, OWNER);

      const grant = prisma.giftGrant.create.mock.calls[0][0].data;
      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(grant.grantedAt).toBeInstanceOf(Date);
      expect(entry.occurredAt).toBeInstanceOf(Date);
      expect(periods.assertOpenForDate.mock.calls[0][0]).toBeInstanceOf(Date);
    });

    it('传入 grantedAt 时按传入值，且赠课流水 occurredAt = grantedAt', async () => {
      stubGrantable();
      const grantedAt = '2026-10-01T02:00:00.000Z';

      await service.createGift({ ...VALID_DTO, grantedAt }, OWNER);

      const grant = prisma.giftGrant.create.mock.calls[0][0].data;
      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(grant.grantedAt).toEqual(new Date(grantedAt));
      expect(entry.occurredAt).toEqual(new Date(grantedAt));
    });

    it('报名关系不存在时报 404，不写库', async () => {
      prisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.createGift(VALID_DTO, OWNER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.giftGrant.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('折算单价 ≤ 0 时报 400（防 0 金额赠送）', async () => {
      stubGrantable();

      await expect(
        service.createGift({ ...VALID_DTO, unitPrice: 0 }, OWNER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.giftGrant.create).not.toHaveBeenCalled();
    });

    it('关账保护：目标月份已锁时 409，且不写流水、不建 grant', async () => {
      stubGrantable();
      periods.assertOpenForDate.mockRejectedValue(new ConflictException('月份 2026-10 已关账'));

      await expect(
        service.createGift({ ...VALID_DTO, grantedAt: '2026-10-05T09:00:00.000Z' }, OWNER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.giftGrant.create).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('revokeGift', () => {
    function stubGrant(): void {
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        enrollmentId: 'e1',
        lessons: 10,
        unitPrice: new Prisma.Decimal('300'),
        amount: new Prisma.Decimal('3000'),
        activityName: '双十一活动',
        grantedAt: new Date('2026-10-01T02:00:00.000Z'),
        grantedById: 'owner-1',
        revokedAt: null,
        revokedById: null,
      });
      prisma.lesson.count.mockResolvedValue(0);
      prisma.ledgerEntry.create.mockResolvedValue({ id: 'rev1' });
      prisma.giftGrant.updateMany.mockResolvedValue({ count: 1 });
    }

    it('已有已确认的赠送课时拒绝撤销（409），且不写任何流水 / 不打撤销标记', async () => {
      stubGrant();
      prisma.lesson.count.mockResolvedValue(2);

      await expect(service.revokeGift('g1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.giftGrant.updateMany).not.toHaveBeenCalled();
    });

    it('已撤销过时报 409，不重复冲回', async () => {
      stubGrant();
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        revokedAt: new Date('2026-10-02T00:00:00.000Z'),
      });

      await expect(service.revokeGift('g1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('赠送不存在时报 404', async () => {
      prisma.giftGrant.findUnique.mockResolvedValue(null);

      await expect(service.revokeGift('nope', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('正常撤销：写 GIFT_REVOKE 负赠送流水 + 给 grant 打 revokedAt / revokedById', async () => {
      stubGrant();

      await service.revokeGift('g1', OWNER);

      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(entry.kind).toBe(LedgerKind.GIFT_REVOKE);
      expect(entry.enrollmentId).toBe('e1');
      expect(entry.giftGrantId).toBe('g1');
      expectDelta(entry.giftDelta, '-3000');
      expect((entry.paidDelta as Prisma.Decimal).isZero()).toBe(true);
      expect(entry.occurredAt).toBeInstanceOf(Date);

      const update = prisma.giftGrant.updateMany.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'g1', revokedAt: null });
      expect(update.data.revokedAt).toBeInstanceOf(Date);
      expect(update.data.revokedById).toBe('owner-1');
    });

    it('关账保护（按撤销新流水的时间）：已关账则 409，不写流水', async () => {
      stubGrant();
      periods.assertOpenForDate.mockRejectedValue(new ConflictException('已关账'));

      await expect(service.revokeGift('g1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('并发兜底：条件更新（revokedAt = null）未命中时 409，不凭空冲回', async () => {
      stubGrant();
      prisma.giftGrant.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revokeGift('g1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listGrants', () => {
    it('按学生 / 课程 / 活动名 / 月份过滤并分页（学生与课程走 enrollment 关系）', async () => {
      prisma.$transaction.mockResolvedValueOnce([[{ id: 'g1', lessons: 10 }], 1]);
      prisma.lesson.groupBy.mockResolvedValue([]);

      const result = await service.listGrants({
        page: 2,
        pageSize: 5,
        studentId: 's1',
        courseTypeId: 'c1',
        activityName: '双十一活动',
        period: '2026-10',
      });

      const where = prisma.giftGrant.findMany.mock.calls[0][0].where;
      expect(where.enrollment).toEqual({ studentId: 's1', courseTypeId: 'c1' });
      expect(where.activityName).toBe('双十一活动');
      expect(where.grantedAt.gte).toEqual(new Date('2026-09-30T16:00:00.000Z'));
      expect(where.grantedAt.lt).toEqual(new Date('2026-10-31T16:00:00.000Z'));
      expect(prisma.giftGrant.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
      expect(result).toEqual({
        items: [{ id: 'g1', lessons: 10, remaining: 10 }],
        total: 1,
        page: 2,
        pageSize: 5,
      });
    });

    it('剩余额度用算的：lessons − 该 grant 下 CONFIRMED 的 Lesson 条数', async () => {
      prisma.$transaction.mockResolvedValueOnce([
        [
          { id: 'g1', lessons: 10 },
          { id: 'g2', lessons: 5 },
        ],
        2,
      ]);
      prisma.lesson.groupBy.mockResolvedValue([
        { giftGrantId: 'g1', _count: { _all: 3 } },
      ]);

      const result = await service.listGrants({ page: 1, pageSize: 20 });

      expect(prisma.lesson.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['giftGrantId'],
          where: {
            giftGrantId: { in: ['g1', 'g2'] },
            status: LessonStatus.CONFIRMED,
          },
        }),
      );
      expect(result.items).toEqual([
        { id: 'g1', lessons: 10, remaining: 7 },
        { id: 'g2', lessons: 5, remaining: 5 },
      ]);
    });

    it('空列表时不发起 lesson.groupBy（避免 in: [] 的无谓查询）', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);

      const result = await service.listGrants({ page: 1, pageSize: 20 });

      expect(prisma.lesson.groupBy).not.toHaveBeenCalled();
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('summaryByActivity', () => {
    it('按活动名汇总营销成本，只计未撤销的赠送', async () => {
      prisma.giftGrant.groupBy.mockResolvedValue([
        { activityName: '双十一活动', _sum: { lessons: 10, amount: new Prisma.Decimal('3000') }, _count: { _all: 2 } },
      ]);

      const result = await service.summaryByActivity();

      expect(prisma.giftGrant.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['activityName'],
          where: { revokedAt: null },
        }),
      );
      expect(result).toEqual([
        { activityName: '双十一活动', totalLessons: 10, totalAmount: '3000.00', grantCount: 2 },
      ]);
    });

    it('聚合值为空时兜底为 0 / 0.00', async () => {
      prisma.giftGrant.groupBy.mockResolvedValue([
        { activityName: '无数据活动', _sum: { lessons: null, amount: null }, _count: { _all: 1 } },
      ]);

      const result = await service.summaryByActivity();

      expect(result).toEqual([
        { activityName: '无数据活动', totalLessons: 0, totalAmount: '0.00', grantCount: 1 },
      ]);
    });
  });
});
