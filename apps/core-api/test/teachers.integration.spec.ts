import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TeachersService } from '../src/modules/teachers/teachers.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const hasDatabase = Boolean(process.env['CORE_DATABASE_URL']);

if (hasDatabase) {
  describe('TeachersService with real PostgreSQL', () => {
    const prisma = new PrismaService();
    const service = new TeachersService(prisma);
    const usernames: string[] = [];

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      const teachers = await prisma.teacher.findMany({
        where: { user: { username: { in: usernames } } },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.teacher.deleteMany({ where: { id: { in: teachers.map(({ id }) => id) } } }),
        prisma.user.deleteMany({ where: { username: { in: usernames } } }),
      ]);
      await prisma.$disconnect();
    });

    it('creates one teacher profile and one teacher user atomically', async () => {
      const username = `teacher-${randomUUID()}`;
      usernames.push(username);
      const created = await service.create({
        username,
        password: 'a-safe-teacher-password',
        name: '王老师',
      });

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
  });
} else {
  describe.skip('TeachersService with real PostgreSQL', () => {
    it('requires CORE_DATABASE_URL', () => undefined);
  });
}
