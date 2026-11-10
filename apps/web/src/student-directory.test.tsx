import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

afterEach(() => vi.unstubAllGlobals());

function mount(path = '/students', withAccount = false) {
  const students = Array.from({ length: 43 }, (_, i) => ({ id: `s-${i}`, name: `学生${i + 1}`, enrollmentStatus: i === 42 ? 'FROZEN' : 'STUDYING', phone: null, notes: null, createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/students/page?')) {
      const params = new URL(String(input), 'http://localhost').searchParams;
      const matching = students.filter(student => student.name.includes(params.get('q') ?? '') && (!params.get('enrollmentStatus') || student.enrollmentStatus === params.get('enrollmentStatus')));
      const target = params.get('locateStudentId');
      const index = target ? matching.findIndex(student => student.id === target) : -1;
      const page = target ? (index < 0 ? null : Math.floor(index / 8) + 1) : Number(params.get('page') ?? 1);
      return Response.json({ items: page ? matching.slice((page - 1) * 8, page * 8) : [], total: matching.length, page, pageSize: 8 });
    }
    const studentMatch = String(input).match(/^\/api\/students\/(s-\d+)$/);
    if (studentMatch) return Response.json(students.find(student => student.id === studentMatch[1]) ?? {}, { status: students.some(student => student.id === studentMatch[1]) ? 200 : 404 });
    if (String(input).startsWith('/api/students?') || String(input) === '/api/students') {
      const search = new URL(String(input), 'http://localhost').searchParams.get('q') ?? '';
      return new Response(JSON.stringify(students.filter(student => student.name.includes(search))));
    }
    if (String(input).endsWith('/course-accounts')) return new Response(JSON.stringify(withAccount ? [{ id: 'account-1', courseId: 'course-1', courseName: '钢琴', defaultDurationMinutes: 60, currentUnitPrice: '100.00', version: 1 }] : []));
    if (String(input).endsWith('/account-1/ledger')) return Response.json({ accountId: 'account-1', entries: [{ entryId: 'entry-1', occurredAt: '2026-11-02T00:00:00Z', kind: 'PAYMENT', amount: '100.00', paidDelta: '100.00', giftDelta: '0.00', note: null, operator: '店主' }] });
    return new Response('{}', { status: 404 });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><StructuredWorkbench section="students" role="OWNER" /></MemoryRouter></QueryClientProvider>);
}

it('bounds a 43-student directory and preserves the active account context while paging', async () => {
  mount();
  await screen.findByRole('heading', { name: '学生1' });
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  await screen.findByRole('button', { name: '学生1 在读' });
  const directory = screen.getByRole('complementary', { name: '学生列表' });
  expect(within(directory).getAllByRole('button', { name: /^学生\d/ })).toHaveLength(8);
  await userEvent.click(screen.getByRole('button', { name: '下一页学生' }));
  expect(await screen.findByRole('button', { name: '学生9 在读' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '学生1' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '学生9 在读' }));
  expect(screen.getByRole('heading', { name: '学生9' })).toBeInTheDocument();
});

it('requests a bounded student page from the server', async () => {
  mount();
  await screen.findByRole('heading', { name: '学生1' });
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  await screen.findByRole('button', { name: '学生1 在读' });
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/students/page?'))).toBe(true);
});

it('returns to the last available page when a saved page is out of range', async () => {
  mount('/students?page=99');
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  expect(await screen.findByRole('button', { name: '学生43 冻结' })).toBeInTheDocument();
  expect(screen.getByLabelText('学生目录分页')).toHaveTextContent('6 / 6');
});

it('puts a deep-linked student on the visible directory page', async () => {
  mount('/students?student=s-42');
  await screen.findByRole('heading', { name: '学生43' });
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  expect(await screen.findByRole('button', { name: '学生43 冻结' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: '学生43' })).toBeInTheDocument();
});

it('does not silently select a different student when a linked student is unavailable', async () => {
  mount('/students?student=missing-student');
  await screen.findByText('找不到指定学生，请检查链接或重新选择。');
  expect(screen.queryByRole('heading', { name: '学生1' })).not.toBeInTheDocument();
  expect(screen.getByText('找不到指定学生，请检查链接或重新选择。')).toBeInTheDocument();
});

it('does not display another course account when the account in a link is unavailable', async () => {
  mount('/students?student=s-0&account=missing-account&tab=accounts', true);
  await screen.findByRole('heading', { name: '学生1' });
  expect(await screen.findByText('找不到指定课程账户，请检查链接或重新选择。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '登记交费' })).not.toBeInTheDocument();
});

it('locates the linked entry in the specified student account', async () => {
  mount('/students?student=s-0&account=account-1&tab=ledger&entry=entry-1', true);
  const row = (await screen.findByText('店主', { exact: false })).closest('.account-ledger-row');
  expect(row).toHaveAttribute('id', 'account-ledger-entry-1');
  expect(row).toHaveClass('is-linked');
  await userEvent.type(screen.getByRole('textbox', { name: '搜索学生或联系电话' }), '不存在');
  await screen.findByText('没有符合条件的学生');
  expect(screen.getByText('店主', { exact: false }).closest('.account-ledger-row')).toHaveClass('is-linked');
});

it('reports a missing linked entry rather than presenting other entries as the requested one', async () => {
  mount('/students?student=s-0&account=account-1&tab=ledger&entry=missing', true);
  expect(await screen.findByText('找不到指定流水，请检查链接或筛选条件。')).toBeInTheDocument();
});

it('filters the full directory instead of just the visible page', async () => {
  mount();
  await screen.findByRole('heading', { name: '学生1' });
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  await screen.findByRole('button', { name: '学生1 在读' });
  await userEvent.click(screen.getByRole('combobox', { name: '学生学籍筛选' }));
  await userEvent.click(await screen.findByText('冻结', { exact: true }));
  expect(await screen.findByRole('button', { name: '学生43 冻结' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页学生' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '学生1' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '学生43 冻结' }));
  expect(screen.getByRole('heading', { name: '学生43' })).toBeInTheDocument();
});

it('allows selecting a matching result after searching for another student', async () => {
  mount('/students?student=s-0');
  await screen.findByRole('heading', { name: '学生1' });
  await userEvent.click(screen.getByRole('button', { name: '浏览全部学生' }));
  await screen.findByRole('button', { name: '学生1 在读' });
  await userEvent.type(screen.getByRole('textbox', { name: '搜索学生或联系电话' }), '学生43');
  await userEvent.click(await screen.findByRole('button', { name: '学生43 冻结' }));
  expect(await screen.findByRole('heading', { name: '学生43' })).toBeInTheDocument();
});


it('keeps the current student while searching and selects only after a result is chosen', async () => {
  mount('/students?student=s-0');
  await screen.findByRole('heading', { name: '学生1' });
  const search = screen.getByRole('textbox', { name: '搜索学生或联系电话' });
  expect(screen.getByRole('button', { name: '浏览全部学生' })).toBeInTheDocument();
  await userEvent.type(search, '学生43');
  const result = await screen.findByRole('button', { name: '学生43 冻结' });
  expect(screen.getByRole('heading', { name: '学生1' })).toBeInTheDocument();
  await userEvent.click(result);
  expect(await screen.findByRole('heading', { name: '学生43' })).toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: '学生列表' })).not.toBeInTheDocument();
});

it('preserves the selected student and course while searching with no matches and filtering', async () => {
  mount('/students?student=s-0&account=account-1&tab=accounts', true);
  await screen.findByRole('heading', { name: '学生1' });
  expect(await screen.findByRole('heading', { name: '钢琴账户' })).toBeInTheDocument();
  const search = screen.getByRole('textbox', { name: '搜索学生或联系电话' });
  await userEvent.type(search, '不存在');
  await screen.findByText('没有符合条件的学生');
  expect(screen.getByRole('heading', { name: '学生1' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '钢琴账户' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('combobox', { name: '学生学籍筛选' }));
  await userEvent.click(await screen.findByText('冻结', { exact: true }));
  expect(screen.getByRole('heading', { name: '学生1' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '钢琴账户' })).toBeInTheDocument();
});
