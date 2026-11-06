import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InternalToolsService } from './internal-tools.service.js';

// This test only runs against the disposable, dedicated candidate-test database.
const databaseUrl = process.env['CORE_CANDIDATE_TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)('course-account candidate identities with isolated PostgreSQL', () => {
  let prisma: PrismaService;
  let service: InternalToolsService;
  const marker = `candidate-${randomUUID()}`;
  const students: string[] = [];
  const users: string[] = [];
  let courseId = '';
  let accountId = '';
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55491' || url.pathname !== '/piano_candidate_test') throw new Error('Dedicated candidate test database required');
    process.env['CORE_DATABASE_URL'] = databaseUrl;
    prisma = new PrismaService();
    service = new InternalToolsService(prisma);
    await prisma.$connect();
    for (let i = 0; i < 2; i++) students.push((await prisma.student.create({ data:{ name:marker } })).id);
    courseId = (await prisma.course.create({ data:{ name:marker, defaultUnitPrice:'10.00', defaultDurationMinutes:60 } })).id;
    accountId = (await prisma.studentCourseAccount.create({ data:{ studentId:students[0]!, courseId, currentUnitPrice:'10.00' } })).id;
    for (const [role, isActive] of [[UserRole.OWNER, true], [UserRole.OWNER, false], [UserRole.TEACHER, true]] as const) {
      users.push((await prisma.user.create({ data:{ username:`${marker}-${users.length}`, passwordHash:'test', role, isActive } })).id);
    }
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.studentCourseAccount.deleteMany({ where:{ id:accountId } });
    await prisma.student.deleteMany({ where:{ id:{ in:students } } });
    await prisma.course.deleteMany({ where:{ id:courseId } });
    await prisma.user.deleteMany({ where:{ id:{ in:users } } });
    await prisma.$disconnect();
  });
  it('returns the exact student association without money and rejects unauthorized subjects', async () => {
    const identities = await service.studentCandidates(users[0]!, { studentName:marker });
    expect(identities.candidates.map(item => item.studentId).sort()).toEqual([...students].sort());
    expect(await service.courseAccountCandidates(users[0]!, { studentName:marker, courseName:marker })).toEqual({ candidates:[{ accountId, studentId:students[0], studentName:marker, courseName:marker }] });
    for (const subject of [users[1]!, users[2]!, randomUUID()]) {
      await expect(service.courseAccountCandidates(subject, { studentName:marker })).rejects.toMatchObject({ status:403 });
      await expect(service.studentCandidates(subject, { studentName:marker })).rejects.toMatchObject({ status:403 });
    }
  });
});
