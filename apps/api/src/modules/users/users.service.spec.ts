import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const OWNER: AuthenticatedUser = {
  id: 'owner-1',
  username: 'owner',
  displayName: '店主',
  role: UserRole.OWNER,
};

/**
 * 只 mock 用得到的几个方法，不做「内存数据库替身」——
 * 替身会自己长出一套语义，测出来的绿可能是替身的绿。
 */
function createPrismaMock() {
  return {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: UsersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new UsersService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('把分页参数换算成 skip/take，并原样返回分页信封', async () => {
      prisma.$transaction.mockResolvedValue([[{ id: 'u1' }], 42]);

      const result = await service.list(3, 20);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result).toEqual({ items: [{ id: 'u1' }], total: 42, page: 3, pageSize: 20 });
    });
  });

  describe('getById', () => {
    it('查不到时报 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('入库的是 bcrypt 哈希，不是明文密码', async () => {
      prisma.user.create.mockResolvedValue({ id: 'u1' });

      await service.create({
        username: 'teacher01',
        password: 'plain-password',
        displayName: '张老师',
        role: UserRole.TEACHER,
      });

      const data = prisma.user.create.mock.calls[0][0].data;
      expect(data.passwordHash).not.toBe('plain-password');
      expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('撞唯一约束（P2002）时转成 409，而不是把 Prisma 错误原样抛给前端', async () => {
      prisma.user.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

      await expect(
        service.create({
          username: 'teacher01',
          password: 'plain-password',
          displayName: '张老师',
          role: UserRole.TEACHER,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('非唯一约束的报错要原样往上抛，不要被吞掉', async () => {
      const boom = new Error('connection lost');
      prisma.user.create.mockRejectedValue(boom);

      await expect(
        service.create({
          username: 'teacher01',
          password: 'plain-password',
          displayName: '张老师',
          role: UserRole.TEACHER,
        }),
      ).rejects.toBe(boom);
    });
  });

  describe('update', () => {
    it('把最后一个启用的店主降级 / 停用时拦住，并且不去写库', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.update('owner-1', { role: UserRole.TEACHER }, OWNER)).rejects.toThrow(
        /至少保留一个启用的店主/,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('还有别的启用店主时，允许把当前这个降级', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
      prisma.user.count.mockResolvedValue(1);
      prisma.user.update.mockResolvedValue({ id: 'owner-2' });

      await service.update('owner-2', { role: UserRole.TEACHER }, OWNER);

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'owner-2' }, data: { role: UserRole.TEACHER } }),
      );
    });

    it('不许停用当前登录的账号', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });

      await expect(service.update(OWNER.id, { isActive: false }, OWNER)).rejects.toThrow(
        /不能停用当前登录的账号/,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('只提交传了的字段，没传的不写 undefined', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });
      prisma.user.update.mockResolvedValue({ id: 'u1' });

      await service.update('u1', { displayName: '新名字' }, OWNER);

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({ displayName: '新名字' });
    });

    it('改密码时写入哈希', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });
      prisma.user.update.mockResolvedValue({ id: 'u1' });

      await service.update('u1', { password: 'new-plain-pass' }, OWNER);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(data.passwordHash).not.toBe('new-plain-pass');
    });
  });

  describe('remove', () => {
    it('不许删自己', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });

      await expect(service.remove(OWNER.id, OWNER)).rejects.toThrow(/不能删除当前登录的账号/);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('删掉最后一个启用店主会拦住', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.OWNER, isActive: true });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.remove('owner-9', OWNER)).rejects.toThrow(/至少保留一个启用的店主/);
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('普通老师可以删', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: UserRole.TEACHER, isActive: true });
      prisma.user.delete.mockResolvedValue({ id: 't1' });

      await service.remove('t1', OWNER);

      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    });
  });
});
