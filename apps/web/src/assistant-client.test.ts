import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantIds,
  createAssistantPreview,
  confirmAssistantPreview,
  getAssistantPreview,
  UnknownConfirmationError,
  parseAssistantRun,
  parseAssistantSseFrame,
  startAssistantRun,
  streamAssistantEvents,
} from './assistant-client.js';

const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
const threadId = '9eb3b8c3-b730-4e49-baa0-0b4de36b9345';
const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';

describe('assistant client', () => {
  it('explains a business conflict when creating a preview without exposing server errors', async () => {
    const create = (status: number, message: string) => createAssistantPreview({ token: 'jwt', path: 'structured-action', body: {}, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ statusCode: status, message }), { status })) });
    await expect(create(409, '业务月份已关账，不能登记收支')).rejects.toThrow('业务月份已关账，不能登记收支');
    await expect(create(500, 'internal secret')).rejects.not.toThrow('internal secret');
  });
  it('explains a business conflict returned when a pending preview is confirmed', async () => {
    const pending = JSON.stringify({ previewId, actionType: 'period.close', schemaVersion: 'period.close.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-28T00:00:00.000Z', receipt: null });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/confirm')
      ? new Response(JSON.stringify({ message: '该月份已经关账' }), { status: 409 })
      : new Response(pending));
    await expect(confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl })).rejects.toThrow('该月份已经关账');
  });
  it.each(['student.create', 'lesson.schedule'])('reads the authoritative version when %s preview creation omits schemaVersion', async (actionType) => {
    const draft = { previewId, actionType, riskLevel: 'L2', expiresAt: '2099-10-21T02:00:00.000Z', display: { title: '确认操作' } };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? draft : { ...draft, schemaVersion: `${actionType}.v1`, status: 'PENDING', receipt: null }), { status: 200 }));
    const result = await createAssistantPreview({ token: 'jwt', path: 'structured-action', body: {}, fetchImpl: fetchMock });
    expect(result.schemaVersion).toBe(`${actionType}.v1`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('creates secure UUIDs for the thread and idempotent client request', () => {
    const ids = createAssistantIds();
    expect(ids.threadId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids.clientRequestId).not.toBe(ids.threadId);
  });

  it('parses only well-formed protocol events with a matching SSE event name', () => {
    expect(parseAssistantSseFrame('event: assistant.delta\ndata: {"type":"assistant.delta","text":"你好"}'))
      .toEqual({ type: 'assistant.delta', text: '你好' });
    expect(parseAssistantSseFrame('event: run.completed\ndata: {"type":"run.completed","runId":"bad"}')).toBeNull();
    expect(parseAssistantSseFrame('event: run.failed\ndata: {"type":"run.completed","runId":"' + runId + '"}')).toBeNull();
    expect(parseAssistantSseFrame('event: clarification.requested\ndata: {"type":"clarification.requested","question":"请确认课程"}'))
      .toEqual({ type: 'clarification.requested', question: '请确认课程' });
  });

  it('rejects a workspace containing an unknown block type', () => {
    const document = {
      protocolVersion: '1.0',
      title: '今日经营概览',
      blocks: [
        { type: 'summary', title: '今日安排', text: '有 3 节排课' },
        { type: 'alert-list', alerts: [{ severity: 'warning', title: '待确认', detail: '有 1 节课程待确认' }] },
        { type: 'metric-grid', metrics: [{ label: '今日课程', value: '3', tone: 'positive' }] },
        { type: 'future-block', arbitrary: true },
      ],
      sources: [],
    };
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document })}`)).toBeNull();
  });

  it('parses a generic receipt workspace block without coupling to a business action type', () => {
    const receipt = {
      type: 'receipt',
      receiptId: 'core-receipt-001',
      title: '收款已登记',
      status: 'succeeded',
      occurredAt: '2026-10-19T02:00:00.000Z',
    };
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({
      type: 'workspace.replace',
      document: { protocolVersion: '1.0', title: '确认结果', blocks: [receipt], sources: [] },
    })}`)).toEqual({
      type: 'workspace.replace',
      document: { protocolVersion: '1.0', title: '确认结果', blocks: [receipt], sources: [] },
    });
  });

  it('preserves a validated lesson table from the workspace stream', () => {
    const table = { type: 'data-table', columns: [{ key: 'time', label: '时间' }, { key: 'student', label: '学生' }], rows: [{ time: '09:00', student: '小明' }] };
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({
      type: 'workspace.replace', document: { protocolVersion: '1.0', title: '今日排课', blocks: [table] },
    })}`)).toEqual({ type: 'workspace.replace', document: { protocolVersion: '1.0', title: '今日排课', blocks: [table], sources: [] } });
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({
      type: 'workspace.replace', document: { protocolVersion: '1.0', title: '今日排课', blocks: [{ ...table, rows: [{ time: { unsafe: true } }] }] },
    })}`)).toBeNull();
  });

  it('accepts the shared entity, calendar, ledger, recovery, and source blocks', () => {
    const document = {
      protocolVersion: '1.0',
      title: '共享工作区协议',
      taskVersion: 12,
      blocks: [
        { type: 'entity-picker', title: '学生', candidates: [{ id: 'student-1', label: '小明' }] },
        { type: 'calendar', rangeStart: '2026-10-19T00:00:00.000Z', rangeEnd: '2026-10-20T00:00:00.000Z', events: [{ id: 'lesson-1', title: '主课', start: '2026-10-19T09:00:00.000Z', end: '2026-10-19T10:00:00.000Z' }] },
        { type: 'ledger-detail', accountId: 'account-1', entries: [{ id: 'ledger-1', occurredAt: '2026-10-19T02:00:00.000Z', description: '交费', paidDelta: '200.00', giftDelta: '0.00' }] },
        { type: 'error-recovery', code: 'PREVIEW_STALE', message: '预览已失效', actions: ['refresh', 'repreview'] },
      ],
      sources: [{ type: 'student', id: 'student-1', label: '学生：小明' }],
    };
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document })}`)).toEqual({
      type: 'workspace.replace', document,
    });
  });

  it('rejects malformed workspace envelopes and supported blocks', () => {
    const invalidDocuments = [
      { protocolVersion: '2.0', title: '标题', blocks: [] },
      { protocolVersion: '1.0', title: '', blocks: [] },
      { protocolVersion: '1.0', title: '标题', blocks: [{ type: 'summary', title: '', text: '摘要' }] },
      { protocolVersion: '1.0', title: '标题', blocks: [{ type: 'metric-grid', metrics: [{ label: '指标', value: 3 }] }] },
      { protocolVersion: '1.0', title: '标题', blocks: [{ type: 'alert-list', alerts: [{ severity: 'critical', title: '提醒' }] }] },
    ];
    for (const document of invalidDocuments) {
      expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document })}`)).toBeNull();
    }
    expect(parseAssistantSseFrame('event: workspace.replace\ndata: {"type":"workspace.replace","document":null}')).toBeNull();
  });

  it('validates the run payload returned by Core', () => {
    expect(parseAssistantRun({ runId, threadId, status: 'running' })).toEqual({ runId, threadId, status: 'running' });
    expect(parseAssistantRun({ runId, threadId, status: 'unknown' })).toBeNull();
  });

  it('starts a run with JWT and the public gateway request shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runId, threadId, status: 'running' }), { status: 200 }));
    const result = await startAssistantRun({ token: 'jwt', message: '查看今日排课', threadId, clientRequestId: 'request-1', fetchImpl: fetchMock });

    expect(result.runId).toBe(runId);
    expect(fetchMock).toHaveBeenCalledWith('/api/assistant/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
      body: JSON.stringify({ message: '查看今日排课', threadId, clientRequestId: 'request-1' }),
    }));
  });

  it('streams SSE with JWT and thread header, stopping when the run completes', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: assistant.delta\ndata: {"type":"assistant.delta","text":"真实回复"}\n\n'));
        controller.enqueue(encoder.encode(`event: run.completed\ndata: {"type":"run.completed","runId":"${runId}"}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events: string[] = [];
    await streamAssistantEvents({
      token: 'jwt',
      run: { runId, threadId, status: 'running' },
      signal: new AbortController().signal,
      fetchImpl: fetchMock,
      onEvent: (event) => {
        events.push(event.type === 'assistant.delta' ? event.text : event.type);
        return event.type === 'run.completed';
      },
    });

    expect(events).toEqual(['真实回复', 'run.completed']);
    expect(fetchMock).toHaveBeenCalledWith(`/api/assistant/runs/${runId}/events`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer jwt', 'x-thread-id': threadId }),
    }));
  });

  it('reports missing login and rejected event connections as usable errors', async () => {
    await expect(startAssistantRun({ token: null, message: 'test', threadId, clientRequestId: 'id' }))
      .rejects.toThrow('登录状态已失效');
    await expect(streamAssistantEvents({
      token: 'jwt',
      run: { runId, threadId, status: 'running' },
      signal: new AbortController().signal,
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
      onEvent: () => undefined,
    })).rejects.toThrow('HTTP 503');
  });

  it('confirms with the logged-in JWT and preserves arbitrary Core receipt fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/assistant/previews/${previewId}`) return new Response(JSON.stringify({
        previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-21T02:00:00.000Z', receipt: null,
      }), { status: 200 });
      if (init?.method === 'POST') return new Response(JSON.stringify({
        previewId,
        status: 'EXECUTED',
        receipt: { actionType: 'course-account.payment', paymentId: 'payment-001', amount: '120.00', details: { channel: 'WECHAT' } },
      }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const result = await confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl: fetchMock });

    expect(result.receipt).toEqual({ actionType: 'course-account.payment', paymentId: 'payment-001', amount: '120.00', details: { channel: 'WECHAT' } });
    expect(fetchMock).toHaveBeenCalledWith(`/api/assistant/previews/${previewId}/confirm`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer jwt', 'Idempotency-Key': runId }),
    }));
  });

  it('turns Core conflict and malformed confirmation responses into safe UI errors', async () => {
    const pending = JSON.stringify({ previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-21T02:00:00.000Z', receipt: null });
    await expect(confirmAssistantPreview({
      token: 'jwt', previewId, idempotencyKey: runId,
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => new Response(String(input) === `/api/assistant/previews/${previewId}` ? pending : null, { status: String(input) === `/api/assistant/previews/${previewId}` ? 200 : 409 })),
    })).rejects.toThrow('预览已失效或已被其他请求确认');
    await expect(confirmAssistantPreview({
      token: 'jwt', previewId, idempotencyKey: runId,
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `/api/assistant/previews/${previewId}`) return new Response(pending, { status: 200 });
        if (init?.method === 'POST') return new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: [] }), { status: 200 });
        return new Response(pending, { status: 200 });
      }),
    })).rejects.toThrow('确认响应格式无效');
  });

  it('reads the current preview with JWT, preserves the current display, and rejects a response for another preview', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      previewId,
      actionType: 'course-account.payment',
      schemaVersion: 'course-account.payment.v1',
      riskLevel: 'L2',
      status: 'PENDING',
      expiresAt: '2099-10-21T02:00:00.000Z',
      receipt: null,
      display: { title: '当前收款确认', studentName: '小林', amount: '120.00' },
    }), { status: 200 }));

    const current = await getAssistantPreview({ token: 'jwt-current-user', previewId, fetchImpl: fetchMock });
    expect(current.display).toEqual({ title: '当前收款确认', studentName: '小林', amount: '120.00' });
    expect(fetchMock).toHaveBeenCalledWith(`/api/assistant/previews/${previewId}`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer jwt-current-user' }),
    }));

    await expect(getAssistantPreview({ token: 'jwt', previewId, fetchImpl: vi.fn(async () => new Response(JSON.stringify({
      previewId: '1f1d4de6-36cb-4ec2-904d-c522927d8d0c',
      actionType: 'course-account.payment',
      schemaVersion: 'course-account.payment.v1',
      riskLevel: 'L2',
      status: 'PENDING',
      expiresAt: '2099-10-21T02:00:00.000Z',
      receipt: null,
    }), { status: 200 })) }))
      .rejects.toThrow('预览响应格式无效');
  });

  it('checks Core after an unknown confirmation result and returns the real executed receipt', async () => {
    let previewReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/assistant/previews/${previewId}`) {
        previewReads += 1;
        return new Response(JSON.stringify({
          previewId,
          actionType: 'course-account.payment',
          schemaVersion: 'course-account.payment.v1',
          riskLevel: 'L2',
          status: previewReads === 1 ? 'PENDING' : 'EXECUTED',
          expiresAt: '2099-10-21T02:00:00.000Z',
          receipt: { paymentId: 'payment-after-timeout', amount: '120.00' },
        }), { status: 200 });
      }
      if (init?.method === 'POST') throw new TypeError('network disconnected');
      return new Response('{}', { status: 404 });
    });

    const result = await confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl: fetchMock });

    expect(result).toEqual({
      previewId,
      status: 'EXECUTED',
      receipt: { paymentId: 'payment-after-timeout', amount: '120.00' },
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/api/assistant/previews/${previewId}`,
      `/api/assistant/previews/${previewId}/confirm`,
      `/api/assistant/previews/${previewId}`,
    ]);
  });

  it('throws a typed unknown confirmation error when recovery cannot prove execution', async () => {
    const pending = JSON.stringify({ previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-21T02:00:00.000Z', receipt: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/assistant/previews/${previewId}`) return new Response(pending, { status: 200 });
      if (init?.method === 'POST') return new Response(null, { status: 503 });
      return new Response('{}', { status: 404 });
    });

    const result = confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl: fetchMock });

    await expect(result).rejects.toBeInstanceOf(UnknownConfirmationError);
    await expect(result).rejects.toThrow('确认请求结果未知');
  });

  it('keeps the typed unknown error when the recovery GET is unavailable', async () => {
    let reads = 0;
    let confirmations = 0;
    const pending = { previewId, actionType: 'course-account.payment', schemaVersion: 'course-account.payment.v1', riskLevel: 'L2', status: 'PENDING', expiresAt: '2099-10-21T02:00:00.000Z', receipt: null };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        confirmations++;
        throw new TypeError('Failed to fetch');
      }
      reads++;
      return reads === 1 ? new Response(JSON.stringify(pending), { status: 200 }) : new Response(null, { status: 503 });
    });
    const result = confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl: fetchMock });
    await expect(result).rejects.toBeInstanceOf(UnknownConfirmationError);
    await expect(result).rejects.toThrow('无法核对系统当前状态');
    expect(reads).toBe(2);
    expect(confirmations).toBe(1);
  });
});
