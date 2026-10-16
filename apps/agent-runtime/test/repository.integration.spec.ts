import { Pool } from 'pg';
import { createSignedInternalRequestHeaders } from '@piano/assistant-protocol/internal-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCheckpointer } from '../src/checkpoint/checkpointer.js';
import { createAgentRuntimeRepository } from '../src/persistence/repository.js';
import { buildServer } from '../src/server.js';

const databaseUrl = process.env.AGENT_DATABASE_URL;
const test = databaseUrl ? it : it.skip;

describe('Agent Runtime PostgreSQL repository', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('persists run status and event history across repository instances', async () => {
    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const clientRequestId = crypto.randomUUID();
    const first = createAgentRuntimeRepository({ connectionString: databaseUrl! });
    const second = createAgentRuntimeRepository({ connectionString: databaseUrl! });
    const cleanup = new Pool({ connectionString: databaseUrl });

    try {
      const created = await first.createRun({
        runId,
        threadId,
        userMessage: 'PostgreSQL 持久化验证',
        clientRequestId,
      });
      expect(created.created).toBe(true);
      const duplicate = await first.createRun({
        runId: crypto.randomUUID(),
        threadId,
        userMessage: '重复请求不应创建第二个运行',
        clientRequestId,
      });
      expect(duplicate).toMatchObject({ created: false, run: { runId } });
      const started = await first.appendEvent(runId, { type: 'run.started', runId, threadId });
      const clarification = await first.appendEvent(runId, {
        type: 'clarification.requested',
        question: '是否继续？',
      });
      await first.close();

      const restored = await second.findRun(runId);
      expect(restored).toMatchObject({ runId, threadId, status: 'running' });
      const resumedHistory = await second.listEvents(runId, clarification.eventId);
      expect(resumedHistory).toEqual([]);
      const completeHistory = await second.listEvents(runId, started.eventId);
      expect(completeHistory).toHaveLength(1);
      expect(completeHistory[0]?.event.type).toBe('clarification.requested');

      await second.updateRun({ runId, status: 'waiting_for_input' });
      const claims = await Promise.all([
        second.claimRunForResume(runId),
        second.claimRunForResume(runId),
      ]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

      const completed = await second.updateRun({ runId, status: 'completed' });
      expect(completed.status).toBe('completed');
    } finally {
      await second.close().catch(() => undefined);
      await cleanup.query('DELETE FROM agent_runtime.agent_run_events WHERE run_id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_messages WHERE run_id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_runs WHERE id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_threads WHERE id = $1', [threadId]);
      await cleanup.end();
    }
  }, 30_000);

  test('restores a run through a new server, repository, and PostgresSaver instance', async () => {
    const schema = `stage0_runtime_${crypto.randomUUID().replaceAll('-', '')}`;
    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const secret = 'stage-0-integration-secret-012345678901234567890';
    const config = {
      AGENT_PORT: 3100,
      AI_ENABLED: false,
      AI_PROVIDER: '',
      AI_MODEL: '',
      AI_API_KEY: '',
      AGENT_DATABASE_URL: databaseUrl!,
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
    const firstCheckpointer = createCheckpointer(databaseUrl!, schema);
    const secondCheckpointer = createCheckpointer(databaseUrl!, schema);
    const firstRepository = createAgentRuntimeRepository({ connectionString: databaseUrl! });
    const secondRepository = createAgentRuntimeRepository({ connectionString: databaseUrl! });
    const cleanup = new Pool({ connectionString: databaseUrl });
    let firstApp: Awaited<ReturnType<typeof buildServer>> | undefined;
    let secondApp: Awaited<ReturnType<typeof buildServer>> | undefined;

    try {
      await firstCheckpointer.setup();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(statusResponse));
      firstApp = buildServer({ config, checkpointer: firstCheckpointer, repository: firstRepository });
      const startPath = '/internal/assistant/runs/start';
      const startBody = { runId, threadId, userMessage: '真实重启恢复验证' };
      const start = await firstApp.inject({
        method: 'POST',
        url: startPath,
        headers: {
          ...createSignedInternalRequestHeaders({
            secret,
            method: 'POST',
            path: startPath,
            body: startBody,
          }),
          'x-assistant-capability': 'stage-0-capability',
        },
        payload: startBody,
      });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toMatchObject({ runId, threadId, status: 'waiting_for_input' });
      await firstApp.close();
      await firstRepository.close();
      await firstCheckpointer.end();

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('恢复时不应重新读取 Core')));
      secondApp = buildServer({ config, checkpointer: secondCheckpointer, repository: secondRepository });
      const restored = await secondApp.inject({
        method: 'GET',
        url: `/internal/assistant/runs/${runId}`,
        headers: {
          ...createSignedInternalRequestHeaders({
            secret,
            method: 'GET',
            path: `/internal/assistant/runs/${runId}`,
          }),
          'x-assistant-capability': 'stage-0-capability',
        },
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ runId, threadId, status: 'waiting_for_input' });

      const resumePath = `/internal/assistant/runs/${runId}/resume`;
      const resumeBody = { threadId, input: { approved: true } };
      const resume = await secondApp.inject({
        method: 'POST',
        url: resumePath,
        headers: {
          ...createSignedInternalRequestHeaders({
            secret,
            method: 'POST',
            path: resumePath,
            body: resumeBody,
          }),
          'x-assistant-capability': 'stage-0-capability',
        },
        payload: resumeBody,
      });
      expect(resume.statusCode).toBe(200);
      expect(resume.json()).toMatchObject({ runId, threadId, status: 'completed' });
    } finally {
      await secondApp?.close().catch(() => undefined);
      await firstApp?.close().catch(() => undefined);
      await firstRepository.close().catch(() => undefined);
      await secondRepository.close().catch(() => undefined);
      await firstCheckpointer.end().catch(() => undefined);
      await secondCheckpointer.end().catch(() => undefined);
      await cleanup.query('DELETE FROM agent_runtime.agent_run_events WHERE run_id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_messages WHERE run_id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_runs WHERE id = $1', [runId]);
      await cleanup.query('DELETE FROM agent_runtime.agent_threads WHERE id = $1', [threadId]);
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
      await cleanup.end();
    }
  }, 30_000);
});
