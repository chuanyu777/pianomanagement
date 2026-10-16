import { generateKeyPairSync } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import {
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import { verifySignedInternalRequest } from '@piano/assistant-protocol/internal-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityTokenService } from '../src/common/capability/capability-token.service.js';
import {
  AGENT_RUNTIME_CLIENT,
  HttpAgentRuntimeClient,
  type AgentRuntimeClient,
} from '../src/modules/assistant-gateway/agent-runtime.client.js';
import { AssistantGatewayService } from '../src/modules/assistant-gateway/assistant-gateway.service.js';
import { buildServer } from '../../agent-runtime/src/server.js';
import { createTestRepository } from '../../agent-runtime/test/test-repository.js';

const userId = 'c7b8a0f5-8d90-42b8-b4a4-7e2ddc59fd40';
const threadId = 'b1d9a8cb-45e7-4bc8-bf04-79f3ba39f6d4';
const runId = '91c3b7bf-1c59-4df7-8fa8-776cdb5f65ee';
const serviceSecret = 'stage-0-test-secret-012345678901234567890123';

function createTokens(): CapabilityTokenService {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new CapabilityTokenService({ privateKey, publicKey });
}

function createService(client: AgentRuntimeClient): AssistantGatewayService {
  return new AssistantGatewayService(client, createTokens());
}

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('AssistantGatewayService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts a run with a short-lived read/preview-only capability', async () => {
    const start = vi.fn(async (input) => {
      const payload = JSON.parse(
        Buffer.from(input.capability.split('.')[1]!, 'base64url').toString('utf8'),
      ) as { sub: string; threadId: string; runId: string; jti: string; permissions: string[]; iat: number; exp: number };
      expect(payload.sub).toBe(userId);
      expect(payload.runId).toBe(input.runId);
      expect(payload.threadId).toBe(threadId);
      expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
      expect(payload.permissions).toEqual(['READ']);
      expect(payload.permissions).not.toContain('confirm');
      expect(payload.permissions).not.toContain('execute');
      expect(payload.exp - payload.iat).toBe(300);
      return { runId: input.runId, threadId, status: 'queued' as const };
    });

    const service = createService({
      start,
      resume: vi.fn(),
      openEvents: vi.fn(),
    });

    const result = await service.startRun({
      userId,
      threadId,
      message: '查看今天的排课',
      clientRequestId: 'client-request-1',
    });

    expect(result.threadId).toBe(threadId);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        message: '查看今天的排课',
        clientRequestId: 'client-request-1',
      }),
    );
  });

  it('resumes a run with a capability scoped to that run', async () => {
    const resume = vi.fn(async (input) => {
      const payload = JSON.parse(
        Buffer.from(input.capability.split('.')[1]!, 'base64url').toString('utf8'),
      ) as { sub: string; threadId: string; runId: string; permissions: string[]; iat: number; exp: number };
      expect(payload.sub).toBe(userId);
      expect(payload.runId).toBe(runId);
      expect(payload.threadId).toBe(threadId);
      expect(payload.permissions).toEqual(['READ']);
      expect(payload.exp - payload.iat).toBe(300);
      return { runId, threadId, status: 'running' as const };
    });

    const service = createService({
      start: vi.fn(),
      resume,
      openEvents: vi.fn(),
    });

    await expect(
      service.resumeRun({ userId, threadId, runId, input: { approved: true } }),
    ).resolves.toMatchObject({ runId, threadId });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, runId, input: { approved: true } }),
    );
  });

  it('returns a safe SSE proxy and validates upstream events', async () => {
    const body = [
      ': upstream-private-heartbeat-text\n\n',
      `id: 41\nevent: assistant.delta\ndata: ${JSON.stringify({ type: 'assistant.delta', text: '你好' })}\n\n`,
      `id: 42\nevent: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`,
    ].join('');
    const openEvents = vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    }));
    const service = createService({
      start: vi.fn(),
      resume: vi.fn(),
      openEvents,
    });

    const proxy = await service.openRunEvents({ userId, threadId, runId, lastEventId: '40' });
    const text = await new Response(proxy.body).text();

    expect(proxy.contentType).toBe('text/event-stream');
    expect(text).toContain(': keep-alive');
    expect(text).not.toContain('upstream-private-heartbeat-text');
    expect(text).toContain('event: assistant.delta');
    expect(text).toContain('id: 41');
    expect(text).toContain('"text":"你好"');
    expect(text).toContain('event: run.completed');
    expect(text).toContain('id: 42');
    expect(text).not.toContain('event: unknown');
    expect(openEvents).toHaveBeenCalledWith(expect.objectContaining({ runId, lastEventId: '40' }));
  });

  it('pulls upstream SSE only when the downstream consumer asks for data', async () => {
    let upstreamPulls = 0;
    const openEvents = vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          upstreamPulls += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `event: run.completed\ndata: ${JSON.stringify({ type: 'run.completed', runId })}\n\n`,
            ),
          );
          controller.close();
        },
      }, { highWaterMark: 0 }),
    }));
    const service = createService({ start: vi.fn(), resume: vi.fn(), openEvents });

    const proxy = await service.openRunEvents({ userId, threadId, runId });
    await new Promise((resolve) => setImmediate(resolve));
    expect(upstreamPulls).toBe(0);

    const reader = proxy.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(upstreamPulls).toBe(1);
    await reader.cancel();
  });

  it('maps upstream failures to public-safe errors without leaking the body', async () => {
    const upstreamSecret = 'upstream-internal-stack-and-token';
    const service = createService({
      start: vi.fn(async () => {
        throw new Error(upstreamSecret);
      }),
      resume: vi.fn(),
      openEvents: vi.fn(),
    });

    await expect(
      service.startRun({ userId, message: '查询余额' }),
    ).rejects.toThrow('AI 助手服务暂时不可用，请稍后重试');
    await expect(
      service.startRun({ userId, message: '查询余额' }),
    ).rejects.not.toThrow(upstreamSecret);
  });
});

