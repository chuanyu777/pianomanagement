import type { components } from '@piano/generated-core-client/generated/core-api';
import './student-directory.css';

type DirectoryStudent = Pick<components['schemas']['StudentResponse'], 'id' | 'name' | 'enrollmentStatus'>;
const statusText = (status: string) => ({ STUDYING: '在读', FROZEN: '冻结', WITHDRAWN: '退学' } as Record<string, string>)[status] ?? status;

export function StudentDirectory({ students, selectedId, total, page, pageSize, onSelect, onPage }: { students: readonly DirectoryStudent[]; selectedId: string | undefined; total: number; page: number; pageSize: number; onSelect: (id: string) => void; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return <aside className="student-directory-paged" aria-label="学生列表">
    <div className="student-directory-count" aria-live="polite">{students.length ? `${start + 1}–${start + students.length} / ${total} 位` : '没有符合条件的学生'}</div>
    <div className="student-directory">{students.map(student => <button aria-label={`${student.name} ${statusText(student.enrollmentStatus)}`} aria-pressed={student.id === selectedId} className={student.id === selectedId ? 'is-active' : ''} key={student.id} onClick={() => onSelect(student.id)} type="button"><strong title={student.name}>{student.name}</strong><span>{statusText(student.enrollmentStatus)}</span></button>)}</div>
    {pages > 1 && <nav aria-label="学生目录分页" className="student-directory-pagination"><button aria-label="上一页学生" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">‹</button><span>{page} / {pages}</span><button aria-label="下一页学生" disabled={page >= pages} onClick={() => onPage(page + 1)} type="button">›</button></nav>}
  </aside>;
}
