import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const runId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
const previewId = '1f1d4de6-36cb-4ec2-904d-c522927d8d0c';

function renderApp(path = '/students') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
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

  it('keeps recovered preview protections and confirmed receipts when moving through a business page', async () => {
    const key = 'pianomanager.assistant.session.v1:u1%3AOWNER%3A';
    window.sessionStorage.setItem(key, JSON.stringify({
      threadId: 'current-thread', messages: [{ id: 'm1', role: 'user', text: '继续处理' }],
      workspaceThreadId: 'current-thread', requireCorePreviewDisplay: true, confirmedPreviewIds: [previewId],
      workspace: { protocolVersion: '1.0', title: '历史确认单', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '旧收款', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }], sources: [] },
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === `/api/assistant/previews/${previewId}`) return Response.json(previewState());
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    expect(await screen.findByText('继续处理')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /查看本次对话结果/ }));
    expect((await screen.findAllByText('系统未提供当前确认内容，已禁止确认。请重新生成确认单。')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '确认并登记' })).not.toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ requireCorePreviewDisplay: true, confirmedPreviewIds: [previewId] });
  });

  it('shares the current conversation across business pages and the home page', async () => {
    const user = userEvent.setup();
    const bodies: Array<{ message: string; threadId: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { message: string; threadId: string };
        bodies.push(body);
        return Response.json({ runId, threadId: body.threadId, status: 'running' });
      }
      if (path === `/api/assistant/runs/${runId}/events`) return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '已收到' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    await user.type(await screen.findByLabelText('学生与账户经营问题'), '第一句话');
    await user.click(screen.getByRole('button', { name: '发送 ↑' }));
    await screen.findByText('已收到');
    await user.click(screen.getByRole('button', { name: /排课与课消/ }));
    expect(await screen.findByText('第一句话')).toBeInTheDocument();
    await user.type(screen.getByLabelText('排课与课消经营问题'), '第二句话');
    await user.click(screen.getByRole('button', { name: '发送 ↑' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.threadId).toBe(bodies[0]?.threadId);
    await user.click(screen.getByRole('button', { name: /今日中枢/ }));
    expect(await screen.findByText('第一句话')).toBeInTheDocument();
    expect(screen.getByText('第二句话')).toBeInTheDocument();
    await user.type(screen.getByLabelText('经营问题'), '第三句话');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]?.threadId).toBe(bodies[0]?.threadId);
  });

  it('recovers an in-flight reply when navigating to another page', async () => {
    const user = userEvent.setup();
    let streams = 0;
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === '/api/assistant/runs') {
        starts += 1;
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return Response.json({ runId, threadId: body.threadId, status: 'running' });
      }
      if (path === `/api/assistant/runs/${runId}/events`) {
        streams += 1;
        if (streams === 1) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '跨页面完整回复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    await user.type(await screen.findByLabelText('学生与账户经营问题'), '查询');
    await user.click(screen.getByRole('button', { name: '发送 ↑' }));
    await waitFor(() => expect(streams).toBe(1));
    await user.click(screen.getByRole('button', { name: /排课与课消/ }));
    expect(await screen.findByText('跨页面完整回复')).toBeInTheDocument();
    expect(screen.getByText('查询')).toBeInTheDocument();
    expect(starts).toBe(1);
  });

  it('recovers a run whose creation finishes after navigation', async () => {
    const user = userEvent.setup();
    let resolveStart: (() => void) | undefined;
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === '/api/assistant/runs') {
        starts += 1;
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Promise<Response>((resolve) => { resolveStart = () => resolve(Response.json({ runId, threadId: body.threadId, status: 'running' })); });
      }
      if (path === `/api/assistant/runs/${runId}/events`) return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '创建后恢复的回复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    renderApp();
    await user.type(await screen.findByLabelText('学生与账户经营问题'), '查询');
    await user.click(screen.getByRole('button', { name: '发送 ↑' }));
    await waitFor(() => expect(resolveStart).toBeDefined());
    await user.click(screen.getByRole('button', { name: /排课与课消/ }));
    expect(await screen.findByLabelText('排课与课消经营问题')).toBeDisabled();
    await act(async () => resolveStart!());
    expect(await screen.findByText('创建后恢复的回复')).toBeInTheDocument();
    expect(starts).toBe(1);
  });

  it.each([
    ['/students', '学生与账户经营问题', '发送 ↑', /今日中枢/, '经营问题'],
    ['/', '经营问题', /发送消息/, /学生与账户/, '学生与账户经营问题'],
  ])('recovers creation across navigation from %s without another run', async (path, inputLabel, sendLabel, destination, nextLabel) => {
    const user = userEvent.setup();
    let resolveStart: (() => void) | undefined;
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (requestPath === '/api/assistant/runs') {
        starts += 1;
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return new Promise<Response>((resolve) => { resolveStart = () => resolve(Response.json({ runId, threadId: body.threadId, status: 'running' })); });
      }
      if (requestPath === `/api/assistant/runs/${runId}/events`) return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '跨首页恢复回复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    renderApp(path);
    await user.type(await screen.findByLabelText(inputLabel), '跨页查询');
    await user.click(screen.getByRole('button', { name: sendLabel }));
    await waitFor(() => expect(resolveStart).toBeDefined());
    await user.click(within(screen.getByLabelText('主导航')).getByRole('button', { name: destination }));
    expect(await screen.findByLabelText(nextLabel)).toBeDisabled();
    await act(async () => resolveStart!());
    expect(await screen.findByText('跨首页恢复回复')).toBeInTheDocument();
    expect(starts).toBe(1);
  });

  it.each([
    ['/students', '学生与账户经营问题', '发送 ↑', /今日中枢/],
    ['/', '经营问题', /发送消息/, /学生与账户/],
  ])('replays the known run when navigating from %s', async (path, inputLabel, sendLabel, destination) => {
    const user = userEvent.setup();
    let starts = 0;
    let streams = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (requestPath === '/api/assistant/runs') {
        starts += 1;
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return Response.json({ runId, threadId: body.threadId, status: 'running' });
      }
      if (requestPath === `/api/assistant/runs/${runId}/events`) {
        streams += 1;
        if (streams === 1) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '首页业务页续接回复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    }));
    renderApp(path);
    await user.type(await screen.findByLabelText(inputLabel), '继续查询');
    await user.click(screen.getByRole('button', { name: sendLabel }));
    await waitFor(() => expect(streams).toBe(1));
    await user.click(within(screen.getByLabelText('主导航')).getByRole('button', { name: destination }));
    expect(await screen.findByText('首页业务页续接回复')).toBeInTheDocument();
    expect(starts).toBe(1);
  });

  it.each([
    ['/students', '学生与账户经营问题', '发送 ↑'],
    ['/', '经营问题', /发送消息/],
  ])('recovers the known run after reloading %s without creating another', async (path, inputLabel, sendLabel) => {
    const user = userEvent.setup();
    let starts = 0;
    let streams = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = String(input);
      if (requestPath === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (requestPath === '/api/assistant/runs') {
        starts += 1;
        const body = JSON.parse(String(init?.body)) as { threadId: string };
        return Response.json({ runId, threadId: body.threadId, status: 'running' });
      }
      if (requestPath === `/api/assistant/runs/${runId}/events`) {
        streams += 1;
        if (streams === 1) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
        return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '刷新后完整回复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 404 });
    }));
    const view = renderApp(path);
    await user.type(await screen.findByLabelText(inputLabel), '刷新查询');
    await user.click(screen.getByRole('button', { name: sendLabel }));
    await waitFor(() => expect(streams).toBe(1));
    view.unmount();
    renderApp(path);
    expect(await screen.findByText('刷新后完整回复')).toBeInTheDocument();
    expect(screen.getByText('刷新查询')).toBeInTheDocument();
    expect(starts).toBe(1);
  });

  it.each([['/', '经营问题', /发送消息/], ['/students', '学生与账户经营问题', '发送 ↑']])('retries creation with the same run identity after a reload on %s', async (page, label, button) => {
    const user = userEvent.setup();
    const requests: Array<{ runId?: string; threadId: string; clientRequestId: string; message: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as { runId?: string; threadId: string; clientRequestId: string; message: string };
        requests.push(body);
        if (requests.length === 1) return new Promise<Response>(() => {});
        return Response.json({ runId: body.runId, threadId: body.threadId, status: 'running' });
      }
      if (path.startsWith('/api/assistant/runs/') && path.endsWith('/events')) return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '创建中刷新后恢复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    const view = renderApp(page);
    await user.type(await screen.findByLabelText(label), '创建中刷新');
    await user.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(requests).toHaveLength(1));
    view.unmount();
    renderApp(page);
    expect(await screen.findByText('创建中刷新后恢复')).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requests[1]).toEqual(requests[0]);
  });

  it('keeps the same creation identity when the first response is lost', async () => {
    const user = userEvent.setup();
    const requests: Array<{ runId?: string; threadId: string; clientRequestId: string; message: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (path === '/api/assistant/runs') {
        const body = JSON.parse(String(init?.body)) as typeof requests[number];
        requests.push(body);
        if (requests.length === 1) throw new Error('network lost');
        return Response.json({ runId: body.runId, threadId: body.threadId, status: 'running' });
      }
      if (path.startsWith('/api/assistant/runs/') && path.endsWith('/events')) return new Response(`event: assistant.message\ndata: ${JSON.stringify({ type: 'assistant.message', messageId: runId, markdown: '请求结果恢复' })}\n\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    const view = renderApp('/');
    await user.type(await screen.findByLabelText('经营问题'), '查询失败后恢复');
    await user.click(screen.getByRole('button', { name: /发送消息/ }));
    expect(await screen.findByText(/network lost/)).toBeInTheDocument();
    view.unmount();
    renderApp('/');
    expect(await screen.findByText('请求结果恢复')).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it.each([['/', false], ['/students', true]])('disables confirmation during recovered run on %s', async (path, businessPage) => {
    const threadId = '2f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';
    const key = 'u1%3AOWNER%3A';
    window.sessionStorage.setItem(`pianomanager.assistant.session.v1:${key}`, JSON.stringify({ threadId, messages: [], workspaceThreadId: threadId, workspace: { protocolVersion: '1.0', title: '待核对', blocks: [{ type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '待核对交费', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }], sources: [] } }));
    window.sessionStorage.setItem(`pianomanager.assistant.pending-run.v1:${key}`, JSON.stringify({ run: { runId, threadId, status: 'running' } }));
    let confirmations = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const requestPath = String(input);
      if (requestPath === '/api/auth/me') return Response.json({ id: 'u1', username: 'owner', role: 'OWNER' });
      if (requestPath === `/api/assistant/previews/${previewId}`) return Response.json(previewState());
      if (requestPath === `/api/assistant/previews/${previewId}/confirm`) { confirmations += 1; return Response.json({}); }
      if (requestPath === `/api/assistant/runs/${runId}/events`) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{}', { status: 404 });
    }));
    renderApp(path);
    if (businessPage) await userEvent.click(await screen.findByRole('button', { name: /查看本次对话结果/ }));
    expect(await screen.findByRole('button', { name: '确认并登记' })).toBeDisabled();
    expect(confirmations).toBe(0);
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
            controller.enqueue(encoder.encode(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '学生账户确认单', blocks: [{ type: 'summary', title: '学生账户确认单', text: '请核对对象与变更，确认后才生效。' }, { type: 'data-table', columns: [{key:'field',label:'项目'},{key:'value',label:'内容'}], rows: [] }, { type: 'summary', title: '核对收款', text: '学生：小明；金额：¥120.00' }, { type: 'action-preview', previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', title: '确认收款 ¥120.00', riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z' }], sources: [] } })}\n\n`));
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
    expect(within(workspace).queryByText('请核对对象与变更，确认后才生效。')).not.toBeInTheDocument();
    expect(within(workspace).queryByRole('table', { name: '查询结果' })).not.toBeInTheDocument();
    expect(within(workspace).getByText('学生：小明；金额：¥120.00')).toBeInTheDocument();
    const preview = within(workspace).getByLabelText('操作预览');
    const confirmButton = await within(preview).findByRole('button', { name: '确认并登记' });
    const previewRead = fetchMock.mock.calls.find(([path]) => String(path) === `/api/assistant/previews/${previewId}`);
    expect(new Headers(previewRead?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');

    await user.click(confirmButton);
    await user.click(confirmButton);
    await waitFor(() => expect(confirmations).toBe(1));
    expect(await within(preview).findByText('已确认并执行。')).toBeInTheDocument();
    expect(within(preview).getByText('120.00')).toBeInTheDocument();
    expect(within(preview).queryByText('payment-1')).not.toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: /确认/ })).not.toBeInTheDocument();
    const confirmationRequest = fetchMock.mock.calls.find(([path, request]) => String(path).endsWith(`/previews/${previewId}/confirm`) && request?.method === 'POST');
    expect(new Headers(confirmationRequest?.[1]?.headers).get('Authorization')).toBe('Bearer jwt-test');
    expect(new Headers(confirmationRequest?.[1]?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    await user.click(screen.getByRole('button', { name: '返回业务功能' }));
    expect(screen.getByRole('button', { name: /新建学生/ })).toBeInTheDocument();
  });
});