describe('AgentRuntimeClient contract', () => {
  it('exposes an injection token for AppModule integration', () => {
    expect(AGENT_RUNTIME_CLIENT).toBeDefined();
  });
});

describe('HttpAgentRuntimeClient', () => {
  it('posts start requests and maps upstream HTTP errors', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ internal: 'do not expose this' }, { status: 503, statusText: 'Unavailable' }),
    );
    const { HttpAgentRuntimeClient } = await import(
      '../src/modules/assistant-gateway/agent-runtime.client.js'
    );
    const client = new HttpAgentRuntimeClient({
      baseUrl: 'http://agent-runtime.test',
      serviceSecret: 'stage-0-test-secret-012345678901234567890123',
      timeoutMs: 100,
      fetchImpl,
    });

    await expect(
      client.start({
        runId,
        threadId,
        message: '查询',
        capability: 'capability-token',
      }),
    ).rejects.toThrow('AI 助手服务暂时不可用，请稍后重试');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://agent-runtime.test/internal/assistant/runs/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-assistant-capability': 'capability-token',
          [INTERNAL_REQUEST_TIMESTAMP_HEADER]: expect.any(String),
          [INTERNAL_REQUEST_NONCE_HEADER]: expect.any(String),
          [INTERNAL_REQUEST_SIGNATURE_HEADER]: expect.any(String),
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(requestBody).toEqual({ runId, threadId, userMessage: '查询' });
    const requestHeaders = fetchImpl.mock.calls[0]?.[1]?.headers;
    expect(requestHeaders).not.toHaveProperty('authorization');
    expect(requestHeaders).not.toHaveProperty('x-user-authorization');
    expect(requestHeaders).not.toHaveProperty('x-internal-service-secret');
  });

  it('maps request timeout to a public gateway-timeout error', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    const { HttpAgentRuntimeClient } = await import(
      '../src/modules/assistant-gateway/agent-runtime.client.js'
    );
    const client = new HttpAgentRuntimeClient({
      baseUrl: 'http://agent-runtime.test',
      serviceSecret: 'stage-0-test-secret-012345678901234567890123',
      timeoutMs: 5,
      fetchImpl,
    });

    await expect(
      client.resume({
        runId,
        threadId,
        input: { approved: true },
        capability: 'capability-token',
      }),
    ).rejects.toThrow('AI 助手响应超时，请稍后重试');
  });
});

