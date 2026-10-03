import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { LedgerKind, Prisma, UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';
import { PaymentsService } from './payments.service.js';

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

/**
 * 只 mock 用到的方法，不做「内存数据库替身」。
 * `$transaction` 的两种形态都要支持：数组形态（列表）与回调形态（记账）。
 */
function createPrismaMock() {
  return {
    enrollment: { findUnique: vi.fn() },
    incomeItem: { findUnique: vi.fn() },
    ledgerEntry: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

const VALID_DTO: CreatePaymentDto = {
  enrollmentId: 'e1',
  amount: 500,
  incomeItemId: 'i1',
};

const ACTIVE_CASH_ITEM = { id: 'i1', isActive: true, autoSource: null };

describe('PaymentsService', () => {
  let prisma: PrismaMock;
  let periods: { assertOpenForDate: ReturnType<typeof vi.fn> };
  let service: PaymentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    periods = { assertOpenForDate: vi.fn().mockResolvedValue(undefined) };
    service = new PaymentsService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
    );
  });

  /** 铺一个「可记账」的通用桩：报名关系存在 + 收入项可用 + 流水写入成功。 */
  function stubBookable(options: { enrollment?: unknown; incomeItem?: unknown } = {}): void {
    prisma.enrollment.findUnique.mockResolvedValue(
      'enrollment' in options ? options.enrollment : { id: 'e1' },
    );
    prisma.incomeItem.findUnique.mockResolvedValue(
      'incomeItem' in options ? options.incomeItem : ACTIVE_CASH_ITEM,
    );
    prisma.ledgerEntry.create.mockResolvedValue({ id: 'entry1' });
  }

  describe('create', () => {
    it('金额进实收池（paidDelta），赠送池不动（giftDelta = 0），kind = PAYMENT', async () => {
      stubBookable();

      await service.create({ ...VALID_DTO, amount: 500 }, OWNER);

      const data = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(data.kind).toBe(LedgerKind.PAYMENT);
      expect(data.enrollmentId).toBe('e1');
      expect(data.incomeItemId).toBe('i1');
      expect(data.createdById).toBe('owner-1');
      expect((data.paidDelta as Prisma.Decimal).equals(new Prisma.Decimal('500'))).toBe(true);
      expect((data.giftDelta as Prisma.Decimal).isZero()).toBe(true);
    });

    it('金额 ≤ 0 时报 400，且不碰任何库', async () => {
      for (const amount of [0, -1]) {
        prisma.ledgerEntry.create.mockClear();
        await expect(service.create({ ...VALID_DTO, amount }, OWNER)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('报名关系不存在时报 400，且不写流水', async () => {
      stubBookable({ enrollment: null });

      await expect(service.create(VALID_DTO, OWNER)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('收入项不存在时报 400', async () => {
      stubBookable({ incomeItem: null });

      await expect(service.create(VALID_DTO, OWNER)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('收入项已停用时报 400', async () => {
      stubBookable({ incomeItem: { ...ACTIVE_CASH_ITEM, isActive: false } });

      await expect(service.create(VALID_DTO, OWNER)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('自动取数项（autoSource 非空）被拒绝手工记账，报 400', async () => {
      stubBookable({ incomeItem: { ...ACTIVE_CASH_ITEM, autoSource: 'PAYMENT' } });

      await expect(service.create(VALID_DTO, OWNER)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('关账保护：目标月份已锁时 409，且不写流水', async () => {
      stubBookable();
      periods.assertOpenForDate.mockRejectedValue(new ConflictException('月份 2026-10 已关账'));

      await expect(
        service.create({ ...VALID_DTO, occurredAt: '2026-10-05T09:00:00.000Z' }, OWNER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('关账校验作用在 occurredAt 上；不传 occurredAt 时默认当前时间', async () => {
      stubBookable();

      await service.create(VALID_DTO, OWNER);

      const checkedDate = periods.assertOpenForDate.mock.calls[0][0] as Date;
      const data = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(checkedDate).toBeInstanceOf(Date);
      expect(data.occurredAt).toBeInstanceOf(Date);
    });

    it('传入 occurredAt 时按传入值记账', async () => {
      stubBookable();
      const occurredAt = '2026-08-15T03:00:00.000Z';

      await service.create({ ...VALID_DTO, occurredAt }, OWNER);

      const data = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(data.occurredAt).toEqual(new Date(occurredAt));
      expect(periods.assertOpenForDate.mock.calls[0][0]).toEqual(new Date(occurredAt));
    });
  });

  describe('list', () => {
    it('只列 PAYMENT 流水，按月份区间过滤，并分页', async () => {
      prisma.$transaction.mockResolvedValueOnce([[{ id: 'entry1' }], 1]);

      const result = await service.list({ page: 2, pageSize: 10, period: '2026-10' });

      const where = prisma.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.kind).toBe(LedgerKind.PAYMENT);
      expect(where.occurredAt.gte).toEqual(new Date('2026-09-30T16:00:00.000Z'));
      expect(where.occurredAt.lt).toEqual(new Date('2026-10-31T16:00:00.000Z'));
      expect(prisma.ledgerEntry.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result).toEqual({ items: [{ id: 'entry1' }], total: 1, page: 2, pageSize: 10 });
    });

    it('按学生筛选时走报名关系，不臆造 ledger 上的 studentId 字段', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);

      await service.list({ page: 1, pageSize: 20, studentId: 's1' });

      const where = prisma.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.enrollment).toEqual({ studentId: 's1' });
      expect(where.enrollmentId).toBeUndefined();
    });

    it('按 enrollment 筛选时直接用 enrollmentId', async () => {
      prisma.$transaction.mockResolvedValueOnce([[], 0]);

      await service.list({ page: 1, pageSize: 20, enrollmentId: 'e9' });

      const where = prisma.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.enrollmentId).toBe('e9');
      expect(where.enrollment).toBeUndefined();
    });
  });
});
