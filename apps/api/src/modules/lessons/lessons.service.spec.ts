import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import {
  ConsumptionOrder,
  LedgerKind,
  LessonStatus,
  Prisma,
  UserRole,
} from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PeriodsService } from '../periods/periods.service.js';
import type { CreateLessonDto } from './dto/create-lesson.dto.js';
import type { UpdateLessonDto } from './dto/update-lesson.dto.js';
import { LessonsService } from './lessons.service.js';

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

const TEACHER_ACTOR: AuthenticatedUser = {
  id: 'user-t1',
  username: 'zhang',
  displayName: '张老师',
  role: UserRole.TEACHER,
};

/**
 * 只 mock 用到的方法，不做「内存数据库替身」。
 * `$transaction` 的两种形态都要支持：数组形态（列表）与回调形态（扣减 / 回冲）。
 */
function createPrismaMock() {
  return {
    lesson: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    enrollment: { findUnique: vi.fn(), findMany: vi.fn() },
    giftGrant: { findUnique: vi.fn() },
    ledgerEntry: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
    organization: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function lessonFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    enrollmentId: 'e1',
    studentId: 's1',
    teacherId: 't1',
    courseTypeId: 'c1',
    scheduledAt: new Date('2026-10-05T09:00:00.000Z'),
    isGift: false,
    giftGrantId: null,
    status: LessonStatus.SCHEDULED,
    unitPriceSnapshot: null,
    confirmedAt: null,
    confirmedById: null,
    note: null,
    ...overrides,
  };
}

const VALID_CREATE: CreateLessonDto = {
  studentId: 's1',
  teacherId: 't1',
  courseTypeId: 'c1',
  scheduledAt: '2026-10-05T09:00:00.000Z',
};

