import { MemorySaver } from '@langchain/langgraph';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import type { AgentRuntimeRepository } from '../src/persistence/repository.js';
import { createTestRepository } from './test-repository.js';

const secret = 'stage-0-test-secret-012345678901234567890123';
const config = {
  AGENT_PORT: 3100,
  AGENT_WORKER_ENABLED: false,
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

const threadId = 'a2b50d20-bd44-4f42-b7f0-148535470c75';
const runId = 'e200271f-06a4-45e6-bdb8-6c59b843a1fa';
const otherThreadId = 'b2b50d20-bd44-4f42-b7f0-148535470c75';
const otherRunId = 'f200271f-06a4-45e6-bdb8-6c59b843a1fa';
const teacherOneId = '11111111-1111-4111-8111-111111111111';
const teacherTwoId = '22222222-2222-4222-8222-222222222222';

type ActorClaims = {
  sub: string;
  role: string;
  teacherId?: string;
  threadId: string;
  runId: string;
  exp?: number;
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function capability(claims: ActorClaims): string {
  const { exp = Math.floor(Date.now() / 1_000) + 300, ...rest } = claims;
  return `test.${encode({ ...rest, exp })}.test-signature`;
}

function signedHeaders(
  method: string,
  path: string,
  body: unknown,
  token: string,
  lastEventId?: string,
): Record<string, string> {
  const securityHeaders = {
    'x-assistant-capability': token,
    ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
  };
  return {
    ...createSignedInternalRequestHeaders({
      secret,
      method,
      path,
      body,
      securityHeaders,
    }),
    'x-assistant-capability': token,
    ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
  };
}

function buildTestServer(repository: AgentRuntimeRepository, requireActorBinding: boolean) {
  return buildServer({
    config,
    checkpointer: new MemorySaver(),
    repository,
    requireActorBinding,
  });
}

async function startRun(
  app: ReturnType<typeof buildTestServer>,
  claims: ActorClaims,
  userMessage = '查询经营摘要',
) {
  const body = { runId: claims.runId, threadId: claims.threadId, userMessage };
  return app.inject({
    method: 'POST',
    url: '/internal/assistant/runs/start',
    headers: signedHeaders('POST', '/internal/assistant/runs/start', body, capability(claims)),
    payload: body,
  });
}

describe('dialogue actor and capability boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists and reads persisted tasks through the actor binding derived from the signed capability', async () => {
    const base = createTestRepository();
    const listThreads = vi.fn().mockResolvedValue([{ threadId, title: '查看今日排课', lastActivityAt: '2026-10-26T02:00:00.000Z', latestStatus: 'completed' }]);
    const getThread = vi.fn().mockResolvedValue({ threadId, title: '查看今日排课', lastActivityAt: '2026-10-26T02:00:00.000Z', latestStatus: 'completed', messages: [], workspace: null });
    const app = buildTestServer({ ...base, listThreads, getThread }, true);
    const claims = { sub: 'owner-user', role: 'OWNER', threadId, runId };
    try {
      const listPath = '/internal/assistant/threads?limit=12';
      const list = await app.inject({ method: 'GET', url: listPath, headers: signedHeaders('GET', listPath, undefined, capability(claims)) });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([{ threadId, title: '查看今日排课', lastActivityAt: '2026-10-26T02:00:00.000Z', latestStatus: 'completed' }]);
      expect(listThreads).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 12);
      const detailPath = `/internal/assistant/threads/${threadId}`;
      const detail = await app.inject({ method: 'GET', url: detailPath, headers: signedHeaders('GET', detailPath, undefined, capability(claims)) });
      expect(detail.statusCode).toBe(200);
      expect(getThread).toHaveBeenCalledWith(threadId, listThreads.mock.calls[0]![0]);
    } finally { await app.close(); }
  });

  it('control: disabling actor binding lets a different actor start another run in the same thread', async () => {
    const app = buildTestServer(createTestRepository(), false);
    const owner = { sub: 'owner-user', role: 'TEACHER', teacherId: teacherOneId, threadId, runId };
    const differentActor = {
      sub: 'other-user',
      role: 'TEACHER',
      teacherId: teacherOneId,
      threadId,
      runId: otherRunId,
    };

    try {
      await expect(startRun(app, owner)).resolves.toMatchObject({ statusCode: 200 });
      await expect(startRun(app, differentActor)).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      await app.close();
    }
  });

  it('production binding rejects same-thread actors with different sub, role, or teacherId on start, history, and SSE', async () => {
    const repository = createTestRepository();
    const app = buildTestServer(repository, true);
    const owner = { sub: 'owner-user', role: 'TEACHER', teacherId: teacherOneId, threadId, runId };
    const variants = [
      { sub: 'other-user', role: 'TEACHER', teacherId: teacherOneId },
      { sub: 'owner-user', role: 'OWNER' },
      { sub: 'owner-user', role: 'TEACHER', teacherId: teacherTwoId },
    ];

    try {
      await expect(startRun(app, owner)).resolves.toMatchObject({ statusCode: 200 });

      for (const [index, variant] of variants.entries()) {
        const startClaims = { ...variant, threadId, runId: `${index + 1}200271f-06a4-45e6-bdb8-6c59b843a1fa` };
        const historyClaims = { ...variant, threadId, runId };
        const start = await startRun(app, startClaims, '越权启动');
        expect(start.statusCode).toBe(403);

        const historyPath = `/internal/assistant/runs/${runId}`;
        const history = await app.inject({
          method: 'GET',
          url: historyPath,
          headers: signedHeaders('GET', historyPath, undefined, capability(historyClaims)),
        });
        expect(history.statusCode).toBe(403);

        const eventsPath = `/internal/assistant/runs/${runId}/events`;
        const events = await app.inject({
          method: 'GET',
          url: eventsPath,
          headers: signedHeaders('GET', eventsPath, undefined, capability(historyClaims)),
        });
        expect(events.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects capability thread, run, and expiry mismatches on start, history, and SSE', async () => {
    const repository = createTestRepository();
    const app = buildTestServer(repository, true);
    const owner = { sub: 'owner-user', role: 'TEACHER', teacherId: teacherOneId, threadId, runId };
    const invalidCapabilities = [
      { ...owner, threadId: otherThreadId },
      { ...owner, runId: otherRunId },
      { ...owner, exp: Math.floor(Date.now() / 1_000) - 1 },
    ];

    try {
      await expect(startRun(app, owner)).resolves.toMatchObject({ statusCode: 200 });

      for (const invalidClaims of invalidCapabilities) {
        const token = capability(invalidClaims);
        const startBody = { runId, threadId, userMessage: '查询经营摘要' };
        const start = await app.inject({
          method: 'POST',
          url: '/internal/assistant/runs/start',
          headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody, token),
          payload: startBody,
        });
        expect(start.statusCode).toBe(403);

        const historyPath = `/internal/assistant/runs/${runId}`;
        const history = await app.inject({
          method: 'GET',
          url: historyPath,
          headers: signedHeaders('GET', historyPath, undefined, token),
        });
        expect(history.statusCode).toBe(403);

        const eventsPath = `/internal/assistant/runs/${runId}/events`;
        const events = await app.inject({
          method: 'GET',
          url: eventsPath,
          headers: signedHeaders('GET', eventsPath, undefined, token),
        });
        expect(events.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('allows continuous requests from the same identity', async () => {
    const repository = createTestRepository();
    const app = buildTestServer(repository, true);
    const owner = { sub: 'owner-user', role: 'TEACHER', teacherId: teacherOneId, threadId, runId };
    const token = capability(owner);
    const startBody = { runId, threadId, userMessage: '同身份连续请求' };

    try {
      const firstStart = await app.inject({
        method: 'POST',
        url: '/internal/assistant/runs/start',
        headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody, token),
        payload: startBody,
      });
      expect(firstStart.statusCode).toBe(200);

      const repeatedStart = await app.inject({
        method: 'POST',
        url: '/internal/assistant/runs/start',
        headers: signedHeaders('POST', '/internal/assistant/runs/start', startBody, token),
        payload: startBody,
      });
      expect(repeatedStart.statusCode).toBe(200);

      const historyPath = `/internal/assistant/runs/${runId}`;
      const history = await app.inject({
        method: 'GET',
        url: historyPath,
        headers: signedHeaders('GET', historyPath, undefined, token),
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({ runId, threadId, status: 'queued' });

      await repository.appendEvent(runId, { type: 'run.completed', runId });
      const eventsPath = `/internal/assistant/runs/${runId}/events`;
      const events = await app.inject({
        method: 'GET',
        url: eventsPath,
        headers: signedHeaders('GET', eventsPath, undefined, token),
      });
      expect(events.statusCode).toBe(200);
      expect(events.body).toContain('event: run.completed');
    } finally {
      await app.close();
    }
  });

  it('does not execute business through the production old resume route', async () => {
    const repository = createTestRepository();
    const claimRunForResume = vi.spyOn(repository, 'claimRunForResume');
    const appendMessage = vi.spyOn(repository, 'appendMessage');
    const app = buildTestServer(repository, true);
    const owner = { sub: 'owner-user', role: 'TEACHER', teacherId: teacherOneId, threadId, runId };
    const token = capability(owner);

    try {
      await expect(startRun(app, owner)).resolves.toMatchObject({ statusCode: 200 });
      await repository.updateRun({ runId, status: 'waiting_for_input' });

      const path = `/internal/assistant/runs/${runId}/resume`;
      const body = { threadId, input: { approved: true } };
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: signedHeaders('POST', path, body, token),
        payload: body,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ message: '业务补充请在当前会话发送下一条消息；不能用旧技术审批执行业务。' });
      expect(claimRunForResume).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
      await expect(repository.findRun(runId)).resolves.toMatchObject({ status: 'waiting_for_input' });
    } finally {
      await app.close();
    }
  });
});
