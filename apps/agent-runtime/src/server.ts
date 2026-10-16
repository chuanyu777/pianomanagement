import { isInterrupted, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  ASSISTANT_CAPABILITY_HEADER,
  AssistantResumeRequestSchema,
  AssistantRunSchema,
  AssistantStartRequestSchema,
  encodeSseEvent,
  INTERNAL_REQUEST_NONCE_HEADER,
  INTERNAL_REQUEST_SIGNATURE_HEADER,
  INTERNAL_REQUEST_TIMESTAMP_HEADER,
} from '@piano/assistant-protocol';
import {
  InternalRequestReplayProtector,
  verifySignedInternalRequest,
} from '@piano/assistant-protocol/internal-auth';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AgentConfig } from './config/agent-config.js';
import { createSpikeGraph, resumeApproval } from './graph/spike-graph.js';
import type {
  AgentRuntimeRepository,
  PersistedAssistantEvent,
} from './persistence/repository.js';
import { CoreToolClient } from './tools/core-tool-client.js';

function headerValue(
  request: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  reply: FastifyReply,
): T | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  void reply.code(400).send({ message: '请求参数不合法' });
  return undefined;
}

function checkpointThreadId(threadId: string, runId: string): string {
  return `${threadId}:${runId}`;
}

function validEventCursor(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

function writeEvents(reply: FastifyReply, events: PersistedAssistantEvent[]): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  for (const event of events) {
    reply.raw.write(`id: ${event.eventId}\n${encodeSseEvent(event.event)}`);
  }
  reply.raw.end();
}

