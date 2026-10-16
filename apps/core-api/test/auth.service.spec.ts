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
    } as never);

    const result = await service.login({ username: ' owner ', password: 'correct-password' });

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: { username: 'owner', role: UserRole.OWNER },
    });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.accessToken).toEqual(expect.any(String));
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
});
