import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '../../generated/prisma/client.js';
import { SourceLinksService } from './source-links.service.js';
import type { SourceLinksRepository } from './source-links.repository.js';

describe('source links', () => {
  const repository = { student: vi.fn(), account: vi.fn(), entry: vi.fn(), lesson: vi.fn() };
  const service = new SourceLinksService(repository as unknown as SourceLinksRepository);
  const owner = { id: 'owner', username: 'owner', role: UserRole.OWNER };
  const teacher = { id: 'teacher', username: 'teacher', role: UserRole.TEACHER, teacherId: 't1' };
  it('resolves a ledger entry using authoritative account and student identities', async () => {
    repository.entry.mockResolvedValueOnce({ id: 'e1', accountId: 'a1', studentId: 's1' });
    await expect(service.resolve(owner, 'ledgerEntry', 'e1')).resolves.toEqual({ path: '/students?student=s1&account=a1&tab=ledger&entry=e1' });
  });
  it('hides financial and other teachers’ sources from a teacher', async () => {
    await expect(service.resolve(teacher, 'courseAccount', 'a1')).rejects.toMatchObject({ status: 404 });
    repository.lesson.mockResolvedValueOnce({ id: 'l1', teacherId: 't2', startsAt: new Date('2026-11-01T16:30:00Z') });
    await expect(service.resolve(teacher, 'lesson', 'l1')).rejects.toMatchObject({ status: 404 });
  });
  it('calculates the lesson week in Shanghai', async () => {
    repository.lesson.mockResolvedValueOnce({ id: 'l1', teacherId: 't1', startsAt: new Date('2026-11-01T16:30:00Z') });
    await expect(service.resolve(teacher, 'lesson', 'l1')).resolves.toEqual({ path: '/schedule?week=2026-11-02&lesson=l1' });
  });
  it('links an owner to an explicitly identified report period', async () => {
    await expect(service.resolve(owner, 'report', '2026-11')).resolves.toEqual({ path: '/finance?period=2026-11' });
    await expect(service.resolve(teacher, 'report', '2026-11')).rejects.toMatchObject({ status: 404 });
  });
});
