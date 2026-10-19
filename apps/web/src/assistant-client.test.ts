import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantIds,
  confirmAssistantPreview,
  parseAssistantRun,
  parseAssistantSseFrame,
  startAssistantRun,
  streamAssistantEvents,
} from './assistant-client.js';

const runId = '4f229d18-5a0f-4ec2-904d-c522927d8d0c';
const threadId = '9eb3b8c3-b730-4e49-baa0-0b4de36b9345';
const previewId = '0f0d4de6-36cb-4f99-9b5d-4e1f70f4af9d';

describe('assistant client', () => {
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

  it('parses supported workspace blocks and ignores unknown block types', () => {
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
    expect(parseAssistantSseFrame(`event: workspace.replace\ndata: ${JSON.stringify({ type: 'workspace.replace', document })}`))
      .toEqual({
        type: 'workspace.replace',
        document: { protocolVersion: '1.0', title: document.title, blocks: document.blocks.slice(0, 3) },
      });
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
      document: { protocolVersion: '1.0', title: '确认结果', blocks: [receipt] },
    })}`)).toEqual({
      type: 'workspace.replace',
      document: { protocolVersion: '1.0', title: '确认结果', blocks: [receipt] },
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      previewId,
      status: 'EXECUTED',
      receipt: { actionType: 'course-account.payment', paymentId: 'payment-001', amount: '120.00', details: { channel: 'WECHAT' } },
    }), { status: 200 }));
    const result = await confirmAssistantPreview({ token: 'jwt', previewId, idempotencyKey: runId, fetchImpl: fetchMock });

    expect(result.receipt).toEqual({ actionType: 'course-account.payment', paymentId: 'payment-001', amount: '120.00', details: { channel: 'WECHAT' } });
    expect(fetchMock).toHaveBeenCalledWith(`/api/assistant/previews/${previewId}/confirm`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer jwt', 'Idempotency-Key': runId }),
    }));
  });

  it('turns Core conflict and malformed confirmation responses into safe UI errors', async () => {
    await expect(confirmAssistantPreview({
      token: 'jwt', previewId, idempotencyKey: runId,
      fetchImpl: vi.fn(async () => new Response(null, { status: 409 })),
    })).rejects.toThrow('预览已失效或已被其他请求确认');
    await expect(confirmAssistantPreview({
      token: 'jwt', previewId, idempotencyKey: runId,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ previewId, status: 'EXECUTED', receipt: [] }), { status: 200 })),
    })).rejects.toThrow('确认响应格式无效');
  });
});
