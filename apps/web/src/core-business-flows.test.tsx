import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredWorkbench } from './structured-workbench.js';

const studentId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000002';
const previewId = '40000000-0000-4000-8000-000000000004';

function renderWorkbench(section: 'students' | 'schedule') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[section === 'students' ? '/students' : '/schedule?week=2026-10-26']}>
        <StructuredWorkbench section={section} role="OWNER" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function account() {
  return { id: accountId, courseId: 'course-1', courseName: '钢琴课', defaultDurationMinutes: 60, currentUnitPrice: '300.00', version: 2 };
}

function preview(actionType: string) {
  return { previewId, actionType, schemaVersion: `${actionType}.v1`, riskLevel: 'L2', expiresAt: '2099-10-28T00:00:00.000Z', display: { title: '操作确认单' } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('core structured business flows', () => {
  it('creates a student profile only after generating a Core confirmation preview', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    let submittedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/students') return new Response('[]', { status: 200 });
      if (path === '/api/assistant/previews/structured-action') {
        submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(preview('student.create')), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({ ...preview('student.create'), status: 'PENDING', receipt: null }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench('students');

    await user.click(await screen.findByRole('button', { name: '＋ 新建学生' }));
    await user.type(screen.getByLabelText('姓名'), '  林同学  ');
    await user.type(screen.getByLabelText('备注'), '  周末上课  ');
    await user.click(screen.getByRole('button', { name: '创建学生' }));

    await waitFor(() => expect(submittedBody).not.toBeNull());
    expect(submittedBody).toMatchObject({
      actionType: 'student.create',
      command: { name: '  林同学  ', phone: null, notes: '周末上课' },
    });
    expect(fetchMock.mock.calls.some(([path, request]) => String(path) === '/api/students' && request?.method === 'POST')).toBe(false);
    expect(await screen.findByText('操作确认单')).toBeInTheDocument();
  });

  it('sends payments and gifts through separate Core preview routes with Shanghai business timestamps', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const commands: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/students') return new Response(JSON.stringify([{ id: studentId, name: '小林', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]), { status: 200 });
      if (path === `/api/students/${studentId}/course-accounts`) return new Response(JSON.stringify([account()]), { status: 200 });
      if (path === `/api/student-course-accounts/${accountId}/balance`) return new Response(JSON.stringify({ accountId, paidBalance: '600.00', giftBalance: '0.00', totalBalance: '600.00' }), { status: 200 });
      if (path === '/api/assistant/previews/course-accounts/payment' || path === '/api/assistant/previews/course-accounts/gift') {
        commands.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
        const actionType = path.endsWith('/payment') ? 'course-account.payment' : 'course-account.gift';
        return new Response(JSON.stringify(preview(actionType)), { status: 201 });
      }
      if (path === `/api/assistant/previews/${previewId}`) {
        const actionType = commands.at(-1)?.path.endsWith('/payment') ? 'course-account.payment' : 'course-account.gift';
        return new Response(JSON.stringify({ ...preview(actionType), status: 'PENDING', receipt: null }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWorkbench('students');

    await user.click(await screen.findByRole('button', { name: '登记交费' }));
    await user.clear(screen.getByLabelText('交费金额'));
    await user.type(screen.getByLabelText('交费金额'), '180.00');
    await user.clear(screen.getByLabelText('业务发生时间'));
    await user.type(screen.getByLabelText('业务发生时间'), '2026-10-28T10:30');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));

    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({
      path: '/api/assistant/previews/course-accounts/payment',
      body: { accountId, amount: '180.00', channel: 'CASH', occurredAt: '2026-10-28T10:30:00+08:00' },
    });
    expect(commands[0]?.headers.get('Authorization')).toBe('Bearer jwt-test');
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === '/api/course-accounts/payment' && init?.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: /取\s*消/ }));
    await user.click(screen.getByRole('button', { name: '登记赠送' }));
    await user.clear(screen.getByLabelText('赠送金额'));
    await user.type(screen.getByLabelText('赠送金额'), '30.00');
    await user.clear(screen.getByLabelText('业务发生时间'));
    await user.type(screen.getByLabelText('业务发生时间'), '2026-10-28T11:45');
    await user.click(screen.getByRole('button', { name: '生成确认单' }));

    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toMatchObject({
      path: '/api/assistant/previews/course-accounts/gift',
      body: { accountId, amount: '30.00', occurredAt: '2026-10-28T11:45:00+08:00' },
    });
    expect(commands[1]?.body).not.toHaveProperty('channel');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('places a lesson just after Shanghai midnight in the correct business day column', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith('/api/lessons?')) {
        requests.push(path);
        return new Response(JSON.stringify([{ id: 'lesson-1', accountId, teacherId: 'teacher-1', startsAt: '2026-10-25T16:15:00.000Z', endsAt: '2026-10-25T17:15:00.000Z', status: 'SCHEDULED', student: { id: studentId, name: '小林' }, course: { id: 'course-1', name: '钢琴课' }, unitPriceSnapshot: null }]), { status: 200 });
      }
      if (path === '/api/students') return new Response(JSON.stringify([{ id: studentId, name: '小林', phone: null, notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]), { status: 200 });
      if (path === '/api/teachers') return new Response('[]', { status: 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkbench('schedule');

    const lesson = await screen.findByRole('button', { name: /00:15.*小林.*钢琴课.*待上课/ });
    expect(lesson).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0] ?? '')).toContain('from=2026-10-26T00:00:00+08:00');
    expect(decodeURIComponent(requests[0] ?? '')).toContain('to=2026-11-02T00:00:00+08:00');
  });
});