describe('LessonsService', () => {
  let prisma: PrismaMock;
  let periods: { assertOpenForDate: ReturnType<typeof vi.fn> };
  let service: LessonsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (client: PrismaMock) => unknown)(prisma);
      }
      return Promise.all(arg as readonly unknown[]);
    });
    periods = { assertOpenForDate: vi.fn().mockResolvedValue(undefined) };
    service = new LessonsService(
      prisma as unknown as PrismaService,
      periods as unknown as PeriodsService,
    );
  });

  /** 读取某次 ledgerEntry.create 传入的 paidDelta / giftDelta。 */
  function deltasAt(callIndex = 0): { paid: Prisma.Decimal; gift: Prisma.Decimal } {
    const data = prisma.ledgerEntry.create.mock.calls[callIndex][0].data as {
      paidDelta: Prisma.Decimal;
      giftDelta: Prisma.Decimal;
    };
    return { paid: data.paidDelta, gift: data.giftDelta };
  }

  function expectDelta(actual: Prisma.Decimal, expected: string): void {
    expect(actual.equals(new Prisma.Decimal(expected))).toBe(true);
  }

  /** 铺一个「非赠送课确认」的通用桩。 */
  function stubNonGiftConfirm(options: {
    unitPrice?: string;
    paid?: string;
    gift?: string;
    order?: ConsumptionOrder;
    lesson?: Record<string, unknown>;
  }): void {
    prisma.lesson.findUnique.mockResolvedValue(lessonFixture(options.lesson));
    prisma.enrollment.findUnique.mockResolvedValue({
      id: 'e1',
      unitPrice: new Prisma.Decimal(options.unitPrice ?? '200'),
    });
    prisma.enrollment.findMany.mockResolvedValue([
      {
        id: 'e1',
        initialPaidBalance: new Prisma.Decimal(options.paid ?? '0'),
        initialGiftBalance: new Prisma.Decimal(options.gift ?? '0'),
      },
    ]);
    prisma.ledgerEntry.groupBy.mockResolvedValue([]);
    prisma.organization.findFirst.mockResolvedValue({
      consumptionOrder: options.order ?? ConsumptionOrder.GIFT_FIRST,
    });
    prisma.ledgerEntry.create.mockResolvedValue({ id: 'entry1' });
    prisma.lesson.update.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));
  }

  describe('create', () => {
    it('找不到报名关系时报 400，且不写库', async () => {
      prisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.create(VALID_CREATE)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lesson.create).not.toHaveBeenCalled();
    });

    it('同一老师同一小时已排课时报 409', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.lesson.findFirst.mockResolvedValue(lessonFixture({ id: 'l-other' }));

      await expect(service.create(VALID_CREATE)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.create).not.toHaveBeenCalled();
      // 冲突检测只和 SCHEDULED / CONFIRMED 比，日期按整点区间取。
      const where = prisma.lesson.findFirst.mock.calls[0][0].where;
      expect(where.status.in).toEqual([LessonStatus.SCHEDULED, LessonStatus.CONFIRMED]);
      expect(where.scheduledAt.gte).toEqual(new Date('2026-10-05T09:00:00.000Z'));
      expect(where.scheduledAt.lt).toEqual(new Date('2026-10-05T10:00:00.000Z'));
    });

    it('赠送课没指定 giftGrantId 时报 400', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.lesson.findFirst.mockResolvedValue(null);

      await expect(service.create({ ...VALID_CREATE, isGift: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.lesson.create).not.toHaveBeenCalled();
    });

    it('赠送额度已撤销时报 409', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.lesson.findFirst.mockResolvedValue(null);
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        enrollmentId: 'e1',
        lessons: 10,
        unitPrice: new Prisma.Decimal('300'),
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      await expect(
        service.create({ ...VALID_CREATE, isGift: true, giftGrantId: 'g1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.create).not.toHaveBeenCalled();
    });

    it('赠送额度已被已确认课用满时报 409', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.lesson.findFirst.mockResolvedValue(null);
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        enrollmentId: 'e1',
        lessons: 3,
        unitPrice: new Prisma.Decimal('300'),
        revokedAt: null,
      });
      prisma.lesson.count.mockResolvedValue(3);

      await expect(
        service.create({ ...VALID_CREATE, isGift: true, giftGrantId: 'g1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.create).not.toHaveBeenCalled();
    });

    it('正常创建：绑定 enrollment，非赠送课时 giftGrantId 落 null', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({
        id: 'e1',
        studentId: 's1',
        teacherId: 't1',
        courseTypeId: 'c1',
      });
      prisma.lesson.findFirst.mockResolvedValue(null);
      prisma.lesson.create.mockResolvedValue(lessonFixture());

      await service.create(VALID_CREATE);

      expect(prisma.enrollment.findUnique).toHaveBeenCalledWith({
        where: {
          enrollment_identity: { studentId: 's1', teacherId: 't1', courseTypeId: 'c1' },
        },
      });
      const data = prisma.lesson.create.mock.calls[0][0].data;
      expect(data.enrollmentId).toBe('e1');
      expect(data.isGift).toBe(false);
      expect(data.giftGrantId).toBeNull();
      expect(data.scheduledAt).toEqual(new Date('2026-10-05T09:00:00.000Z'));
    });
  });

  describe('update', () => {
    it('已确认的课不允许改时间，报 409 且不写库', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));

      await expect(
        service.update('l1', { scheduledAt: '2026-10-06T09:00:00.000Z' } as UpdateLessonDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('已确认的课不允许改课程，报 409', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));

      await expect(
        service.update('l1', { courseTypeId: 'c2' } as UpdateLessonDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('改排课时间时重新做冲突检测', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture());
      prisma.lesson.findFirst.mockResolvedValue(lessonFixture({ id: 'l-other' }));

      await expect(
        service.update('l1', { scheduledAt: '2026-10-06T09:00:00.000Z' } as UpdateLessonDto),
      ).rejects.toBeInstanceOf(ConflictException);
      // 排除自己，避免把本课当成冲突。
      expect(prisma.lesson.findFirst.mock.calls[0][0].where.id).toEqual({ not: 'l1' });
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('只改备注时不重新校验赠送额度（额度被别的课用满也不该误报 409）', async () => {
      prisma.lesson.findUnique.mockResolvedValue(
        lessonFixture({ isGift: true, giftGrantId: 'g1' }),
      );
      prisma.lesson.update.mockResolvedValue(lessonFixture({ note: '调课' }));

      await service.update('l1', { note: '调课' } as UpdateLessonDto);

      expect(prisma.giftGrant.findUnique).not.toHaveBeenCalled();
      expect(prisma.lesson.count).not.toHaveBeenCalled();
      expect(prisma.lesson.update).toHaveBeenCalledWith({
        where: { id: 'l1' },
        data: { note: '调课' },
      });
    });

    it('改课程时必须能重新找到对应的报名关系，找不到报 400', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture());
      prisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.update('l1', { courseTypeId: 'c2' } as UpdateLessonDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });
  });

  describe('confirm（非赠送课 · 扣池口径）', () => {
    it('关账保护：目标月份已锁时 409，且不写任何流水', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture());
      periods.assertOpenForDate.mockRejectedValue(new ConflictException('已关账'));

      await expect(service.confirm('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('GIFT_FIRST：赠送池不够时正确溢出到实收池', async () => {
      stubNonGiftConfirm({ unitPrice: '200', gift: '50', paid: '1000' });

      await service.confirm('l1', OWNER);

      const { paid, gift } = deltasAt();
      expectDelta(gift, '-50'); // 赠送池只够 50
      expectDelta(paid, '-150'); // 余下 150 走实收池
    });

    it('PAID_FIRST：实收池不够时溢出到赠送池', async () => {
      stubNonGiftConfirm({ unitPrice: '200', paid: '80', gift: '500', order: ConsumptionOrder.PAID_FIRST });

      await service.confirm('l1', OWNER);

      const { paid, gift } = deltasAt();
      expectDelta(paid, '-80');
      expectDelta(gift, '-120');
    });

    it('两池都为空时允许扣成负数（欠费是合法状态，不做截断）', async () => {
      stubNonGiftConfirm({ unitPrice: '200', paid: '0', gift: '0' });

      await service.confirm('l1', OWNER);

      const { paid, gift } = deltasAt();
      expectDelta(paid, '-200');
      expectDelta(gift, '0');
    });

    it('某个池已经是负数时，不拿负数当可用额度（max(balance, 0)）', async () => {
      // 赠送池欠费 -30，实收池 100，消费 100：赠送池可用额应视为 0。
      stubNonGiftConfirm({ unitPrice: '100', paid: '100', gift: '-30' });

      await service.confirm('l1', OWNER);

      const { paid, gift } = deltasAt();
      expectDelta(paid, '-100');
      expectDelta(gift, '0');
    });

    it('确认时锁定 enrollment 当前单价快照，并写入 CONFIRMED / confirmedAt', async () => {
      stubNonGiftConfirm({ unitPrice: '350', paid: '1000' });

      await service.confirm('l1', OWNER);

      const update = prisma.lesson.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'l1' });
      expect(update.data.status).toBe(LessonStatus.CONFIRMED);
      expect(update.data.confirmedAt).toBeInstanceOf(Date);
      expect(update.data.confirmedById).toBe(OWNER.id);
      expect((update.data.unitPriceSnapshot as Prisma.Decimal).equals(new Prisma.Decimal('350'))).toBe(
        true,
      );
      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(entry.kind).toBe(LedgerKind.CONSUMPTION);
      expect(entry.lessonId).toBe('l1');
      expect(entry.occurredAt).toBeInstanceOf(Date);
    });
  });

  describe('confirm（赠送课）', () => {
    it('赠送课按 GiftGrant.unitPrice 扣赠送池，而不是当前单价', async () => {
      prisma.lesson.findUnique.mockResolvedValue(
        lessonFixture({ isGift: true, giftGrantId: 'g1' }),
      );
      prisma.enrollment.findUnique.mockResolvedValue({
        id: 'e1',
        unitPrice: new Prisma.Decimal('200'), // 当前单价（不该被使用）
      });
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        enrollmentId: 'e1',
        unitPrice: new Prisma.Decimal('300'), // 赠送时锁定的单价
        revokedAt: null,
      });
      prisma.ledgerEntry.create.mockResolvedValue({ id: 'entry1' });
      prisma.lesson.update.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));

      await service.confirm('l1', OWNER);

      const { paid, gift } = deltasAt();
      expectDelta(gift, '-300');
      expectDelta(paid, '0');
      const entry = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(entry.giftGrantId).toBe('g1');
      // 赠送课不查扣池顺序，也不产生实收池扣减。
      expect(prisma.organization.findFirst).not.toHaveBeenCalled();
    });

    it('赠送额度已撤销时拒绝确认', async () => {
      prisma.lesson.findUnique.mockResolvedValue(
        lessonFixture({ isGift: true, giftGrantId: 'g1' }),
      );
      prisma.enrollment.findUnique.mockResolvedValue({
        id: 'e1',
        unitPrice: new Prisma.Decimal('200'),
      });
      prisma.giftGrant.findUnique.mockResolvedValue({
        id: 'g1',
        enrollmentId: 'e1',
        unitPrice: new Prisma.Decimal('300'),
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      await expect(service.confirm('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('confirm（幂等与权限）', () => {
    it('重复确认第二次报 409，且流水条数不变', async () => {
      stubNonGiftConfirm({ unitPrice: '200', paid: '1000' });
      prisma.lesson.findUnique
        .mockResolvedValueOnce(lessonFixture({ status: LessonStatus.SCHEDULED }))
        .mockResolvedValueOnce(lessonFixture({ status: LessonStatus.CONFIRMED }));

      await service.confirm('l1', OWNER);
      await expect(service.confirm('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.ledgerEntry.create).toHaveBeenCalledTimes(1);
      expect(prisma.lesson.update).toHaveBeenCalledTimes(1);
    });

    it('老师确认不是自己名下的课 → 403，且不写流水', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ teacherId: 't1' }));
      prisma.user.findUnique.mockResolvedValue({ teacherId: 't2' }); // 登录账号关联的是别的老师

      await expect(service.confirm('l1', TEACHER_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('老师账号没有关联老师档案时 → 403', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ teacherId: 't1' }));
      prisma.user.findUnique.mockResolvedValue({ teacherId: null });

      await expect(service.confirm('l1', TEACHER_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('老师确认自己的课 → 正常通过', async () => {
      stubNonGiftConfirm({ unitPrice: '200', paid: '1000' });
      prisma.user.findUnique.mockResolvedValue({ teacherId: 't1' });

      await service.confirm('l1', TEACHER_ACTOR);

      expect(prisma.ledgerEntry.create).toHaveBeenCalledTimes(1);
    });

    it('非 SCHEDULED 状态不能确认（CANCELLED）→ 409', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CANCELLED }));

      await expect(service.confirm('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('课不存在 → 404', async () => {
      prisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.confirm('l1', OWNER)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel / markLeave', () => {
    it('取消未确认的课：只改状态，不产生任何流水', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.SCHEDULED }));
      prisma.lesson.update.mockResolvedValue(lessonFixture({ status: LessonStatus.CANCELLED }));

      await service.cancel('l1', OWNER);

      expect(prisma.lesson.update).toHaveBeenCalledWith({
        where: { id: 'l1' },
        data: { status: LessonStatus.CANCELLED },
      });
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(periods.assertOpenForDate).not.toHaveBeenCalled();
    });

    it('取消已确认的课：追加反向流水，绝不 UPDATE 原流水', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));
      prisma.ledgerEntry.findFirst
        .mockResolvedValueOnce({
          id: 'orig1',
          enrollmentId: 'e1',
          paidDelta: new Prisma.Decimal('-200'),
          giftDelta: new Prisma.Decimal('0'),
          giftGrantId: null,
        })
        .mockResolvedValueOnce(null); // 尚未被回冲
      prisma.ledgerEntry.create.mockResolvedValue({ id: 'rev1' });
      prisma.lesson.update.mockResolvedValue(lessonFixture({ status: LessonStatus.CANCELLED }));

      await service.cancel('l1', OWNER);

      const data = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(data.kind).toBe(LedgerKind.CONSUMPTION_REVERSAL);
      expect(data.lessonId).toBe('l1');
      expect(data.reversesEntryId).toBe('orig1');
      expect((data.paidDelta as Prisma.Decimal).equals(new Prisma.Decimal('200'))).toBe(true);
      expect((data.giftDelta as Prisma.Decimal).equals(new Prisma.Decimal('0'))).toBe(true);
      expect(data.occurredAt).toBeInstanceOf(Date);
      // 原流水只追加回冲，绝不原地修改。
      expect(prisma.ledgerEntry.update).not.toHaveBeenCalled();
      expect(prisma.ledgerEntry.updateMany).not.toHaveBeenCalled();
      expect(prisma.lesson.update).toHaveBeenCalledWith({
        where: { id: 'l1' },
        data: { status: LessonStatus.CANCELLED },
      });
      expect(periods.assertOpenForDate).toHaveBeenCalledTimes(1);
    });

    it('请假已确认的课：同样回冲，状态 → LEAVE', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));
      prisma.ledgerEntry.findFirst
        .mockResolvedValueOnce({
          id: 'orig1',
          enrollmentId: 'e1',
          paidDelta: new Prisma.Decimal('0'),
          giftDelta: new Prisma.Decimal('-300'),
          giftGrantId: 'g1',
        })
        .mockResolvedValueOnce(null);
      prisma.ledgerEntry.create.mockResolvedValue({ id: 'rev1' });
      prisma.lesson.update.mockResolvedValue(lessonFixture({ status: LessonStatus.LEAVE }));

      await service.markLeave('l1', OWNER);

      const data = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(data.kind).toBe(LedgerKind.CONSUMPTION_REVERSAL);
      expect(data.giftGrantId).toBe('g1');
      expect((data.giftDelta as Prisma.Decimal).equals(new Prisma.Decimal('300'))).toBe(true);
      expect(prisma.lesson.update).toHaveBeenCalledWith({
        where: { id: 'l1' },
        data: { status: LessonStatus.LEAVE },
      });
    });

    it('原流水已被回冲过时给出可读 409，不再追加', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));
      prisma.ledgerEntry.findFirst
        .mockResolvedValueOnce({ id: 'orig1', enrollmentId: 'e1', paidDelta: new Prisma.Decimal('-200'), giftDelta: new Prisma.Decimal('0'), giftGrantId: null })
        .mockResolvedValueOnce({ id: 'rev-existing' });

      await expect(service.cancel('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('回冲撞唯一约束（P2002）时转成可读 409，而不是抛数据库原始错误', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CONFIRMED }));
      prisma.ledgerEntry.findFirst
        .mockResolvedValueOnce({ id: 'orig1', enrollmentId: 'e1', paidDelta: new Prisma.Decimal('-200'), giftDelta: new Prisma.Decimal('0'), giftGrantId: null })
        .mockResolvedValueOnce(null);
      prisma.ledgerEntry.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );

      await expect(service.cancel('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
    });

    it('老师取消别人的课 → 403', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ teacherId: 't1' }));
      prisma.user.findUnique.mockResolvedValue({ teacherId: 't2' });

      await expect(service.cancel('l1', TEACHER_ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });

    it('重复取消 → 409', async () => {
      prisma.lesson.findUnique.mockResolvedValue(lessonFixture({ status: LessonStatus.CANCELLED }));

      await expect(service.cancel('l1', OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.lesson.update).not.toHaveBeenCalled();
    });
  });

  describe('列表', () => {
    it('list 按老师 + 日期区间过滤并分页', async () => {
      prisma.$transaction.mockResolvedValueOnce([[{ id: 'l1' }], 1]);

      const result = await service.list({
        page: 2,
        pageSize: 10,
        teacherId: 't1',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-31T23:59:59.000Z',
      });

      const where = prisma.lesson.findMany.mock.calls[0][0].where;
      expect(where.teacherId).toBe('t1');
      expect(where.scheduledAt.gte).toEqual(new Date('2026-10-01T00:00:00.000Z'));
      expect(where.scheduledAt.lte).toEqual(new Date('2026-10-31T23:59:59.000Z'));
      expect(prisma.lesson.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result).toEqual({ items: [{ id: 'l1' }], total: 1, page: 2, pageSize: 10 });
    });

    it('listPendingForTeacher 只取该老师 SCHEDULED 的课', async () => {
      prisma.lesson.findMany.mockResolvedValue([{ id: 'l1' }]);

      const result = await service.listPendingForTeacher('t1');

      expect(prisma.lesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teacherId: 't1', status: LessonStatus.SCHEDULED },
        }),
      );
      expect(result).toEqual([{ id: 'l1' }]);
    });

    it('老师请求别人的待确认列表 → 403', async () => {
      prisma.user.findUnique.mockResolvedValue({ teacherId: 't1' });

      await expect(service.listPending(TEACHER_ACTOR, 't2')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
