import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class SourceLinksRepository {
  constructor(private readonly prisma: PrismaService) {}
  student(id: string) { return this.prisma.student.findUnique({ where: { id }, select: { id: true } }); }
  account(id: string) { return this.prisma.studentCourseAccount.findUnique({ where: { id }, select: { id: true, studentId: true } }); }
  async entry(id: string) {
    const entry = await this.prisma.ledgerEntry.findUnique({ where: { id }, select: { id: true, accountId: true, account: { select: { studentId: true } } } });
    return entry ? { id: entry.id, accountId: entry.accountId, studentId: entry.account.studentId } : null;
  }
  lesson(id: string) { return this.prisma.lesson.findUnique({ where: { id }, select: { id: true, teacherId: true, startsAt: true } }); }
}
