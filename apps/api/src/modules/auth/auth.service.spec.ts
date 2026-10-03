import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { hashPassword } from '../../common/password.js';
import { UserRole } from '../../prisma/generated.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';

const CORRECT_PASSWORD = 'correct-horse-battery';

function createPrismaMock() {
  return { user: { findUnique: vi.fn() } };
}

function createJwtMock() {
  return { signAsync: vi.fn().mockResolvedValue('signed.jwt.token') };
}

async function buildService() {
  const prisma = createPrismaMock();
  const jwt = createJwtMock();
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
  );
  return { prisma, jwt, service };
}

describe('AuthService.login', () => {
  it('登录成功后返回 token 和用户信息，且不含 passwordHash', async () => {
    const { prisma, service } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'owner',
      displayName: '店主',
      role: UserRole.OWNER,
      isActive: true,
      passwordHash: await hashPassword(CORRECT_PASSWORD),
    });

    const result = await service.login({ username: 'owner', password: CORRECT_PASSWORD });

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user).toEqual({
      id: 'u1',
      username: 'owner',
      displayName: '店主',
      role: UserRole.OWNER,
    });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result)).not.toContain('$2');
  });

  it('用户不存在、密码错、账号停用 —— 三种失败对外必须是同一句话', async () => {
    const messages: string[] = [];

    // 1) 用户不存在
    {
      const { prisma, service } = await buildService();
      prisma.user.findUnique.mockResolvedValue(null);
      await service
        .login({ username: 'ghost', password: 'whatever' })
        .catch((e: UnauthorizedException) => messages.push(e.message));
    }
    // 2) 密码错
    {
      const { prisma, service } = await buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        username: 'owner',
        displayName: '店主',
        role: UserRole.OWNER,
        isActive: true,
        passwordHash: await hashPassword(CORRECT_PASSWORD),
      });
      await service
        .login({ username: 'owner', password: 'wrong-password' })
        .catch((e: UnauthorizedException) => messages.push(e.message));
    }
    // 3) 账号已停用（密码是对的也一样拒）
    {
      const { prisma, service } = await buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        username: 'owner',
        displayName: '店主',
        role: UserRole.OWNER,
        isActive: false,
        passwordHash: await hashPassword(CORRECT_PASSWORD),
      });
      await service
        .login({ username: 'owner', password: CORRECT_PASSWORD })
        .catch((e: UnauthorizedException) => messages.push(e.message));
    }

    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });

  it('停用的账号即使密码正确也不发 token', async () => {
    const { prisma, jwt, service } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'owner',
      displayName: '店主',
      role: UserRole.OWNER,
      isActive: false,
      passwordHash: await hashPassword(CORRECT_PASSWORD),
    });

    await expect(
      service.login({ username: 'owner', password: CORRECT_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('token 里只放 sub，不放角色 —— 角色要从库里现查', async () => {
    const { prisma, jwt, service } = await buildService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'owner',
      displayName: '店主',
      role: UserRole.OWNER,
      isActive: true,
      passwordHash: await hashPassword(CORRECT_PASSWORD),
    });

    await service.login({ username: 'owner', password: CORRECT_PASSWORD });

    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1' });
  });
});

describe('AuthService.findIdentity', () => {
  it('按 id 查当前身份，缺字段时返回 null 由上层处理', async () => {
    const { prisma, service } = await buildService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.findIdentity('ghost')).resolves.toBeNull();
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ghost' } }),
    );
  });
});
