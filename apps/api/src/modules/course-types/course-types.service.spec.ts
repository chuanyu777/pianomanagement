import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CourseTypesService } from './course-types.service.js';

/**
 * 只 mock 用得到的几个方法，不做「内存数据库替身」——
 * 替身会自己长出一套语义，测出来的绿可能是替身的绿。
 */
function createPrismaMock() {
  return {
    courseType: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    enrollment: { count: vi.fn() },
    lesson: { count: vi.fn() },
    $transaction: vi.fn(),
  };
}

describe('CourseTypesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: CourseTypesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new CourseTypesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('按 sortOrder 升序取全部（含停用项，维护页要看得到）', async () => {
      prisma.courseType.findMany.mockResolvedValue([{ id: 'ct1' }]);

      const result = await service.list();

      expect(prisma.courseType.findMany).toHaveBeenCalledWith({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      expect(result).toEqual([{ id: 'ct1' }]);
    });
  });

  describe('getById', () => {
    it('查不到时报 404', async () => {
      prisma.courseType.findUnique.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('重名撞唯一约束（P2002）转成 409', async () => {
      prisma.courseType.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );

      await expect(service.create({ name: '钢琴' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('非唯一约束的报错原样往上抛，不要被吞掉', async () => {
      const boom = new Error('connection lost');
      prisma.courseType.create.mockRejectedValue(boom);

      await expect(service.create({ name: '钢琴' })).rejects.toBe(boom);
    });

    it('未传 sortOrder / isActive 时落到默认值', async () => {
      prisma.courseType.create.mockResolvedValue({ id: 'ct1' });

      await service.create({ name: '钢琴' });

      expect(prisma.courseType.create).toHaveBeenCalledWith({
        data: { name: '钢琴', sortOrder: 0, isActive: true },
      });
    });
  });

  describe('update', () => {
    it('不存在时报 404，且不写库', async () => {
      prisma.courseType.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { name: '新名' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.courseType.update).not.toHaveBeenCalled();
    });

    it('只提交传了的字段，改名撞唯一约束转 409', async () => {
      prisma.courseType.findUnique.mockResolvedValue({ id: 'ct1' });
      prisma.courseType.update.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      );

      await expect(service.update('ct1', { name: '钢琴' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('停用只需要改 isActive，其余字段不出现在 data 里', async () => {
      prisma.courseType.findUnique.mockResolvedValue({ id: 'ct1' });
      prisma.courseType.update.mockResolvedValue({ id: 'ct1', isActive: false });

      await service.update('ct1', { isActive: false });

      expect(prisma.courseType.update).toHaveBeenCalledWith({
        where: { id: 'ct1' },
        data: { isActive: false },
      });
    });
  });

  describe('remove', () => {
    it('被报名关系引用时抛 409，且不删', async () => {
      prisma.courseType.findUnique.mockResolvedValue({ id: 'ct1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([2, 0]);

      await expect(service.remove('ct1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.courseType.delete).not.toHaveBeenCalled();
    });

    it('被排课引用时抛 409，且不删', async () => {
      prisma.courseType.findUnique.mockResolvedValue({ id: 'ct1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([0, 5]);

      await expect(service.remove('ct1')).rejects.toThrow(/不能删除/);
      expect(prisma.courseType.delete).not.toHaveBeenCalled();
    });

    it('没有任何引用时才真删', async () => {
      prisma.courseType.findUnique.mockResolvedValue({ id: 'ct1', name: '钢琴' });
      prisma.$transaction.mockResolvedValue([0, 0]);
      prisma.courseType.delete.mockResolvedValue({ id: 'ct1' });

      await service.remove('ct1');

      expect(prisma.courseType.delete).toHaveBeenCalledWith({ where: { id: 'ct1' } });
    });

    it('不存在时报 404', async () => {
      prisma.courseType.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.courseType.delete).not.toHaveBeenCalled();
    });
  });
});
