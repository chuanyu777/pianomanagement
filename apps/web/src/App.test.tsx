import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AI workspace', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Agent Runtime unavailable')));
  });

  it('clearly degrades without business data when the assistant is unavailable', async () => {
    renderApp();

    expect(await screen.findByText('AI 助手暂不可用')).toBeInTheDocument();
    expect(screen.getByText(/不会发送到任何模型或业务接口/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生成预览/ })).toBeDisabled();
  });

  it('reflects the Core and Agent availability returned by the status contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            available: true,
            core: { available: true },
            agentRuntime: { available: true },
            checkedAt: '2026-10-16T01:02:03.000Z',
            message: 'AI 助手已连接',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    renderApp();

    expect(await screen.findByLabelText('AI 已连接')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('AI 助手已连接');
    expect(screen.getByText('Core API 已连接')).toBeInTheDocument();
  });

  it('lets a user inspect a structured fallback route without executing a task', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: /学生与账户/ }));

    expect(await screen.findByRole('heading', { name: '学生与账户' })).toBeInTheDocument();
    expect(screen.getByText('Core API / OpenAPI Client 待接入')).toBeInTheDocument();
  });

  it('degrades safely when a 200 response violates the status contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ available: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    renderApp();

    expect(await screen.findByText('AI 助手暂不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生成预览/ })).toBeDisabled();
  });
});
