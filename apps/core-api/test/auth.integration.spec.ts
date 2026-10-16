import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('AuthService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new AuthService(prisma);
    const usernames: string[] = [];
    const originalSecret = process.env['JWT_SIGNING_SECRET'];
    const originalTtl = process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];

    beforeAll(async () => {
      process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
      process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = '900';
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { username: { in: usernames } } });
      await prisma.$disconnect();
      if (originalSecret === undefined) delete process.env['JWT_SIGNING_SECRET'];
      else process.env['JWT_SIGNING_SECRET'] = originalSecret;
      if (originalTtl === undefined) delete process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];
      else process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = originalTtl;
    });

    it('persists unique users and resolves the current active actor from a login token', async () => {
      const username = `owner-${randomUUID()}`;
      usernames.push(username);
      await prisma.user.create({
        data: {
          username,
          passwordHash: await bcrypt.hash('correct-password', 4),
          role: UserRole.OWNER,
        },
      });

      await expect(
        prisma.user.create({
          data: {
            username,
            passwordHash: await bcrypt.hash('another-password', 4),
            role: UserRole.OWNER,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const login = await service.login({ username, password: 'correct-password' });
      const actor = await service.resolveActor(login.accessToken);
      expect(actor).toEqual({ id: expect.any(String), username, role: UserRole.OWNER });
    });
  });
} else {
  describe.skip('AuthService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
