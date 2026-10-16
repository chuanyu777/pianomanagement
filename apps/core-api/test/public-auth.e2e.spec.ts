import bcrypt from 'bcrypt';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { UserRole } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('public authentication and teacher API', () => {
    let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
    let baseUrl: string;
    let prisma: PrismaService | undefined;
    const usernames: string[] = [];
    const originalSecret = process.env['JWT_SIGNING_SECRET'];
    const originalCapabilityKey = process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'];
    const originalInternalSecret = process.env['INTERNAL_SERVICE_SECRET'];
    const originalAgentUrl = process.env['AGENT_RUNTIME_URL'];

    beforeAll(async () => {
      process.env['JWT_SIGNING_SECRET'] = 'stage-1-jwt-signing-secret-012345678901234567890123';
      const keys = generateKeyPairSync('ed25519');
      process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'] = Buffer.from(
        keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ).toString('base64');
      process.env['INTERNAL_SERVICE_SECRET'] = 'stage-1-internal-service-secret-012345678901234567890';
      process.env['AGENT_RUNTIME_URL'] = 'http://127.0.0.1:3100';
      app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      app.setGlobalPrefix('api');
      await app.listen({ host: '127.0.0.1', port: 0 });
      baseUrl = await app.getUrl();
      prisma = app.get(PrismaService);
    });

    afterAll(async () => {
      try {
        if (prisma) {
          const teachers = await prisma.teacher.findMany({
            where: { user: { username: { in: usernames } } },
            select: { id: true },
          });
          await prisma.$transaction([
            prisma.teacher.deleteMany({ where: { id: { in: teachers.map(({ id }) => id) } } }),
            prisma.user.deleteMany({ where: { username: { in: usernames } } }),
          ]);
        }
      } finally {
        await app?.close();
        if (originalSecret === undefined) delete process.env['JWT_SIGNING_SECRET'];
        else process.env['JWT_SIGNING_SECRET'] = originalSecret;
        if (originalCapabilityKey === undefined) delete process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'];
        else process.env['CAPABILITY_SIGNING_PRIVATE_KEY_B64'] = originalCapabilityKey;
        if (originalInternalSecret === undefined) delete process.env['INTERNAL_SERVICE_SECRET'];
        else process.env['INTERNAL_SERVICE_SECRET'] = originalInternalSecret;
        if (originalAgentUrl === undefined) delete process.env['AGENT_RUNTIME_URL'];
        else process.env['AGENT_RUNTIME_URL'] = originalAgentUrl;
      }
    });

    it('requires an active owner JWT for teacher management and never returns password hashes', async () => {
      if (!prisma || !app) throw new Error('test application was not initialized');
      const ownerUsername = `owner-${randomUUID()}`;
      const teacherUsername = `teacher-${randomUUID()}`;
      usernames.push(ownerUsername, teacherUsername);
      await prisma.user.create({
        data: {
          username: ownerUsername,
          passwordHash: await bcrypt.hash('correct-owner-password', 4),
          role: UserRole.OWNER,
        },
      });

      const missing = await fetch(`${baseUrl}/api/teachers`);
      expect(missing.status).toBe(401);

      const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ownerUsername, password: 'wrong-password' }),
      });
      expect(await invalidLogin.json()).toMatchObject({ message: '用户名或密码不正确' });

      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ownerUsername, password: 'correct-owner-password' }),
      });
      expect(login.status).toBe(201);
      const session = await login.json() as { accessToken: string; user: Record<string, unknown> };
      expect(session.user).not.toHaveProperty('passwordHash');
      const authorization = { authorization: `Bearer ${session.accessToken}` };

      const me = await fetch(`${baseUrl}/api/auth/me`, { headers: authorization });
      expect(await me.json()).toMatchObject({ username: ownerUsername, role: 'OWNER' });

      const created = await fetch(`${baseUrl}/api/teachers`, {
        method: 'POST',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          username: teacherUsername,
          password: 'a-safe-teacher-password',
          name: '王老师',
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ username: teacherUsername, name: '王老师' });

      const teacherLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: teacherUsername, password: 'a-safe-teacher-password' }),
      });
      const teacherSession = await teacherLogin.json() as { accessToken: string; user: Record<string, unknown> };
      expect(teacherSession.user).toMatchObject({ username: teacherUsername, role: 'TEACHER' });
      const teacherAuthorization = { authorization: `Bearer ${teacherSession.accessToken}` };
      const teacherMe = await fetch(`${baseUrl}/api/auth/me`, { headers: teacherAuthorization });
      expect(await teacherMe.json()).toMatchObject({ username: teacherUsername, teacherId: expect.any(String) });
      const forbidden = await fetch(`${baseUrl}/api/teachers`, { headers: teacherAuthorization });
      expect(forbidden.status).toBe(403);
    });
  });
} else {
  describe.skip('public authentication and teacher API', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
