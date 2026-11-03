import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe.skipIf(!process.env['CORE_DATABASE_URL'])('source resolution with PostgreSQL and current roles', () => {
  let prisma: PrismaService;
  let owner: { id: string; username: string; role: typeof UserRole.OWNER };
  let teacher: { id: string; username: string; role: typeof UserRole.TEACHER; teacherId: string };
  let other: typeof teacher;
  let studentId: string;
  let accountId: string;
  let lessonId: string;
  let entryId: string;
  let courseId: string;
  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    const o = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test', role: UserRole.OWNER } });
    owner = { id: o.id, username: o.username, role: UserRole.OWNER };
    const makeTeacher = async () => {
      const u = await prisma.user.create({ data: { username: randomUUID(), passwordHash: 'test', role: UserRole.TEACHER } });
      const t = await prisma.teacher.create({ data: { userId: u.id, name: '测试老师' } });
      return { id: u.id, username: u.username, role: UserRole.TEACHER, teacherId: t.id } as const;
    };
    teacher = await makeTeacher(); other = await makeTeacher();
    studentId = (await prisma.student.create({ data: { name: '测试学生' } })).id;
    const course = await prisma.course.create({ data: { name: '测试课程', defaultUnitPrice: '10.00', defaultDurationMinutes: 60 } });
    courseId = course.id;
    accountId = (await prisma.studentCourseAccount.create({ data: { studentId, courseId: course.id, currentUnitPrice: '10.00' } })).id;
    lessonId = (await prisma.lesson.create({ data: { accountId, teacherId: teacher.teacherId, startsAt: new Date('2026-11-01T16:30:00Z'), endsAt: new Date('2026-11-01T17:30:00Z') } })).id;
    entryId = (await prisma.ledgerEntry.create({ data: { accountId, kind: 'GIFT', giftDelta: '10.00', occurredAt: new Date('2026-11-01T16:30:00Z'), createdById: owner.id, commandId: randomUUID() } })).id;
  });
  afterAll(async () => {
    if (entryId) await prisma.ledgerEntry.deleteMany({ where: { id: entryId } });
    if (lessonId) await prisma.lesson.deleteMany({ where: { id: lessonId } });
    if (accountId) await prisma.studentCourseAccount.deleteMany({ where: { id: accountId } });
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    if (courseId) await prisma.course.deleteMany({ where: { id: courseId } });
    const teachers = [teacher?.teacherId, other?.teacherId].filter((id): id is string => Boolean(id));
    await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
    const users = [owner?.id, teacher?.id, other?.id].filter((id): id is string => Boolean(id));
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });
  it('resolves authoritative owner links and only an assigned teacher lesson, with generic denial', async () => {
    const { SourceLinksService } = await import('../src/modules/source-links/source-links.service.js');
    const { SourceLinksRepository } = await import('../src/modules/source-links/source-links.repository.js');
    const service = new SourceLinksService(new SourceLinksRepository(prisma));
    await expect(service.resolve(owner, 'student', studentId)).resolves.toEqual({ path: `/students?student=${studentId}&tab=profile` });
    await expect(service.resolve(owner, 'courseAccount', accountId)).resolves.toEqual({ path: `/students?student=${studentId}&account=${accountId}&tab=accounts` });
    await expect(service.resolve(owner, 'ledgerEntry', entryId)).resolves.toEqual({ path: `/students?student=${studentId}&account=${accountId}&tab=ledger&entry=${entryId}` });
    await expect(service.resolve(teacher, 'lesson', lessonId)).resolves.toEqual({ path: `/schedule?week=2026-11-02&lesson=${lessonId}` });
    for (const [type, id] of [['student', studentId], ['courseAccount', accountId], ['ledgerEntry', entryId], ['lesson', randomUUID()], ['report', '2026-11']] as const) {
      await expect(service.resolve(teacher, type, id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(service.resolve(other, 'lesson', lessonId)).rejects.toMatchObject({ status: 404 });
    await expect(service.resolve(owner, 'report', '2026-11')).resolves.toEqual({ path: '/finance?period=2026-11' });
  });
});
