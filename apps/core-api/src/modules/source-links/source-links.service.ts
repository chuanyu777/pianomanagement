import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client.js';
import type { AuthenticatedActor } from '../auth/auth.types.js';
import { SourceLinksRepository } from './source-links.repository.js';

type SourceType = 'student' | 'courseAccount' | 'ledgerEntry' | 'lesson' | 'report';
function weekStart(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (name: string) => Number(parts.find(part => part.type === name)?.value);
  const day = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
}

@Injectable()
export class SourceLinksService {
  constructor(private readonly repository: SourceLinksRepository) {}
  async resolve(actor: AuthenticatedActor, type: SourceType, id: string): Promise<{ path: string }> {
    if (type === 'report' && actor.role === UserRole.OWNER && /^\d{4}-(0[1-9]|1[0-2])$/.test(id)) {
      return { path: `/finance?period=${id}` };
    }
    if (type === 'lesson') {
      const lesson = await this.repository.lesson(id);
      if (lesson && (actor.role === UserRole.OWNER || (actor.role === UserRole.TEACHER && actor.teacherId === lesson.teacherId))) return { path: `/schedule?week=${weekStart(lesson.startsAt)}&lesson=${encodeURIComponent(lesson.id)}` };
    } else if (actor.role === UserRole.OWNER && type === 'student') {
      const student = await this.repository.student(id);
      if (student) return { path: `/students?student=${encodeURIComponent(student.id)}&tab=profile` };
    } else if (actor.role === UserRole.OWNER && type === 'courseAccount') {
      const account = await this.repository.account(id);
      if (account) return { path: `/students?student=${encodeURIComponent(account.studentId)}&account=${encodeURIComponent(account.id)}&tab=accounts` };
    } else if (actor.role === UserRole.OWNER && type === 'ledgerEntry') {
      const entry = await this.repository.entry(id);
      if (entry) return { path: `/students?student=${encodeURIComponent(entry.studentId)}&account=${encodeURIComponent(entry.accountId)}&tab=ledger&entry=${encodeURIComponent(entry.id)}` };
    }
    throw new NotFoundException('记录不存在或当前账号无权访问');
  }
}
