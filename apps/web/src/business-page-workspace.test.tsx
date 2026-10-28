import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const runId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
const previewId = '1f1d4de6-36cb-4ec2-904d-c522927d8d0c';

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/students']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function previewState(status: 'PENDING' | 'EXECUTED' = 'PENDING', receipt: Record<string, unknown> | null = null) {
  return { previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status, expiresAt: '2099-10-21T02:00:00.000Z', receipt };
}

describe('business page AI workspace', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('pianomanager.accessToken', 'jwt-test');
  });

  it('does not allow confirming a workspace restored from another conversation', async () => {
    window.sessionStorage.setItem('pianomanager.assistant.actor', JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }));
    window.sessionStorage.setItem('pianomanager.assistant.session.v1:u1%3AOWNER%3A', JSON.stringify({
      threadId: 'current-thread', workspaceThreadId: 'old-thread', messages: [],
      workspace: { protocolVersion: '1.0', title: '旧确认单', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '旧收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }], sources: [] },
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState()), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /查看本次对话结果/ }));
    expect(await screen.findByRole('button', { name: '确认并登记' })).toBeDisabled();
  });

  it('shows and confirms a generated workspace on the current business page through the Core preview flow exactly once', async () => {
    const user = userEvent.setup();
    let confirmations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return new Response(JSON.stringify({ id: 'u1', username: 'owner', role: 'OWNER' }), { status: 200 });
      if (path === '/api/assistant/status') return new Response(JSON.stringify({ available: true, core: { available: true }, agentRuntime: { available: true }, checkedAt: '2026-10-28T02:00:00.000Z', message: 'AI 助手已连接' }), { status: 200 });
      if (path === '/api/assistant/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { threadId: string };
        return new Response(JSON.stringify({ runId, threadId: body.threadId, status: 'running' }), { status: 200 });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '学生账户确认单', blocks: [{ type: 'summary', title: '核对收款', text: '学生：小明；金额：¥120.00' }, { type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '确认收款 ¥120.00', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }], sources: [] } })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify(previewState()), { status: 200 });
      if (path === `/api/assistant/previews/${previewId}/confirm` && init?.method === 'POST') {
        confirmations += 1;
        return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: { paymentId: 'payment-1', amount: '120.00' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderApp();
    await user.type(await screen.findByLabelText('学生与账户经营问题'), '办理小明交费120元');
    await user.click(screen.getByRole('button', { name: '发送 ↑' }));

    const workspace = await screen.findByLabelText('工作区内容');
    expect(screen.getByLabelText('业务工作区')).toContainElement(workspace);
    expect(within(workspace).getByText('学生账户确认单')).toBeInTheDocument();
    expect(within(workspace).getByText('学生：小明；金额：¥120.00')).toBeInTheDocument();
    const preview = within(workspace).getByLabelText('操作预览');
    const confirmButton = await within(preview).findByRole('button', { name: '确认并登记' });
    const previewRead = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/previews/${previewId}`);
    expect(new Headers(previewRead?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');

    await user.click(confirmButton);
    await user.click(confirmButton);
    await waitFor(() => expect(confirmations).toBe(1));
    expect(await within(preview).findByText('已确认并执行。')).toBeInTheDocument();
    expect(within(preview).getByText('payment-1')).toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    const confirmationRequest = fetchMock.mock.calls.find(([path, request]) => String(path).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST');
    expect(new Headers(confirmationRequest?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(new Headers(confirmationRequest?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    await user.click(screen.getByRole('button', { name: '返回业务功能' }));
    expect(screen.getByRole('button', { name: /新建学生/ })).toBeInTheDocument();
  });
});