export function buildServer(input: {
  config: AgentConfig;
  checkpointer: BaseCheckpointSaver;
  repository: AgentRuntimeRepository;
}): FastifyInstance {
  const app = Fastify({ logger: true });
  const coreTools = new CoreToolClient(
    input.config.CORE_INTERNAL_API_URL,
    input.config.AI_REQUEST_TIMEOUT_MS,
    input.config.INTERNAL_SERVICE_SECRET,
  );
  const replayProtector = new InternalRequestReplayProtector();
  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return;
    const timestamp = headerValue(request, INTERNAL_REQUEST_TIMESTAMP_HEADER);
    const nonce = headerValue(request, INTERNAL_REQUEST_NONCE_HEADER);
    const signature = headerValue(request, INTERNAL_REQUEST_SIGNATURE_HEADER);
    const capability = headerValue(request, ASSISTANT_CAPABILITY_HEADER);
    if (
      !timestamp ||
      !nonce ||
      !signature ||
      !verifySignedInternalRequest({
        secret: input.config.INTERNAL_SERVICE_SECRET,
        timestamp,
        nonce,
        signature,
        method: request.method,
        path: request.url,
        body: request.body,
      }) ||
      !replayProtector.consume(nonce) ||
      !capability
    ) {
      return reply.code(401).send({ message: '服务鉴权失败' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ message: 'Agent Runtime 内部错误' });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'agent-runtime' }));

  app.post('/internal/assistant/runs/start', async (request, reply) => {
    const body = parseBody(AssistantStartRequestSchema, request.body, reply);
    if (!body) return;
    const persisted = await input.repository.createRun(body);
    if (!persisted.created) {
      if (persisted.run.threadId !== body.threadId) {
        return reply.code(409).send({ message: 'runId 与线程不匹配' });
      }
      if (
        persisted.run.userMessage !== body.userMessage ||
        (body.clientRequestId !== undefined &&
          persisted.run.clientRequestId !== body.clientRequestId)
      ) {
        return reply.code(409).send({ message: '幂等请求内容不一致' });
      }
      return reply.send(AssistantRunSchema.parse(persisted.run));
    }

    const graph = createSpikeGraph({
      checkpointer: input.checkpointer,
      fetchSystemStatus: () =>
        coreTools.getSystemStatus(headerValue(request, ASSISTANT_CAPABILITY_HEADER)!),
    });
    try {
      await input.repository.appendEvent(body.runId, {
        type: 'run.started',
        runId: body.runId,
        threadId: body.threadId,
      });
      const result = await graph.invoke(
        { runId: body.runId, threadId: body.threadId, userMessage: body.userMessage },
        {
          configurable: { thread_id: checkpointThreadId(body.threadId, body.runId) },
          signal: AbortSignal.timeout(input.config.AI_RUN_TIMEOUT_MS),
        },
      );
      const status = isInterrupted(result) ? 'waiting_for_input' : 'completed';
      const run = await input.repository.updateRun({ runId: body.runId, status });
      if (isInterrupted(result)) {
        await input.repository.appendEvent(body.runId, {
          type: 'clarification.requested',
          question: '是否继续完成阶段 0 技术验证？',
        });
      }
      return reply.send(AssistantRunSchema.parse(run));
    } catch (error) {
      await input.repository.updateRun({ runId: body.runId, status: 'failed', errorCode: 'GRAPH_FAILED' });
      await input.repository.appendEvent(body.runId, {
        type: 'run.failed',
        code: 'GRAPH_FAILED',
        message: 'Agent 运行失败，请稍后重试',
        retryable: true,
      });
      throw error;
    }
  });

  app.post('/internal/assistant/runs/:runId/resume', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    const body = parseBody(AssistantResumeRequestSchema, request.body, reply);
    if (!params || !body) return;
    const record = await input.repository.findRun(params.runId);
    if (!record) return reply.code(404).send({ message: '运行不存在' });
    if (record.threadId !== body.threadId) {
      return reply.code(404).send({ message: '运行不存在' });
    }
    if (record.status === 'completed') {
      return reply.send(AssistantRunSchema.parse(record));
    }
    if (record.status !== 'waiting_for_input') {
      return reply.code(409).send({ message: '当前运行状态不可恢复' });
    }
    const claimed = await input.repository.claimRunForResume(params.runId);
    if (!claimed) {
      const latest = await input.repository.findRun(params.runId);
      if (latest?.status === 'completed') {
        return reply.send(AssistantRunSchema.parse(latest));
      }
      return reply.code(409).send({ message: '当前运行正在恢复' });
    }
    const graph = createSpikeGraph({
      checkpointer: input.checkpointer,
      fetchSystemStatus: () => Promise.reject(new Error('恢复流程不应重新执行已完成的只读节点')),
    });
    try {
      const result = await graph.invoke(resumeApproval(body.input.approved), {
        configurable: { thread_id: checkpointThreadId(body.threadId, params.runId) },
        signal: AbortSignal.timeout(input.config.AI_RUN_TIMEOUT_MS),
      });
      if (result.runId !== params.runId) {
        return reply.code(409).send({ message: 'runId 与线程不匹配' });
      }
      if (typeof result.answer === 'string') {
        await input.repository.appendMessage({
          threadId: body.threadId,
          runId: params.runId,
          role: 'assistant',
          content: result.answer,
        });
        await input.repository.appendEvent(params.runId, { type: 'assistant.delta', text: result.answer });
      }
      await input.repository.appendEvent(params.runId, { type: 'run.completed', runId: params.runId });
      const run = await input.repository.updateRun({ runId: params.runId, status: 'completed' });
      return reply.send(AssistantRunSchema.parse(run));
    } catch (error) {
      await input.repository.updateRun({ runId: params.runId, status: 'failed', errorCode: 'GRAPH_FAILED' });
      await input.repository.appendEvent(params.runId, {
        type: 'run.failed',
        code: 'GRAPH_FAILED',
        message: 'Agent 运行失败，请稍后重试',
        retryable: true,
      });
      throw error;
    }
  });

  app.get('/internal/assistant/runs/:runId', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const run = await input.repository.findRun(params.runId);
    if (!run) return reply.code(404).send({ message: '运行不存在' });
    return reply.send(AssistantRunSchema.parse(run));
  });

  app.get('/internal/assistant/runs/:runId/events', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const record = await input.repository.findRun(params.runId);
    if (!record) return reply.code(404).send({ message: '运行不存在' });
    const lastEventId = headerValue(request, 'last-event-id');
    if (lastEventId !== undefined && !validEventCursor(lastEventId)) {
      return reply.code(400).send({ message: '事件游标不合法' });
    }
    const events = await input.repository.listEvents(
      params.runId,
      lastEventId,
    );
    writeEvents(reply, events);
  });

  return app;
}
