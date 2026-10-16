import { MemorySaver } from '@langchain/langgraph';
import {
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import {
  createSignedInternalRequestHeaders,
  verifySignedInternalRequest,
} from '@piano/assistant-protocol/internal-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { createTestRepository } from './test-repository.js';

const secret = 'stage-0-test-secret-012345678901234567890123';
const capability = 'short-lived-capability';
const runId = 'e200271f-06a4-45e6-bdb8-6c59b843a1fa';
const threadId = 'a2b50d20-bd44-4f42-b7f0-148535470c75';

function signedHeaders(method: string, path: string, body?: unknown): Record<string, string> {
  return {
    ...createSignedInternalRequestHeaders({ secret, method, path, body }),
    'x-assistant-capability': capability,
  };
}

const config = {
  AGENT_PORT: 3100,
  AI_ENABLED: false,
  AI_PROVIDER: '',
  AI_MODEL: '',
  AI_API_KEY: '',
  AGENT_DATABASE_URL: 'postgresql://unused',
  CORE_INTERNAL_API_URL: 'http://core.test',
  INTERNAL_SERVICE_SECRET: secret,
  AI_REQUEST_TIMEOUT_MS: 1_000,
  AI_RUN_TIMEOUT_MS: 5_000,
  AI_MAX_STEPS: 8,
  AI_MAX_TOOL_CALLS: 6,
  AI_MAX_OUTPUT_TOKENS: 1_200,
  AI_TRACING_ENABLED: false,
} as const;

const statusResponse = {
  status: 200,
  ok: true,
  json: async () => ({
    status: 'available',
    businessTimezone: 'Asia/Shanghai',
    serverTime: '2026-10-16T00:00:00.000Z',
  }),
};

describe('agent runtime Fastify server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not execute protected routes without a signed internal request', async () => {
    const fetchSystemStatus = vi.fn();
    vi.stubGlobal('fetch', fetchSystemStatus);
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      payload: { runId, threadId, userMessage: '阶段 0' },
    });

    expect(response.statusCode).toBe(401);
    expect(fetchSystemStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires both the HMAC envelope and the short-lived capability', async () => {
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });

    const body = { runId, threadId, userMessage: '阶段 0' };
    const withoutCapability = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: createSignedInternalRequestHeaders({
        secret,
        method: 'POST',
        path: '/internal/assistant/runs/start',
        body,
      }),
      payload: body,
    });
    expect(withoutCapability.statusCode).toBe(401);

    const withoutServiceSecret = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: { 'x-assistant-capability': capability },
      payload: body,
    });
    expect(withoutServiceSecret.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a replayed nonce before executing the graph again', async () => {
    const fetchSystemStatus = vi.fn().mockResolvedValue(statusResponse);
    vi.stubGlobal('fetch', fetchSystemStatus);
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const path = '/internal/assistant/runs/start';
    const body = { runId, threadId, userMessage: '重放验证' };
    const headers = signedHeaders('POST', path, body);

    const first = await app.inject({ method: 'POST', url: path, headers, payload: body });
    const replay = await app.inject({ method: 'POST', url: path, headers, payload: body });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects an idempotent retry whose request content changed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse));
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const path = '/internal/assistant/runs/start';
    const original = { runId, threadId, userMessage: '原始消息', clientRequestId: 'request-1' };
    const changed = { ...original, userMessage: '被修改的消息' };

    await app.inject({
      method: 'POST',
      url: path,
      headers: signedHeaders('POST', path, original),
      payload: original,
    });
    const retry = await app.inject({
      method: 'POST',
      url: path,
      headers: signedHeaders('POST', path, changed),
      payload: changed,
    });

    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ message: '幂等请求内容不一致' });
    await app.close();
  });

  it('streams waiting and completed SSE events while resuming without a second read', async () => {
    const fetchSystemStatus = vi.fn().mockResolvedValue(statusResponse);
    vi.stubGlobal('fetch', fetchSystemStatus);
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });

    const startBody = { runId, threadId, userMessage: '阶段 0' };
    const start = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ runId, threadId, status: 'waiting_for_input' });
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
    const [coreUrl, coreInit] = fetchSystemStatus.mock.calls[0]!;
    const coreHeaders = coreInit.headers as Record<string, string>;
    expect(
      verifySignedInternalRequest({
        secret,
        timestamp: coreHeaders[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
        nonce: coreHeaders[INTERNAL_REQUEST_NONCE_HEADER]!,
        signature: coreHeaders[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
        method: 'GET',
        path: new URL(coreUrl).pathname,
      }),
    ).toBe(true);

    const events = await app.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.body).toContain('event: clarification.requested');

    const resumeBody = { threadId, input: { approved: true } };
    const resume = await app.inject({
      method: 'POST',
      url: `/internal/assistant/runs/${runId}/resume`,
      headers: signedHeaders('POST', `/internal/assistant/runs/${runId}/resume`, resumeBody),
      payload: resumeBody,
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ runId, threadId, status: 'completed' });
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);

    const completedEvents = await app.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(completedEvents.body).toContain('event: assistant.delta');
    expect(completedEvents.body).toContain('event: run.completed');

    const repeatedResume = await app.inject({
      method: 'POST',
      url: `/internal/assistant/runs/${runId}/resume`,
      headers: signedHeaders('POST', `/internal/assistant/runs/${runId}/resume`, resumeBody),
      payload: resumeBody,
    });
    expect(repeatedResume.statusCode).toBe(200);
    expect(repeatedResume.json()).toMatchObject({ runId, status: 'completed' });

    const eventsAfterRepeatedResume = await app.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(eventsAfterRepeatedResume.body.match(/event: run\.completed/g)).toHaveLength(1);
    await app.close();
  });

  it('restores run status and SSE history through a new server instance', async () => {
    const fetchSystemStatus = vi.fn().mockResolvedValue(statusResponse);
    vi.stubGlobal('fetch', fetchSystemStatus);
    const repository = createTestRepository();
    const checkpointer = new MemorySaver();
    const firstApp = buildServer({ config, checkpointer, repository });

    const restartBody = { runId, threadId, userMessage: '重启后恢复' };
    await firstApp.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', restartBody),
      payload: restartBody,
    });
    const firstEvents = await firstApp.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(firstEvents.body).toContain('id: 1');
    await firstApp.close();

    const secondApp = buildServer({ config, checkpointer, repository });
    const restoredRun = await secondApp.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}`),
    });
    expect(restoredRun.statusCode).toBe(200);
    expect(restoredRun.json()).toMatchObject({ runId, threadId, status: 'waiting_for_input' });
    const resumedEvents = await secondApp.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: {
        ...signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
        'last-event-id': '1',
      },
    });
    expect(resumedEvents.statusCode).toBe(200);
    expect(resumedEvents.body).not.toContain('id: 1');
    expect(resumedEvents.body).toContain('event: clarification.requested');

    const restartResumeBody = { threadId, input: { approved: true } };
    const resumed = await secondApp.inject({
      method: 'POST',
      url: `/internal/assistant/runs/${runId}/resume`,
      headers: signedHeaders('POST', `/internal/assistant/runs/${runId}/resume`, restartResumeBody),
      payload: restartResumeBody,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ runId, status: 'completed' });
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
    await secondApp.close();
  });

  it('claims a waiting run once when resume requests arrive concurrently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse));
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const startBody = { runId, threadId, userMessage: '并发恢复' };
    await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    const resumePath = `/internal/assistant/runs/${runId}/resume`;
    const resumeBody = { threadId, input: { approved: true } };

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: resumePath,
        headers: signedHeaders('POST', resumePath, resumeBody),
        payload: resumeBody,
      }),
      app.inject({
        method: 'POST',
        url: resumePath,
        headers: signedHeaders('POST', resumePath, resumeBody),
        payload: resumeBody,
      }),
    ]);
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => [200, 409].includes(response.statusCode))).toBe(true);

    const events = await app.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(events.body.match(/event: run\.completed/g)).toHaveLength(1);
    await app.close();
  });

  it('returns a generic 500 response for a tool failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('internal tool details')));
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });

    const failureBody = { runId, threadId, userMessage: '阶段 0' };
    const response = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', failureBody),
      payload: failureBody,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: 'Agent Runtime 内部错误' });
    expect(response.body).not.toContain('internal tool details');
    await app.close();
  });

  it('rejects a resume request for an unknown run without touching the graph', async () => {
    const fetchSystemStatus = vi.fn().mockResolvedValue(statusResponse);
    vi.stubGlobal('fetch', fetchSystemStatus);
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });

    const knownBody = { runId, threadId, userMessage: '阶段 0' };
    await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', knownBody),
      payload: knownBody,
    });
    const unknownResumePath = '/internal/assistant/runs/6f96f9c5-9188-4c5d-a55a-2e4e11af99b4/resume';
    const unknownResumeBody = { threadId, input: { approved: true } };
    const response = await app.inject({
      method: 'POST',
      url: unknownResumePath,
      headers: signedHeaders('POST', unknownResumePath, unknownResumeBody),
      payload: unknownResumeBody,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: '运行不存在' });
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects an SSE cursor outside the PostgreSQL bigint range', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse));
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const startBody = { runId, threadId, userMessage: '游标验证' };
    await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    const path = `/internal/assistant/runs/${runId}/events`;
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: {
        ...signedHeaders('GET', path),
        'last-event-id': '9223372036854775808',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: '事件游标不合法' });
    await app.close();
  });
});
