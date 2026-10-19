import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

function renderApp(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AI workspace', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Agent Runtime unavailable')));
  });

  it('requires login before showing authenticated pages', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: '登录工作台' })).toBeInTheDocument();
    expect(screen.getByLabelText('用户名')).toBeInTheDocument();
  });

  it('logs in, saves the JWT, and uses it to load the live student list', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return Promise.resolve(new Response(JSON.stringify({ accessToken: 'jwt-test', tokenType: 'Bearer', expiresInSeconds: 3600, user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 }));
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify([{ id: 's1', name: '真实学生', notes: null, enrollmentStatus: 'STUDYING', createdAt: '2026-10-16T01:02:03.000Z', updatedAt: '2026-10-16T01:02:03.000Z' }]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/structured/students');
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    expect(await screen.findByText('真实学生')).toBeInTheDocument();
    expect(window.localStorage.getItem('pianomanager.accessToken')).toBe('jwt-test');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/login');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ username: 'owner', password: 'correct-password' });
    const studentsCall = fetchMock.mock.calls.find(([path]) => path === '/api/students');
    expect(new Headers(studentsCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(screen.getByRole('link', { name: /完整业务接口/ })).toHaveAttribute('href', '/api/docs');
  });

  it('loads real schedule records with their related student and course', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/assistant/status'
        ? { available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }
        : [{ id: 'l1', accountId: 'a1', teacherId: 't1', startsAt: '2026-10-17T02:00:00.000Z', endsAt: '2026-10-17T03:00:00.000Z', status: 'SCHEDULED', student: { id: 's1', name: '真实学生' }, course: { id: 'c1', name: '钢琴课' }, unitPriceSnapshot: null }];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    renderApp('/structured/schedule');
    expect(await screen.findByText('钢琴课')).toBeInTheDocument();
    expect(screen.getByText('真实学生')).toBeInTheDocument();
  });

  it('loads and displays monthly report values from Core API', async () => {
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const report = { periodStart: '2026-10-01T00:00:00.000Z', cashIncome: '1200.00', cashExpense: '300.00', cashNet: '900.00', lessonIncome: '800.00', refundFeeIncome: '0.00', manualIncome: '400.00', payrollCost: '100.00', giftCost: '50.00', manualExpense: '200.00', operatingProfit: '850.00' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/assistant/status'
        ? { available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }
        : report;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));
    renderApp('/structured/finance');
    expect(await screen.findByText('¥1200.00')).toBeInTheDocument();
    expect(screen.getByText('经营利润')).toBeInTheDocument();
  });

  it('uses the logged-in JWT and an idempotency key for lesson completion', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/assistant/status') return Promise.resolve(new Response(JSON.stringify({ available: false, core: { available: true }, agentRuntime: { available: false }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手暂不可用' }), { status: 200 }));
      if (path === '/api/lessons') return Promise.resolve(new Response(JSON.stringify([{ id: 'l1', accountId: 'a1', teacherId: 't1', startsAt: '2026-10-17T02:00:00.000Z', endsAt: '2026-10-17T03:00:00.000Z', status: 'SCHEDULED', student: { id: 's1', name: '真实学生' }, course: { id: 'c1', name: '钢琴课' }, unitPriceSnapshot: null }]), { status: 200 }));
      if (path === '/api/students') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path === '/api/teachers') return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path.startsWith('/api/students/') && path.endsWith('/course-accounts')) return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      if (path === '/api/lessons/l1/complete') return Promise.resolve(new Response(JSON.stringify({ id: 'l1' }), { status: 200 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/structured/schedule');

    await user.click(await screen.findByRole('button', { name: '确认上课' }));
    expect(await screen.findByText('课程已确认完成')).toBeInTheDocument();
    const completeCall = fetchMock.mock.calls.find(([path]) => path === '/api/lessons/l1/complete');
    expect(new Headers(completeCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(new Headers(completeCall?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('sends a prompt to the public gateway and displays the streamed reply and final status', async () => {
    const user = userEvent.setup();
    const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/login') return new Response(JSON.stringify({ accessToken: 'jwt-test', user: { id: 'u1', username: 'owner', role: 'OWNER' } }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-16T01:02:03.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({
              type: 'workspace.replace',
              document: {
                protocolVersion: '1.0',
                title: '今日真实经营摘要',
                blocks: [
                  { type: 'summary', title: '排课情况', text: '今日共有 2 节排课。' },
                  { type: 'alert-list', alerts: [{ severity: 'warning', title: '待确认课消', detail: '有 1 节课程等待确认。' }] },
                  { type: 'metric-grid', metrics: [{ label: '今日排课', value: '2 节', tone: 'positive' }] },
                ],
                sources: [],
              },
            })}\n\n`));
            controller.enqueue(encoder.encode('event: assistant.delta\ndata: {"type":"assistant.delta","text":"今天有 2 节真实排课。"}\n\n'));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    await user.type(screen.getByLabelText('用户名'), 'owner');
    await user.type(screen.getByLabelText('密码'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));
    await user.type(await screen.findByLabelText('经营问题'), '查看今日排课');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));

    expect(await screen.findByText('今天有 2 节真实排课。')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '经营工作区' })).toBeInTheDocument();
    expect(screen.getByText('今日真实经营摘要')).toBeInTheDocument();
    expect(screen.getByText('排课情况')).toBeInTheDocument();
    expect(screen.getByText('今日共有 2 节排课。')).toBeInTheDocument();
    expect(screen.getByText('待确认课消')).toBeInTheDocument();
    expect(screen.getByText('有 1 节课程等待确认。')).toBeInTheDocument();
    expect(screen.getByText('今日排课')).toBeInTheDocument();
    expect(screen.getByText('2 节')).toBeInTheDocument();
    expect(await screen.findByText('已完成')).toBeInTheDocument();
    const startCall = fetchMock.mock.calls.find(([path]) => path === '/api/assistant/runs');
    expect(new Headers(startCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    const startBody = JSON.parse(String(startCall?.[1]?.body)) as Record<string, unknown>;
    expect(startBody).toMatchObject({ message: '查看今日排课' });
    expect(startBody.threadId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(startBody.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    const eventsCall = fetchMock.mock.calls.find(([path]) => path === `/api/assistant/runs/${runId}/events`);
    expect(new Headers(eventsCall?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(new Headers(eventsCall?.[1]?.headers).get('x-thread-id')).toBe(startBody.threadId);
  });
});
