import { NotFoundException } from '@nestjs/common';
import { Prisma, TeacherStatus } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TeachersService } from './teachers.service.js';

function createPrismaMock() {
  return {
    teacher: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

describe('TeachersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: TeachersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new TeachersService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('按分页换算 skip/take，原样返回分页信封', async () => {
      prisma.$transaction.mockResolvedValue([[{ id: 't1' }], 3]);

      const result = await service.list(2, 10);

      expect(prisma.teacher.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result).toEqual({ items: [{ id: 't1' }], total: 3, page: 2, pageSize: 10 });
    });

    it('传了 status 就按状态过滤，并把它同时用于 count', async () => {
      prisma.$transaction.mockResolvedValue([[], 0]);

      await service.list(1, 20, TeacherStatus.INACTIVE);

      const findManyArg = prisma.teacher.findMany.mock.calls[0][0];
      const countArg = prisma.teacher.count.mock.calls[0][0];
      expect(findManyArg.where).toEqual({ status: TeacherStatus.INACTIVE });
      expect(countArg.where).toEqual({ status: TeacherStatus.INACTIVE });
    });
  });

  describe('getById', () => {
    it('查不到时报 404', async () => {
      prisma.teacher.findUnique.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('未传的可空字段落成 null，状态默认 ACTIVE', async () => {
      prisma.teacher.create.mockResolvedValue({ id: 't1' });

      await service.create({ name: '张老师' });

      expect(prisma.teacher.create).toHaveBeenCalledWith({
        data: {
          name: '张老师',
          position: null,
          hiredAt: null,
          status: TeacherStatus.ACTIVE,
          commissionRate: null,
          defaultBaseSalary: null,
        },
      });
    });

    it('比例与基本工资转成 Decimal，绝不以 number 落库', async () => {
      prisma.teacher.create.mockResolvedValue({ id: 't1' });

      await service.create({ name: '李老师', commissionRate: 0.15, defaultBaseSalary: 3000 });

      const data = prisma.teacher.create.mock.calls[0][0].data;
      expect(data.commissionRate).toBeInstanceOf(Prisma.Decimal);
      expect(data.commissionRate.equals(new Prisma.Decimal('0.15'))).toBe(true);
      expect(data.defaultBaseSalary).toBeInstanceOf(Prisma.Decimal);
      expect(data.defaultBaseSalary.equals(new Prisma.Decimal('3000'))).toBe(true);
    });
  });

  describe('update', () => {
    it('不存在时报 404，且不写库', async () => {
      prisma.teacher.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: '新名' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.teacher.update).not.toHaveBeenCalled();
    });

    it('停用只改 status，其余字段不出现在 data 里', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      prisma.teacher.update.mockResolvedValue({ id: 't1', status: TeacherStatus.INACTIVE });

      await service.update('t1', { status: TeacherStatus.INACTIVE });

      expect(prisma.teacher.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: TeacherStatus.INACTIVE },
      });
    });

    it('改基本工资时写入的是 Decimal', async () => {
      prisma.teacher.findUnique.mockResolvedValue({ id: 't1' });
      prisma.teacher.update.mockResolvedValue({ id: 't1' });

      await service.update('t1', { defaultBaseSalary: 4200.5 });

      const data = prisma.teacher.update.mock.calls[0][0].data;
      expect(data.defaultBaseSalary).toBeInstanceOf(Prisma.Decimal);
      expect(data.defaultBaseSalary.equals(new Prisma.Decimal('4200.5'))).toBe(true);
    });
  });
});
