import { MemorySaver } from '@langchain/langgraph';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
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
import { buildServer as createServer } from '../src/server.js';
import { RunEventHub } from '../src/events/run-event-hub.js';
import { createSpikeGraph } from '../src/graph/spike-graph.js';
import { createBusinessRunExecutor } from '../src/worker/run-executor.js';
import { RunWorker } from '../src/worker/run-worker.js';
import { CoreToolClient } from '../src/tools/core-tool-client.js';
import type { AgentRuntimeRepository } from '../src/persistence/repository.js';
import { createTestRepository } from './test-repository.js';

const secret = 'stage-0-test-secret-012345678901234567890123';
const capability = 'short-lived-capability';
const runId = 'e200271f-06a4-45e6-bdb8-6c59b843a1fa';
const threadId = 'a2b50d20-bd44-4f42-b7f0-148535470c75';

function signedHeaders(
  method: string,
  path: string,
  body?: unknown,
  securityHeaders: Record<string, string | undefined> = { 'x-assistant-capability': capability },
): Record<string, string> {
  return {
    ...createSignedInternalRequestHeaders({ secret, method, path, body, securityHeaders }),
    ...(securityHeaders['x-assistant-capability']
      ? { 'x-assistant-capability': securityHeaders['x-assistant-capability'] }
      : {}),
    ...(securityHeaders['last-event-id']
      ? { 'last-event-id': securityHeaders['last-event-id'] }
      : {}),
  };
}

