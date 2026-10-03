import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, StudentStatus, TeacherStatus } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { EnrollmentsService } from './enrollments.service.js';

function createPrismaMock() {
  return {
    enrollment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    student: { findUnique: vi.fn() },
    teacher: { findUnique: vi.fn() },
    courseType: { findUnique: vi.fn() },
    lesson: { count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    ledgerEntry: { count: vi.fn() },
    $transaction: vi.fn(),
  };
}

const VALID_DTO = {
  studentId: 's1',
  teacherId: 't1',
  courseTypeId: 'c1',
  unitPrice: 200,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
};

describe('EnrollmentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: EnrollmentsService;

  function mockUsableRefs(): void {
    prisma.student.findUnique.mockResolvedValue({ id: 's1', status: StudentStatus.ENROLLED });
    prisma.teacher.findUnique.mockResolvedValue({ id: 't1', status: TeacherStatus.ACTIVE });
    prisma.courseType.findUnique.mockResolvedValue({ id: 'c1', isActive: true });
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new EnrollmentsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('分页 + 按 studentId 过滤', async () => {
      prisma.$transaction.mockResolvedValue([[{ id: 'e1' }], 1]);

      const result = await service.list(1, 20, 's1');

      expect(prisma.enrollment.findMany.mock.calls[0][0]).toEqual(
        expect.objectContaining({ where: { studentId: 's1' }, skip: 0, take: 20 }),
      );
      expect(result).toEqual({ items: [{ id: 'e1' }], total: 1, page: 1, pageSize: 20 });
    });
  });

  describe('getById', () => {
    it('查不到时报 404', async () => {
      prisma.enrollment.findUnique.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('单价为 0 时抛 400，且不写库（0 会让「预计剩余课时」除零）', async () => {
      mockUsableRefs();

      await expect(service.create({ ...VALID_DTO, unitPrice: 0 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.enrollment.create).not.toHaveBeenCalled();
    });

    it('单价为负时抛 400', async () => {
      mockUsableRefs();
      await expect(service.create({ ...VALID_DTO, unitPrice: -10 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('学生不存在时报 404', async () => {
      mockUsableRefs();
      prisma.student.findUnique.mockResolvedValue(null);
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('老师不存在时报 404', async () => {
      mockUsableRefs();
      prisma.teacher.findUnique.mockResolvedValue(null);
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('课程类型不存在时报 404', async () => {
      mockUsableRefs();
      prisma.courseType.findUnique.mockResolvedValue(null);
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('学生已退学时报 400', async () => {
      mockUsableRefs();
      prisma.student.findUnique.mockResolvedValue({ id: 's1', status: StudentStatus.WITHDRAWN });
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('老师已停用时报 400', async () => {
      mockUsableRefs();
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1', status: TeacherStatus.INACTIVE });
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('课程类型已停用时报 400', async () => {
      mockUsableRefs();
      prisma.courseType.findUnique.mockResolvedValue({ id: 'c1', isActive: false });
      await expect(service.create(VALID_DTO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('撞 enrollment_identity 唯一约束时转 409，文案能让人看懂', async () => {
      mockUsableRefs();
      prisma.enrollment.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );

      await expect(service.create(VALID_DTO)).rejects.toThrow(/已有一条报名关系/);
    });

    it('非唯一约束的报错原样往上抛', async () => {
      mockUsableRefs();
      const boom = new Error('connection lost');
      prisma.enrollment.create.mockRejectedValue(boom);

      await expect(service.create(VALID_DTO)).rejects.toBe(boom);
    });

    it('金额字段转成 Decimal，起始余额未传时落 0', async () => {
      mockUsableRefs();
      prisma.enrollment.create.mockResolvedValue({ id: 'e1' });

      await service.create(VALID_DTO);

      const data = prisma.enrollment.create.mock.calls[0][0].data;
      expect(data.unitPrice).toBeInstanceOf(Prisma.Decimal);
      expect(data.unitPrice.equals(new Prisma.Decimal('200'))).toBe(true);
      expect(data.initialPaidBalance).toBeInstanceOf(Prisma.Decimal);
      expect(data.initialPaidBalance.isZero()).toBe(true);
      expect(data.initialGiftBalance.isZero()).toBe(true);
      expect(data.effectiveFrom).toEqual(new Date('2026-10-01T00:00:00.000Z'));
      expect(data.effectiveTo).toBeNull();
    });
  });

  describe('update', () => {
    it('不存在时报 404，且不写库', async () => {
      prisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { unitPrice: 300 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.enrollment.update).not.toHaveBeenCalled();
    });

    it('改单价后只更新 enrollment，绝不碰 lesson —— 已确认课的快照不受影响', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.enrollment.update.mockResolvedValue({ id: 'e1' });

      await service.update('e1', { unitPrice: 350 });

      expect(prisma.enrollment.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { unitPrice: expect.any(Prisma.Decimal) },
      });
      // 历史消费走 Lesson.unitPriceSnapshot，改价不能回写已确认课的单价快照。
      expect(prisma.lesson.update).not.toHaveBeenCalled();
      expect(prisma.lesson.updateMany).not.toHaveBeenCalled();
    });

    it('改成 0 / 负数同样被 400 挡住', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      await expect(service.update('e1', { unitPrice: 0 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.enrollment.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('已有课时 / 台账流水时抛 409，且不删', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.$transaction.mockResolvedValue([4, 0]);

      await expect(service.remove('e1')).rejects.toThrow(/不能删除/);
      expect(prisma.enrollment.delete).not.toHaveBeenCalled();
    });

    it('没有任何历史时才真删', async () => {
      prisma.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.$transaction.mockResolvedValue([0, 0]);
      prisma.enrollment.delete.mockResolvedValue({ id: 'e1' });

      await service.remove('e1');

      expect(prisma.enrollment.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    });
  });
});
