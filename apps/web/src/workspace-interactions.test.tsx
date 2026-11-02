import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

afterEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); vi.unstubAllGlobals(); });

function mount(path = '/') {
  window.localStorage.setItem('pianomanager.accessToken', 'test-token');
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const route = String(input);
    requests.push(route);
    if (route === '/api/auth/me') return new Response(JSON.stringify({ id: 'user-1', username: 'owner', role: 'OWNER' }));
    if (route === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-30T02:00:00Z', message: 'AI 助手已连接' }));
    if (route === '/api/dashboard/overview') return new Response(JSON.stringify({ asOf: '2026-10-30T02:00:00Z', businessDate: '2026-10-30', today: { total: 0, pendingCount: 0, completedCount: 0, lessons: [] }, students: { total: 0, frozenCount: 0, arrearsCount: 0 }, finance: { period: '2026-10', operatingProfit: '-99.00', cashNet: '0.00' }, preclose: { period: '2026-10', closed: false, unpaidPayrollCount: 0, blockers: [] }, recentRecords: [] }));
    if (route === '/api/assistant/tasks' || route === '/api/students') return new Response('[]');
    return new Response('{}', { status: 503 });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
  return requests;
}

it.each(['/', '/students'])('sends with Enter and preserves Shift+Enter and IME composition on %s', async (path) => {
  const requests = mount(path);
  const input = await screen.findByRole('textbox', { name: path === '/' ? '经营问题' : '学生与账户经营问题' });
  await userEvent.type(input, '查询今日课程');
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
  expect(requests.filter((route) => route === '/api/assistant/runs')).toHaveLength(0);
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
  expect(input).toHaveValue('查询今日课程\n');
  expect(requests.filter((route) => route === '/api/assistant/runs')).toHaveLength(0);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(requests.filter((route) => route === '/api/assistant/runs')).toHaveLength(1));
});

it('opens finance from the operating-profit card and removes redundant page introductions', async () => {
  mount();
  const card = await screen.findByRole('button', { name: /本月经营利润.*-99.00/ });
  expect(card).toHaveClass('tone-negative');
  expect(screen.queryByText('今天先处理什么？用自然语言描述目标，查询结果和待确认操作都会在同一处连续呈现。')).not.toBeInTheDocument();
  await userEvent.click(card);
  expect(await screen.findByRole('tab', { name: '经营概览' })).toBeInTheDocument();
});
