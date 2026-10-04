import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Paginated } from '@piano/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { hashPassword } from '../../common/password.js';
import { UserRole } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

/**
 * 对外可见的用户字段白名单。
 *
 * 用 select 白名单，而不是「查全表再删掉 passwordHash」——
 * 后者在将来加字段时会默认带出去，一次疏忽就是把密码哈希发到浏览器。
 * 所有返回用户的地方都必须走这个常量。
 */
const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  teacherId: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PublicUser = {
  id: string;
  username: string;
  teacherId: string | null;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Prisma 唯一约束冲突的错误码。
 * 用鸭子类型判断而不是 import 生成产物的错误类 —— 生成产物换结构时这里不会跟着炸。
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number): Promise<Paginated<PublicUser>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);

    return { items, total, page, pageSize };
  }

  async getById(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  async create(dto: CreateUserDto): Promise<PublicUser> {
    const passwordHash = await hashPassword(dto.password);

    try {
      if (dto.teacherId) {
        const teacher = await this.prisma.teacher.findUnique({
          where: { id: dto.teacherId },
          select: { id: true },
        });
        if (!teacher) throw new NotFoundException('要关联的老师不存在');
      }

      return await this.prisma.user.create({
        data: {
          username: dto.username,
          passwordHash,
          displayName: dto.displayName,
          role: dto.role,
          isActive: dto.isActive ?? true,
          teacherId: dto.teacherId,
        },
        select: PUBLIC_USER_SELECT,
      });
    } catch (error) {
      // 重名靠数据库的唯一约束兜底，而不是「先查再插」——
      // 两个请求同时插同一个用户名时，先查再插会漏掉，并发下必然翻车。
      if (isUniqueViolation(error)) {
        throw new ConflictException(`用户名 ${dto.username} 已存在`);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser): Promise<PublicUser> {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { role: true, isActive: true },
    });
    if (!current) throw new NotFoundException('用户不存在');

    const nextRole = dto.role ?? current.role;
    const nextActive = dto.isActive ?? current.isActive;
    const losesOwnerRights = current.role === UserRole.OWNER && nextRole !== UserRole.OWNER;
    const getsDeactivated = current.isActive && !nextActive;

    if (current.role === UserRole.OWNER && (losesOwnerRights || getsDeactivated)) {
      await this.assertAnotherActiveOwnerExists(id, '系统必须至少保留一个启用的店主');
    }
    if (id === actor.id && getsDeactivated) {
      throw new ConflictException('不能停用当前登录的账号');
    }

    const data: {
      username?: string;
      teacherId?: string;
      displayName?: string;
      role?: UserRole;
      isActive?: boolean;
      passwordHash?: string;
    } = {};
    if (dto.username !== undefined) data.username = dto.username;
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.teacherId !== undefined) data.teacherId = dto.teacherId;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.password !== undefined) data.passwordHash = await hashPassword(dto.password);

    try {
      return await this.prisma.user.update({ where: { id }, data, select: PUBLIC_USER_SELECT });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`用户名 ${dto.username} 已存在`);
      }
      throw error;
    }
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { role: true, isActive: true },
    });
    if (!current) throw new NotFoundException('用户不存在');
    if (id === actor.id) throw new ConflictException('不能删除当前登录的账号');

    if (current.role === UserRole.OWNER && current.isActive) {
      await this.assertAnotherActiveOwnerExists(id, '系统必须至少保留一个启用的店主');
    }

    await this.prisma.user.delete({ where: { id } });
  }

  /**
   * 「至少留一个启用的店主」是业务规则，只写在这一处。
   * 前端不要也判一遍 —— 前端判断能被绕过，而且是同一规则两份实现。
   */
  private async assertAnotherActiveOwnerExists(
    excludeUserId: string,
    message: string,
  ): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: UserRole.OWNER, isActive: true, id: { not: excludeUserId } },
    });
    if (remaining === 0) throw new ConflictException(message);
  }
}
