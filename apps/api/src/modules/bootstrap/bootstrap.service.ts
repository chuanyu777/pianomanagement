import { ConflictException, Injectable } from '@nestjs/common';
import { hashPassword } from '../../common/password.js';
import { UserRole } from '../../prisma/generated.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * 首次引导（US-IW-01 的前置）。
 *
 * 为什么必须有这个模块：建账号的接口要求「店主」角色，而空库里一个账号都没有 ——
 * 没有引导入口，系统就永远进不去（先有鸡还是先有蛋）。
 *
 * 安全边界：**只在 users 表为空时生效**。一旦有任何一个账号，这个接口就永久关闭，
 * 不会成为一个「谁都能建店主」的后门。所以不需要鉴权。
 */
@Injectable()
export class BootstrapService {
  constructor(private readonly prisma: PrismaService) {}

  async status(): Promise<{ needsBootstrap: boolean }> {
    const count = await this.prisma.user.count();
    return { needsBootstrap: count === 0 };
  }

  async createFirstOwner(input: {
    username: string;
    password: string;
    displayName: string;
    organizationName?: string;
  }) {
    const passwordHash = await hashPassword(input.password);

    return this.prisma.$transaction(async (tx) => {
      // 在事务里再查一次：两个并发请求只有一个能建成功。
      // 放在事务外判断会出现「两个请求都看到 0 个账号、各建一个店主」的窗口。
      const count = await tx.user.count();
      if (count > 0) {
        throw new ConflictException('系统已经初始化过了，请用已有账号登录');
      }

      const owner = await tx.user.create({
        data: {
          username: input.username,
          passwordHash,
          displayName: input.displayName,
          role: UserRole.OWNER,
        },
        select: { id: true, username: true, displayName: true, role: true },
      });

      // 机构单例行一并建出来，免得后续每一步都还要处理「还没建」。
      await tx.organization.upsert({
        where: { singleton: true },
        update: {},
        create: { singleton: true, name: input.organizationName ?? '未命名琴行' },
      });

      return owner;
    });
  }
}
