import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TeachersService } from '../src/modules/teachers/teachers.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('TeachersService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new TeachersService(prisma);
    const auth = new AuthService(prisma);
    const usernames: string[] = [];
    const teacherIds: string[] = [];
    const originalSecret = process.env['JWT_SIGNING_SECRET'];
    const originalTtl = process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];

    beforeAll(async () => {
      process.env['JWT_SIGNING_SECRET'] = 'teacher-account-test-jwt-secret-012345678901234567890123';
      process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = '900';
      await prisma.$connect();
    });

    afterAll(async () => {
      const teachers = await prisma.teacher.findMany({
        where: { OR: [{ user: { username: { in: usernames } } }, { id: { in: teacherIds } }] },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.teacher.deleteMany({ where: { id: { in: teachers.map(({ id }) => id) } } }),
        prisma.user.deleteMany({ where: { username: { in: usernames } } }),
      ]);
      await prisma.$disconnect();
      if (originalSecret === undefined) delete process.env['JWT_SIGNING_SECRET'];
      else process.env['JWT_SIGNING_SECRET'] = originalSecret;
      if (originalTtl === undefined) delete process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'];
      else process.env['JWT_ACCESS_TOKEN_TTL_SECONDS'] = originalTtl;
    });

    it('creates one teacher profile and one teacher user atomically', async () => {
      const username = `teacher-${randomUUID()}`;
      usernames.push(username);
      const created = await service.create({
        username,
        password: 'a-safe-teacher-password',
        name: '王老师',
      });
      teacherIds.push(created.id);

      expect(created).toMatchObject({ username, name: '王老师', isActive: true });
      const stored = await prisma.teacher.findUnique({
        where: { id: created.id },
        select: {
          name: true,
          user: { select: { username: true, role: true, passwordHash: true } },
        },
      });
      expect(stored).toMatchObject({
        name: '王老师',
        user: { username, role: 'TEACHER' },
      });
      expect(stored?.user.passwordHash).not.toBe('a-safe-teacher-password');

      await expect(service.create({
        username,
        password: 'another-safe-password',
        name: '重复账号老师',
      })).rejects.toMatchObject({ status: 409 });
      await expect(prisma.teacher.count({ where: { user: { username } } })).resolves.toBe(1);
    });

    it('opens a login for an existing profile, enforces one-to-one binding, and permits login', async () => {
      const username = `teacher-open-${randomUUID()}`;
      const secondUsername = `teacher-rebind-${randomUUID()}`;
      usernames.push(username, secondUsername);
      const profile = await service.create({ name: '既有教师资料' });
      teacherIds.push(profile.id);
      const opened = await service.openLoginAccount(profile.id, { username, password: 'correct-teacher-password' });
      expect(opened).toMatchObject({ id: profile.id, userId: expect.any(String), username });

      const stored = await prisma.user.findUnique({ where: { username }, select: { passwordHash: true, role: true } });
      expect(stored?.role).toBe('TEACHER');
      expect(stored?.passwordHash).not.toBe('correct-teacher-password');
      await expect(auth.login({ username, password: 'correct-teacher-password' })).resolves.toMatchObject({
        user: { username, role: 'TEACHER', teacherId: profile.id },
      });
      await expect(auth.login({ username, password: 'wrong-teacher-password' })).rejects.toMatchObject({
        status: 401, message: '用户名或密码不正确',
      });

      await expect(service.openLoginAccount(profile.id, { username: secondUsername, password: 'another-safe-password' }))
        .rejects.toMatchObject({ status: 409, message: '教师已绑定登录账号或资料不存在' });
      await expect(prisma.user.findUnique({ where: { username: secondUsername } })).resolves.toBeNull();
    });

    it('rejects duplicate usernames without creating another teacher binding', async () => {
      const username = `teacher-duplicate-${randomUUID()}`;
      usernames.push(username);
      const profile = await service.create({ name: '用户名占用教师' });
      teacherIds.push(profile.id);
      await prisma.user.create({ data: { username, passwordHash: 'not-used', role: 'OWNER' } });

      await expect(service.openLoginAccount(profile.id, { username, password: 'correct-teacher-password' }))
        .rejects.toMatchObject({ status: 409, message: '用户名已存在' });
      await expect(prisma.teacher.findUnique({ where: { id: profile.id }, select: { userId: true } }))
        .resolves.toEqual({ userId: null });
    });
  });
} else {
  describe.skip('TeachersService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
