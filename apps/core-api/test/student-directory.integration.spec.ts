import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, UserRole } from '../src/generated/prisma/client.js';
import { withBusinessTime } from '../src/common/time/business-clock.js';
import { StudentsService } from '../src/modules/students/students.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe.skipIf(!process.env['CORE_DATABASE_URL'])('student directory with PostgreSQL', () => {
  let prisma: PrismaService;
  let service: StudentsService;
  const marker = `directory-${randomUUID()}`;
  const ids: string[] = [];
  let courseId: string;
  let userId: string;
  beforeAll(async () => {
    prisma = new PrismaService();
    service = new StudentsService(prisma);
    await prisma.$connect();
    const course = await prisma.course.create({ data: { name: marker, defaultUnitPrice: '10.00', defaultDurationMinutes: 60 } });
    courseId = course.id;
    userId = (await prisma.user.create({ data: { username: marker, passwordHash: 'test', role: UserRole.OWNER } })).id;
    for (const [suffix, withdrawn, balance, createdAt] of [
      ['A', false, '-0.01', '2026-09-01'], ['B', false, '1.00', '2026-10-01'],
      ['C', true, '-3.00', '2026-09-01'], ['D', false, '0.00', '2026-10-15'],
    ] as const) {
      const student = await prisma.student.create({ data: { name: `${marker}-${suffix}`, phone: suffix === 'B' ? '123456789' : null, withdrawnAt: withdrawn ? new Date('2026-10-01') : null } });
      ids.push(student.id);
      const account = await prisma.studentCourseAccount.create({ data: { studentId: student.id, courseId, currentUnitPrice: '10.00', openingPaidBalance: new Prisma.Decimal(balance).isNegative() ? '0.00' : balance, createdAt: new Date(createdAt) } });
      if (new Prisma.Decimal(balance).isNegative()) await prisma.ledgerEntry.create({ data: { accountId: account.id, kind: 'LESSON_CONSUMPTION', paidDelta: balance, occurredAt: new Date('2026-10-10'), createdById: userId, commandId: randomUUID() } });
    }
  });
  afterAll(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { account: { studentId: { in: ids } } } });
    await prisma.studentCourseAccount.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    if (courseId) await prisma.course.delete({ where: { id: courseId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });
  it('filters before paging with stable order, distinct debt and frozen boundary', async () => {
    await withBusinessTime(new Date('2026-11-01T00:00:00Z'), async () => {
      const page = await service.listPage({ q: marker, page: 2, pageSize: 2 });
      expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2, items: [{ id: ids[2] }, { id: ids[3] }] });
      expect((await service.listPage({ q: marker, page: 1, pageSize: 8, enrollmentStatus: 'FROZEN' })).items.map((s) => s.id)).toEqual([ids[0]]);
      expect((await service.listPage({ q: marker, page: 1, pageSize: 8, enrollmentStatus: 'STUDYING' })).items.map((s) => s.id)).toEqual([ids[1], ids[3]]);
      expect((await service.listPage({ q: marker, page: 1, pageSize: 8, arrears: true })).items.map((s) => s.id)).toEqual([ids[0]]);
      expect((await service.listPage({ q: marker, page: 1, pageSize: 8, arrears: false })).items.map((s) => s.id)).toEqual([ids[1], ids[2], ids[3]]);
      expect((await service.listPage({ q: '123456789', page: 1, pageSize: 8 })).items.map((s) => s.id)).toContain(ids[1]);
      expect((await service.listPage({ q: marker, page: 10, pageSize: 8 })).items).toEqual([]);
      expect(await service.listPage({ q: marker, page: 1, pageSize: 2, locateStudentId: ids[3] })).toMatchObject({ total: 4, page: 2, items: [{ id: ids[2] }, { id: ids[3] }] });
      expect(await service.listPage({ q: marker, page: 1, pageSize: 2, enrollmentStatus: 'FROZEN', locateStudentId: ids[3] })).toMatchObject({ total: 1, page: null, items: [] });
      expect(await service.listPage({ q: marker, page: 1, pageSize: 2, locateStudentId: randomUUID() })).toMatchObject({ total: 4, page: null, items: [] });
      await expect(service.get(ids[2]!)).resolves.toMatchObject({ id: ids[2], enrollmentStatus: 'WITHDRAWN' });
      await expect(service.get(randomUUID())).rejects.toMatchObject({ status: 404 });
    });
  });
  it('locates the correct identity when students have the same name', async () => {
    const duplicate = await prisma.student.create({ data: { name: `${marker}-A` } });
    ids.push(duplicate.id);
    const matchingIds = [ids[0]!, duplicate.id].sort();
    const result = await service.listPage({ q: `${marker}-A`, page: 1, pageSize: 1, locateStudentId: matchingIds[1] });
    expect(result).toMatchObject({ total: 2, page: 2, items: [{ id: matchingIds[1] }] });
  });
});
