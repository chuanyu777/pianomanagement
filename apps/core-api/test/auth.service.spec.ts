import bcrypt from 'bcrypt';
import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../src/generated/prisma/client.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { afterEach, describe, expect, it } from 'vitest';

const originalSecret = process.env['JWT_SIGNING_SECRET'];
const originalTtl = process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];

afterEach(() => {
  if (originalSecret === undefined) delete process.env['JWT_SIGNING_SECRET'];
  else process.env['JWT_SIGNING_SECRET'] = originalSecret;
  if (originalTtl === undefined) delete process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];
  else process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = originalTtl;
});

describe('AuthService', () => {
  it('returns a signed token and public user information without the password hash', async () => {
    process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
    process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = '900';
    const passwordHash = await bcrypt.hash('correct-password', 4);
    const service = new AuthService({
      user: {
        findUnique: async () => ({
          id: '2a23449f-6531-4fc7-ab63-814f65b93cf6',
          username: 'owner',
          passwordHash,
          role: UserRole.OWNER,
          isActive: true,
          teacher: null,
        }),
      },
      refreshToken: {
        deleteMany: async () => ({ count: 0 }),
        create: async () => ({ id: '4a1f0d1e-6f1c-4f40-9d1e-0a6f7c2b9d31' }),
      },
    } as never);

    const result = await service.login({ username: ' owner ', password: 'correct-password' });

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      refreshExpiresInSeconds: 604800,
      user: { username: 'owner', role: UserRole.OWNER },
    });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.refreshToken).not.toEqual(result.accessToken);
  });

  it('uses one public error for unknown users, invalid passwords, and inactive users', async () => {
    process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
    process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = '900';
    const passwordHash = await bcrypt.hash('correct-password', 4);
    const service = new AuthService({
      user: {
        findUnique: async ({ where }: { where: { username: string } }) =>
          where.username === 'inactive'
            ? {
                id: '6e7b8fcb-b4a9-462b-b755-671f64d601ec',
                username: 'inactive',
                passwordHash,
                role: UserRole.TEACHER,
                isActive: false,
                teacher: null,
              }
            : null,
      },
    } as never);

    await expect(service.login({ username: 'missing', password: 'anything' })).rejects.toEqual(
      new UnauthorizedException('用户名或密码不正确'),
    );
    await expect(service.login({ username: 'inactive', password: 'correct-password' })).rejects.toEqual(
      new UnauthorizedException('用户名或密码不正确'),
    );
  });

  it('rotates a valid refresh token and revokes the presented one in the same transaction', async () => {
    process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
    process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = '900';
    const created: Array<Record<string, unknown>> = [];
    const revoked: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const actor = {
      id: '2a23449f-6531-4fc7-ab63-814f65b93cf6',
      username: 'owner',
      role: UserRole.OWNER,
      isActive: true,
      teacher: null,
    };
    const service = new AuthService({
      refreshToken: {
        findUnique: async () => ({
          id: 'old-refresh-id',
          userId: actor.id,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          user: actor,
        }),
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
        refreshToken: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.push(data);
            return { id: 'new-refresh-id' };
          },
          updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            revoked.push({ where, data });
            return { count: 1 };
          },
        },
      }),
    } as never);

    const result = await service.refresh('raw-refresh-token');

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.user).toMatchObject({ username: 'owner', role: UserRole.OWNER });
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.where).toEqual({ id: 'old-refresh-id', revokedAt: null });
    expect(revoked[0]?.data).toMatchObject({ replacedByTokenId: 'new-refresh-id' });
  });

  it('rejects expired or revoked refresh tokens with the same public error', async () => {
    process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
    const user = {
      id: '2a23449f-6531-4fc7-ab63-814f65b93cf6',
      username: 'owner',
      role: UserRole.OWNER,
      isActive: true,
      teacher: null,
    };
    const expired = new AuthService({
      refreshToken: {
        findUnique: async () => ({ id: 'x', userId: user.id, expiresAt: new Date(Date.now() - 1_000), revokedAt: null, user }),
      },
    } as never);
    const revoked = new AuthService({
      refreshToken: {
        findUnique: async () => ({ id: 'x', userId: user.id, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(), user }),
      },
    } as never);
    const missing = new AuthService({ refreshToken: { findUnique: async () => null } } as never);

    const expected = new UnauthorizedException('登录状态无效或已过期');
    await expect(expired.refresh('token')).rejects.toEqual(expected);
    await expect(revoked.refresh('token')).rejects.toEqual(expected);
    await expect(missing.refresh('token')).rejects.toEqual(expected);
    await expect(missing.refresh('   ')).rejects.toEqual(expected);
  });

  it('revokes the presented refresh token on logout and stays idempotent', async () => {
    const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const service = new AuthService({
      refreshToken: {
        updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          calls.push(input);
          return { count: 1 };
        },
      },
    } as never);

    await service.logout('raw-token');
    await service.logout('   ');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.where).toHaveProperty('tokenHash');
    expect(calls[0]?.data).toHaveProperty('revokedAt');
  });
});