describe('Core Gateway ↔ Agent Runtime contract', () => {
  it('accepts the Gateway client start/resume/events requests at the Runtime interface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          status: 'available',
          businessTimezone: 'Asia/Shanghai',
          serverTime: '2026-10-16T00:00:00.000Z',
        }),
      ),
    );
    const runtime = buildServer({
      config: {
        AGENT_PORT: 3100,
        AI_ENABLED: false,
        AI_PROVIDER: '',
        AI_MODEL: '',
        AI_API_KEY: '',
        AGENT_DATABASE_URL: 'postgresql://unused',
        CORE_INTERNAL_API_URL: 'http://core.test',
        INTERNAL_SERVICE_SECRET: serviceSecret,
        AI_REQUEST_TIMEOUT_MS: 1_000,
        AI_RUN_TIMEOUT_MS: 5_000,
        AI_MAX_STEPS: 8,
        AI_MAX_TOOL_CALLS: 6,
        AI_MAX_OUTPUT_TOKENS: 1_200,
        AI_TRACING_ENABLED: false,
      },
      checkpointer: new MemorySaver(),
      repository: createTestRepository(),
    });

    const fetchRuntime = vi.fn(async (url: string, init?: RequestInit) => {
      const target = new URL(url);
      const headers = new Headers(init?.headers);
      const injected = await runtime.inject({
        method: init?.method ?? 'GET',
        url: target.pathname,
        headers: Object.fromEntries(headers.entries()),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(injected.headers)) {
        if (typeof value === 'string') responseHeaders.set(key, value);
      }
      return new Response(injected.body, {
        status: injected.statusCode,
        headers: responseHeaders,
      });
    });
    const client = new HttpAgentRuntimeClient({
      baseUrl: 'http://agent-runtime.test',
      serviceSecret,
      timeoutMs: 1_000,
      fetchImpl: fetchRuntime,
    });

    const started = await client.start({
      runId,
      threadId,
      message: '阶段 0',
      capability: 'short-lived-capability',
    });
    expect(started).toEqual({ runId, threadId, status: 'waiting_for_input' });

    const resumed = await client.resume({
      runId,
      threadId,
      input: { approved: true },
      capability: 'short-lived-capability',
    });
    expect(resumed).toEqual({ runId, threadId, status: 'completed' });

    const stream = await client.openEvents({
      runId,
      capability: 'short-lived-capability',
      lastEventId: '1',
    });
    const streamText = await new Response(stream.body).text();
    expect(streamText).toContain('event: clarification.requested');
    expect(streamText).toContain('event: assistant.delta');
    expect(streamText).toContain('event: run.completed');

    expect(fetchRuntime).toHaveBeenCalledTimes(3);
    const eventHeaders = fetchRuntime.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(eventHeaders['last-event-id']).toBe('1');
    for (const [url, init] of fetchRuntime.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-assistant-capability']).toBe('short-lived-capability');
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-internal-service-secret']).toBeUndefined();
      const target = new URL(url);
      expect(
        verifySignedInternalRequest({
          secret: serviceSecret,
          timestamp: headers[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
          nonce: headers[INTERNAL_REQUEST_NONCE_HEADER]!,
          signature: headers[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
          method: init?.method ?? 'GET',
          path: `${target.pathname}${target.search}`,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          securityHeaders: {
            'x-assistant-capability': headers['x-assistant-capability'],
            'last-event-id': headers['last-event-id'],
          },
        }),
      ).toBe(true);
    }
    await runtime.close();
  });
});