const config = {
  AGENT_PORT: 3100,
  AGENT_WORKER_ENABLED: true,
  AGENT_WORKER_LEASE_DURATION_MS: 1_000,
  AGENT_WORKER_RENEW_INTERVAL_MS: 100,
  AGENT_WORKER_POLL_INTERVAL_MS: 1,
  AGENT_WORKER_RECOVERY_BATCH_SIZE: 20,
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

function buildServer(input: {
  config: typeof config;
  checkpointer: MemorySaver;
  repository: AgentRuntimeRepository;
  eventHub?: RunEventHub;
}) {
  const eventHub = input.eventHub ?? new RunEventHub();
  const coreTools = new CoreToolClient(
    input.config.CORE_INTERNAL_API_URL,
    input.config.AI_REQUEST_TIMEOUT_MS,
    input.config.INTERNAL_SERVICE_SECRET,
  );
  const worker = new RunWorker({
    repository: input.repository,
    execute: createBusinessRunExecutor({
      checkpointer: input.checkpointer,
      coreTools,
      runTimeoutMs: input.config.AI_RUN_TIMEOUT_MS,
    }),
    leaseDurationMs: input.config.AGENT_WORKER_LEASE_DURATION_MS,
    renewIntervalMs: input.config.AGENT_WORKER_RENEW_INTERVAL_MS,
    pollIntervalMs: input.config.AGENT_WORKER_POLL_INTERVAL_MS,
    recoveryBatchSize: input.config.AGENT_WORKER_RECOVERY_BATCH_SIZE,
    onEvent: (runId, event) => eventHub.publish(runId, event),
    onError: () => undefined,
  });
  return createServer({ ...input, eventHub, worker });
}

const dashboardResponse = {
  status: 200,
  ok: true,
  json: async () => ({
    businessDate: '2026-10-17',
    highlights: ['今日排课 4 节'],
  }),
};

async function seedLegacyWaitingRun(input: {
  checkpointer: MemorySaver;
  repository: ReturnType<typeof createTestRepository>;
  runId?: string;
  threadId?: string;
}) {
  const seededRunId = input.runId ?? runId;
  const seededThreadId = input.threadId ?? threadId;
  await input.repository.createRun({
    runId: seededRunId,
    threadId: seededThreadId,
    userMessage: '旧版等待中的运行',
  });
  const graph = createSpikeGraph({
    checkpointer: input.checkpointer,
    fetchSystemStatus: async () => ({
      status: 'available',
      businessTimezone: 'Asia/Shanghai',
      serverTime: '2026-10-16T00:00:00.000Z',
    }),
  });
  await graph.invoke(
    { runId: seededRunId, threadId: seededThreadId, userMessage: '旧版等待中的运行' },
    { configurable: { thread_id: `${seededThreadId}:${seededRunId}` } },
  );
  await input.repository.updateRunWithEvent(
    { runId: seededRunId, status: 'waiting_for_input' },
    { type: 'clarification.requested', question: '历史兼容确认' },
  );
}

function readUntilSseEvent(response: IncomingMessage, eventName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    const timeout = setTimeout(() => finish(new Error(`SSE event timeout: ${eventName}`)), 1_000);
    const onData = (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.includes(`event: ${eventName}`)) finish(undefined, body);
    };
    const onEnd = () => finish(new Error('SSE connection ended'));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timeout);
      response.off('data', onData);
      response.off('end', onEnd);
      response.off('error', onError);
      if (error) reject(error);
      else resolve(value!);
    };
    response.on('data', onData);
    response.once('end', onEnd);
    response.once('error', onError);
  });
}

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
    const fetchDashboardSummary = vi.fn().mockResolvedValue(dashboardResponse);
    vi.stubGlobal('fetch', fetchDashboardSummary);
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const path = '/internal/assistant/runs/start';
    const body = { runId, threadId, userMessage: '重放验证' };
    const headers = signedHeaders('POST', path, body);

    const first = await app.inject({ method: 'POST', url: path, headers, payload: body });
    const replay = await app.inject({ method: 'POST', url: path, headers, payload: body });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(fetchDashboardSummary).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a Capability changed after signing', async () => {
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const path = '/internal/assistant/runs/start';
    const body = { runId, threadId, userMessage: 'Capability 签名验证' };
    const headers = signedHeaders('POST', path, body);
    headers['x-assistant-capability'] = 'different-capability';

    const response = await app.inject({ method: 'POST', url: path, headers, payload: body });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an idempotent retry whose request content changed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dashboardResponse));
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

  it('queues a read-only query and lets the Worker persist its answer and terminal SSE event', async () => {
    const fetchDashboardSummary = vi.fn().mockResolvedValue(dashboardResponse);
    vi.stubGlobal('fetch', fetchDashboardSummary);
    const repository = createTestRepository();
    const appendMessage = vi.spyOn(repository, 'appendMessage');
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository });

    const startBody = { runId, threadId, userMessage: '今天有几节课？' };
    const start = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ runId, threadId, status: 'queued' });
    await vi.waitFor(async () => expect((await repository.findRun(runId))?.status).toBe('completed'));
    expect(fetchDashboardSummary).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId,
      runId,
      role: 'assistant',
      content: '经营摘要（2026-10-17）：今日排课 4 节',
      leaseOwnerToken: expect.any(String),
    }));
    const [coreUrl, coreInit] = fetchDashboardSummary.mock.calls[0]!;
    const coreHeaders = coreInit.headers as Record<string, string>;
    expect(new URL(coreUrl).pathname).toBe('/tools/dashboard-summary');
    expect(
      verifySignedInternalRequest({
        secret,
        timestamp: coreHeaders[INTERNAL_REQUEST_TIMESTAMP_HEADER]!,
        nonce: coreHeaders[INTERNAL_REQUEST_NONCE_HEADER]!,
        signature: coreHeaders[INTERNAL_REQUEST_SIGNATURE_HEADER]!,
        method: 'GET',
        path: new URL(coreUrl).pathname,
        securityHeaders: {
          authorization: (coreInit.headers as Record<string, string>).authorization,
        },
      }),
    ).toBe(true);
    expect(coreHeaders.authorization).toBe(`Bearer ${capability}`);

    const completedEvents = await app.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}/events`),
    });
    expect(completedEvents.body).toContain('event: assistant.delta');
    expect(completedEvents.body).toContain('event: workspace.replace');
    expect(completedEvents.body).toContain('"type":"metric-grid"');
    expect(completedEvents.body).toContain('"value":"今日排课 4 节"');
    expect(completedEvents.body).toContain('event: run.completed');
    expect(completedEvents.body).not.toContain('event: clarification.requested');
    expect(completedEvents.body.indexOf('event: workspace.replace')).toBeLessThan(
      completedEvents.body.indexOf('event: assistant.delta'),
    );
    expect(completedEvents.body.indexOf('event: assistant.delta')).toBeLessThan(
      completedEvents.body.indexOf('event: run.completed'),
    );

    const resumeBody = { threadId, input: { approved: true } };
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

  it('keeps an SSE connection open after history replay and pushes events created later', async () => {
    let resolveDashboard: ((value: typeof dashboardResponse) => void) | undefined;
    let signalFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
    const dashboardPending = new Promise<typeof dashboardResponse>((resolve) => { resolveDashboard = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      signalFetchStarted?.();
      return dashboardPending;
    }));
    const repository = createTestRepository();
    const eventHub = new RunEventHub();
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository, eventHub });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口');

    const startBody = { runId, threadId, userMessage: '实时 SSE' };
    const startPromise = app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    await fetchStarted;

    const eventsPath = `/internal/assistant/runs/${runId}/events`;
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: eventsPath,
        headers: signedHeaders('GET', eventsPath),
      }, resolve);
      req.once('error', reject);
      req.end();
    });
    expect(response.statusCode).toBe(200);

    try {
      const history = await readUntilSseEvent(response, 'run.started');
      expect(history).toContain('event: run.started');
      expect(response.complete).toBe(false);
      const terminalEvent = readUntilSseEvent(response, 'run.completed');
      resolveDashboard?.(dashboardResponse);
      await startPromise;
      const pushed = await terminalEvent;
      expect(pushed).toContain('event: assistant.delta');
      expect(pushed).toContain('event: run.completed');
    } finally {
      response.destroy();
      await new Promise((resolve) => setImmediate(resolve));
      expect(eventHub.subscriberCount).toBe(0);
      await app.close();
    }
  });

  it('removes a live SSE subscription when the client disconnects', async () => {
    let resolveDashboard: ((value: typeof dashboardResponse) => void) | undefined;
    let signalFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
    const dashboardPending = new Promise<typeof dashboardResponse>((resolve) => { resolveDashboard = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => {
      signalFetchStarted?.();
      return dashboardPending;
    }));
    const eventHub = new RunEventHub();
    const app = buildServer({
      config,
      checkpointer: new MemorySaver(),
      repository: createTestRepository(),
      eventHub,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口');

    try {
      const startBody = { runId, threadId, userMessage: '断开清理' };
      const startPromise = app.inject({
        method: 'POST',
        url: '/internal/assistant/runs/start',
        headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
        payload: startBody,
      });
      await fetchStarted;
      const eventsPath = `/internal/assistant/runs/${runId}/events`;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: address.port,
          path: eventsPath,
          headers: signedHeaders('GET', eventsPath),
        }, resolve);
        req.once('error', reject);
        req.end();
      });
      await readUntilSseEvent(response, 'run.started');
      expect(eventHub.subscriberCount).toBe(1);

      const disconnected = once(response, 'close');
      response.destroy();
      await disconnected;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(eventHub.subscriberCount).toBe(0);
      resolveDashboard?.(dashboardResponse);
      await startPromise;
    } finally {
      await app.close();
    }
  });

  it('restores run status and SSE history through a new server instance', async () => {
    const repository = createTestRepository();
    const checkpointer = new MemorySaver();
    await seedLegacyWaitingRun({ checkpointer, repository });
    const firstApp = buildServer({ config, checkpointer, repository });
    await firstApp.close();

    const secondApp = buildServer({ config, checkpointer, repository });
    const restoredRun = await secondApp.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}`,
      headers: signedHeaders('GET', `/internal/assistant/runs/${runId}`),
    });
    expect(restoredRun.statusCode).toBe(200);
    expect(restoredRun.json()).toMatchObject({ runId, threadId, status: 'waiting_for_input' });
    const restartResumeBody = { threadId, input: { approved: true } };
    const resumed = await secondApp.inject({
      method: 'POST',
      url: `/internal/assistant/runs/${runId}/resume`,
      headers: signedHeaders('POST', `/internal/assistant/runs/${runId}/resume`, restartResumeBody),
      payload: restartResumeBody,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ runId, status: 'completed' });

    const resumedEvents = await secondApp.inject({
      method: 'GET',
      url: `/internal/assistant/runs/${runId}/events`,
      headers: {
        ...signedHeaders('GET', `/internal/assistant/runs/${runId}/events`, undefined, {
          'x-assistant-capability': capability,
          'last-event-id': '1',
        }),
        'last-event-id': '1',
      },
    });
    expect(resumedEvents.statusCode).toBe(200);
    expect(resumedEvents.body).not.toContain('id: 1');
    expect(resumedEvents.body).toContain('event: assistant.delta');
    expect(resumedEvents.body).toContain('event: run.completed');
    await secondApp.close();
  });

  it('claims a waiting run once when resume requests arrive concurrently', async () => {
    const checkpointer = new MemorySaver();
    const repository = createTestRepository();
    await seedLegacyWaitingRun({ checkpointer, repository });
    const app = buildServer({ config, checkpointer, repository });
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

  it('does not publish run.completed when the completed state cannot be persisted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dashboardResponse));
    const baseRepository = createTestRepository();
    const repository = {
      ...baseRepository,
      async updateRunWithEvent(
        input: Parameters<typeof baseRepository.updateRunWithEvent>[0],
        event: Parameters<typeof baseRepository.updateRunWithEvent>[1],
      ) {
        if (input.status === 'completed') throw new Error('status persistence failed');
        return baseRepository.updateRunWithEvent(input, event);
      },
    };
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository });
    const startBody = { runId, threadId, userMessage: '终态一致性' };
    const start = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody),
      payload: startBody,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ runId, threadId, status: 'queued' });
    await vi.waitFor(async () => expect((await baseRepository.findRun(runId))?.status).toBe('failed'));
    const eventTypes = (await baseRepository.listEvents(runId)).map((event) => event.event.type);
    expect(eventTypes).not.toContain('run.completed');
    expect(eventTypes).toContain('run.failed');
    await expect(baseRepository.findRun(runId)).resolves.toMatchObject({ status: 'failed' });
    await app.close();
  });

  it('returns a generic 500 response for a tool failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('internal tool details')));
    const repository = createTestRepository();
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository });

    const failureBody = { runId, threadId, userMessage: '阶段 0' };
    const response = await app.inject({
      method: 'POST',
      url: '/internal/assistant/runs/start',
      headers: signedHeaders('POST', '/internal/assistant/runs/start', failureBody),
      payload: failureBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId, threadId, status: 'queued' });
    await vi.waitFor(async () => expect((await repository.findRun(runId))?.status).toBe('failed'));
    expect(JSON.stringify(await repository.findRun(runId))).not.toContain('internal tool details');
    await app.close();
  });

  it('rejects a resume request for an unknown run without touching the graph', async () => {
    const fetchDashboardSummary = vi.fn().mockResolvedValue(dashboardResponse);
    vi.stubGlobal('fetch', fetchDashboardSummary);
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
    await vi.waitFor(() => expect(fetchDashboardSummary).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it('rejects an SSE cursor outside the PostgreSQL bigint range', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(dashboardResponse));
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
        ...signedHeaders('GET', path, undefined, {
          'x-assistant-capability': capability,
          'last-event-id': '9223372036854775808',
        }),
        'last-event-id': '9223372036854775808',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: '事件游标不合法' });
    await app.close();
  });

  it('rejects an event cursor changed after signing', async () => {
    const app = buildServer({ config, checkpointer: new MemorySaver(), repository: createTestRepository() });
    const path = `/internal/assistant/runs/${runId}/events`;
    const headers = signedHeaders('GET', path, undefined, {
      'x-assistant-capability': capability,
      'last-event-id': '41',
    });
    headers['last-event-id'] = '42';

    const response = await app.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('removes event subscribers when the connection subscription is closed', async () => {
    const hub = new RunEventHub();
    const subscription = hub.subscribe(runId);
    expect(hub.subscriberCount).toBe(1);
    subscription.close();
    expect(hub.subscriberCount).toBe(0);
    expect(await subscription.next(1)).toBeUndefined();
  });
});
