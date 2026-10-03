import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StudentStatus } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CreateStudentDto } from './dto/create-student.dto.js';
import { StudentsService } from './students.service.js';

function createPrismaMock() {
  return {
    student: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    lesson: { count: vi.fn() },
    refundRecord: { count: vi.fn() },
    ledgerEntry: { count: vi.fn() },
    $transaction: vi.fn(),
  };
}

async function gradeLevelErrors(gradeLevel: unknown): Promise<number> {
  const dto = plainToInstance(CreateStudentDto, { name: '小明', gradeLevel });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'gradeLevel').length;
}

describe('StudentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: StudentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new StudentsService(prisma as unknown as PrismaService);
  });

  describe('CreateStudentDto.gradeLevel', () => {
    it.each([1, 5, 10])('接受 1~10 的整数：%i', async (value) => {
      expect(await gradeLevelErrors(value)).toBe(0);
    });

    it.each([0, 11, -1, 1.5])('拒绝越界或非整数：%p', async (value) => {
      expect(await gradeLevelErrors(value)).toBeGreaterThan(0);
    });
  });

  describe('list', () => {
    it('按分页换算 skip/take，返回分页信封', async () => {
      prisma.$transaction.mockResolvedValue([[{ id: 's1' }], 7]);

      const result = await service.list(3, 20);

      expect(prisma.student.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result).toEqual({ items: [{ id: 's1' }], total: 7, page: 3, pageSize: 20 });
    });

    it('按 status 过滤时，过滤条件同时用于 findMany 与 count', async () => {
      prisma.$transaction.mockResolvedValue([[], 0]);

      await service.list(1, 20, StudentStatus.WITHDRAWN);

      expect(prisma.student.findMany.mock.calls[0][0].where).toEqual({
        status: StudentStatus.WITHDRAWN,
      });
      expect(prisma.student.count.mock.calls[0][0].where).toEqual({
        status: StudentStatus.WITHDRAWN,
      });
    });
  });

  describe('getById', () => {
    it('查不到时报 404', async () => {
      prisma.student.findUnique.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('状态默认在读、退费意向默认 false、备注默认 null', async () => {
      prisma.student.create.mockResolvedValue({ id: 's1' });

      await service.create({ name: '小明', gradeLevel: 3 });

      expect(prisma.student.create).toHaveBeenCalledWith({
        data: {
          name: '小明',
          gradeLevel: 3,
          status: StudentStatus.ENROLLED,
          wantsRefund: false,
          note: null,
        },
      });
    });
  });

  describe('update', () => {
    it('不存在时报 404，且不写库', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: '新名' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.student.update).not.toHaveBeenCalled();
    });

    it('状态流转为 WITHDRAWN 时只写 status', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.student.update.mockResolvedValue({ id: 's1', status: StudentStatus.WITHDRAWN });

      await service.update('s1', { status: StudentStatus.WITHDRAWN });

      expect(prisma.student.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { status: StudentStatus.WITHDRAWN },
      });
    });
  });

  describe('remove', () => {
    it('有排课记录时抛 409，且不删（硬删会连台账一起级联掉）', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.$transaction.mockResolvedValue([3, 0, 0]);

      await expect(service.remove('s1')).rejects.toThrow(/不能删除/);
      expect(prisma.student.delete).not.toHaveBeenCalled();
    });

    it('有退费记录时抛 409', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.$transaction.mockResolvedValue([0, 1, 0]);

      await expect(service.remove('s1')).rejects.toThrow(/不能删除/);
      expect(prisma.student.delete).not.toHaveBeenCalled();
    });

    it('有台账流水时抛 409', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.$transaction.mockResolvedValue([0, 0, 2]);

      await expect(service.remove('s1')).rejects.toThrow(/不能删除/);
      expect(prisma.student.delete).not.toHaveBeenCalled();
    });

    it('没有任何历史时才真删', async () => {
      prisma.student.findUnique.mockResolvedValue({ id: 's1' });
      prisma.$transaction.mockResolvedValue([0, 0, 0]);
      prisma.student.delete.mockResolvedValue({ id: 's1' });

      await service.remove('s1');

      expect(prisma.student.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    });

    it('不存在时报 404', async () => {
      prisma.student.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.student.delete).not.toHaveBeenCalled();
    });
  });
});
