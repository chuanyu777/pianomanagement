import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

const student = { id: 's1', name: '小林', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });
function mount(section: 'schedule' | 'students', path: string, accountResponse: () => Response) {
  window.localStorage.setItem('pianomanager.accessToken', 'test');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/lessons?')) return Response.json([]);
    if (url === '/api/students') return Response.json([student]);
    if (url.startsWith('/api/students/page?')) return Response.json({ items: [student], total: 1, page: 1, pageSize: 8 });
    if (url === '/api/students/s1/course-accounts') return accountResponse();
    if (url === '/api/teachers' || url === '/api/courses') return Response.json([]);
    return new Response('{}', { status: 404 });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><StructuredWorkbench section={section} role="OWNER" /></MemoryRouter></QueryClientProvider>);
}
async function selectStudent() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '＋ 新建排课' }));
  await user.click(screen.getByRole('combobox', { name: '学生' }));
  await user.click(await screen.findByText('小林'));
  return user;
}
it('guides an accountless student to payment and refreshes accounts without losing the schedule form', async () => {
  let paid = false;
  mount('schedule', '/schedule?week=2026-10-26', () => Response.json(paid ? [{ id: 'a1', courseId: 'c1', courseName: '主课', defaultDurationMinutes: 45, currentUnitPrice: '200.00', version: 1 }] : []));
  const user = await selectStudent();
  expect(await screen.findByText(/暂无课程账户.*先缴费/)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: '为小林缴费' });
  expect(link).toHaveAttribute('href', '/students?student=s1&tab=accounts&action=payment');
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('button', { name: '生成确认单' })).toBeDisabled();
  paid = true;
  await user.click(screen.getByRole('button', { name: '重新读取课程账户' }));
  await user.click(screen.getByRole('combobox', { name: '课程账户' }));
  expect(await screen.findByText('主课（45 分钟）')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '学生' }).closest('.ant-select')).toHaveTextContent('小林');
});
it('reports account query failure without offering payment or treating it as empty, and permits retry', async () => {
  let failed = true;
  mount('schedule', '/schedule', () => failed ? new Response('{}', { status: 500 }) : Response.json([]));
  const user = await selectStudent();
  expect(await screen.findByText('课程账户读取失败，请重试')).toBeInTheDocument();
  expect(screen.queryByText(/暂无课程账户.*先缴费/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /缴费/ })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '课程账户' })).toBeDisabled();
  failed = false;
  await user.click(screen.getByRole('button', { name: '重新读取课程账户' }));
  expect(await screen.findByRole('link', { name: '为小林缴费' })).toBeInTheDocument();
});
it('opens payment for the linked student only after their accounts load', async () => {
  mount('students', '/students?student=s1&tab=accounts&action=payment', () => Response.json([]));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/小林/)).toBeInTheDocument();
  expect(within(dialog).getByRole('combobox', { name: '缴费课程' })).toBeInTheDocument();
});
it('does not open linked payment when account loading fails', async () => {
  mount('students', '/students?student=s1&tab=accounts&action=payment', () => new Response('{}', { status: 500 }));
  expect(await screen.findByText('暂时无法读取课程账户')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
