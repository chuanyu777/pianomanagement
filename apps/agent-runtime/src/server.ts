import type { BaseCheckpointSaver } from '@langchain/langgraph';
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
import { verifySignedInternalRequest } from '@piano/assistant-protocol/internal-auth';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AgentConfig } from './config/agent-config.js';
import { createChatModel } from './llm/model-factory.js';
import { RunEventHub } from './events/run-event-hub.js';
import { createSpikeGraph, resumeApproval } from './graph/spike-graph.js';
import type {
  AgentRuntimeRepository,
  PersistedAssistantEvent,
} from './persistence/repository.js';
import type { RunWorker } from './worker/run-worker.js';
import { trustedCapabilityBinding } from './persistence/trusted-capability.js';
import {
  InMemoryInternalRequestReplayStore,
  type InternalRequestReplayStore,
} from './persistence/replay-protector.js';

function headerValue(
  request: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(request.headers).find(([key]) => key.toLowerCase() === normalizedName);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
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

const EVENT_REPLAY_BATCH_SIZE = 1_000;
const SSE_HEARTBEAT_INTERVAL_MS = 10_000;
const SSE_MAX_IDLE_MS = 5 * 60_000;

function isTerminalEvent(event: PersistedAssistantEvent): boolean {
  return event.event.type === 'run.completed' || event.event.type === 'run.failed';
}

async function writeRaw(reply: FastifyReply, chunk: string): Promise<boolean> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  if (reply.raw.write(chunk)) return true;
  return new Promise((resolve) => {
    const cleanup = () => {
      reply.raw.off('drain', onDrain);
      reply.raw.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    reply.raw.once('drain', onDrain);
    reply.raw.once('close', onClose);
  });
}

function formatPersistedEvent(event: PersistedAssistantEvent): string {
  return `id: ${event.eventId}\n${encodeSseEvent(event.event)}`;
}

export function buildServer(input: {
  config: AgentConfig;
  checkpointer: BaseCheckpointSaver;
  repository: AgentRuntimeRepository;
  eventHub?: RunEventHub;
  worker?: Pick<RunWorker, 'start' | 'stop'>;
  replayStore?: InternalRequestReplayStore;
  requireActorBinding?: boolean;
}): FastifyInstance {
  const app = Fastify({ logger: true });
  const model = createChatModel(input.config);
  const replayStore = input.replayStore ?? new InMemoryInternalRequestReplayStore();
  const eventHub = input.eventHub ?? new RunEventHub();
  if (input.worker) {
    app.addHook('onReady', async () => input.worker!.start());
    app.addHook('onClose', async () => input.worker!.stop());
  }
  app.addHook('onClose', async () => eventHub.closeAll());
  app.addHook('onClose', async () => replayStore.close());

  const appendEvent = async (
    runId: string,
    event: Parameters<AgentRuntimeRepository['appendEvent']>[1],
    leaseOwnerToken?: string,
  ) => {
    const persisted = await input.repository.appendEvent(runId, event, leaseOwnerToken);
    eventHub.publish(runId, persisted);
    return persisted;
  };
  const updateRunWithEvent = async (
    update: Parameters<AgentRuntimeRepository['updateRunWithEvent']>[0],
    event: Parameters<AgentRuntimeRepository['updateRunWithEvent']>[1],
    leaseOwnerToken?: string,
  ) => {
    const committed = await input.repository.updateRunWithEvent({ ...update, ...(leaseOwnerToken ? { leaseOwnerToken } : {}) }, event);
    eventHub.publish(update.runId, committed.event);
    return committed.run;
  };
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
        securityHeaders: {
          authorization: headerValue(request, 'authorization'),
          [ASSISTANT_CAPABILITY_HEADER]: capability,
          'last-event-id': headerValue(request, 'last-event-id'),
        },
      }) ||
      !(await replayStore.consume(nonce)) ||
      !capability
    ) {
      return reply.code(401).send({ message: '服务鉴权失败' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    return reply.code(500).send({ message: 'Agent Runtime 内部错误' });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'agent-runtime', modelAvailable: Boolean(model) }));

  app.get('/internal/assistant/threads', async (request, reply) => {
    if (!input.repository.listThreads) return reply.code(501).send({ message: '任务列表暂不可用' });
    const query = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }), request.query, reply);
    if (!query) return;
    let actorKey: string;
    try { actorKey = trustedCapabilityBinding(headerValue(request, ASSISTANT_CAPABILITY_HEADER)!).actorKey; }
    catch { return reply.code(403).send({ message: '无权访问该任务' }); }
    return reply.send(await input.repository.listThreads(actorKey, query.limit));
  });

  app.get('/internal/assistant/threads/:threadId', async (request, reply) => {
    if (!input.repository.getThread) return reply.code(501).send({ message: '任务详情暂不可用' });
    const params = parseBody(z.object({ threadId: z.string().uuid() }), request.params, reply);
    if (!params) return;
    let actorKey: string;
    try { actorKey = trustedCapabilityBinding(headerValue(request, ASSISTANT_CAPABILITY_HEADER)!, { threadId: params.threadId }).actorKey; }
    catch { return reply.code(403).send({ message: '无权访问该任务' }); }
    const thread = await input.repository.getThread(params.threadId, actorKey);
    return thread ? reply.send(thread) : reply.code(404).send({ message: '任务不存在' });
  });

  app.post('/internal/assistant/runs/start', async (request, reply) => {
    const body = parseBody(AssistantStartRequestSchema, request.body, reply);
    if (!body) return;
    const capability = headerValue(request, ASSISTANT_CAPABILITY_HEADER)!;
    let actorKey: string | undefined;
    if (input.requireActorBinding) {
      try { actorKey = trustedCapabilityBinding(capability, { threadId: body.threadId, runId: body.runId }).actorKey; }
      catch { return reply.code(403).send({ message: '无权访问该任务' }); }
      const owner = await input.repository.getThreadOwner(body.threadId);
      if (owner !== null && owner !== actorKey) return reply.code(403).send({ message: '无权访问该任务' });
    }
    const persisted = await input.repository.createRun({ ...body, capability, ...(actorKey ? { actorKey } : {}) });
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

    return reply.send(AssistantRunSchema.parse(persisted.run));
  });

  app.post('/internal/assistant/runs/:runId/resume', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    const body = parseBody(AssistantResumeRequestSchema, request.body, reply);
    if (!params || !body) return;
    const record = await input.repository.findRun(params.runId);
    if (!record) return reply.code(404).send({ message: '运行不存在' });
    if (input.requireActorBinding) return reply.code(409).send({ message: '业务补充请在当前会话发送下一条消息；不能用旧技术审批执行业务。' });
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
      ...(model ? { model } : {}),
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
        await appendEvent(params.runId, { type: 'assistant.delta', text: result.answer });
      }
      const run = await updateRunWithEvent(
        { runId: params.runId, status: 'completed' },
        { type: 'run.completed', runId: params.runId },
      );
      return reply.send(AssistantRunSchema.parse(run));
    } catch (error) {
      await updateRunWithEvent(
        { runId: params.runId, status: 'failed', errorCode: 'GRAPH_FAILED' },
        {
          type: 'run.failed',
          code: 'GRAPH_FAILED',
          message: 'Agent 运行失败，请稍后重试',
          retryable: true,
        },
      );
      throw error;
    }
  });

  app.get('/internal/assistant/runs/:runId', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const run = await input.repository.findRun(params.runId);
    if (!run) return reply.code(404).send({ message: '运行不存在' });
    if (input.requireActorBinding) {
      try {
        const binding = trustedCapabilityBinding(headerValue(request, ASSISTANT_CAPABILITY_HEADER)!, { runId: params.runId, threadId: run.threadId });
        if (await input.repository.getThreadOwner(run.threadId) !== binding.actorKey) return reply.code(403).send({ message: '无权访问该任务' });
      } catch { return reply.code(403).send({ message: '无权访问该任务' }); }
    }
    return reply.send(AssistantRunSchema.parse(run));
  });

  app.get('/internal/assistant/runs/:runId/events', async (request, reply) => {
    const params = parseBody(z.object({ runId: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const record = await input.repository.findRun(params.runId);
    if (!record) return reply.code(404).send({ message: '运行不存在' });
    if (input.requireActorBinding) {
      try {
        const binding = trustedCapabilityBinding(headerValue(request, ASSISTANT_CAPABILITY_HEADER)!, { runId: params.runId, threadId: record.threadId });
        if (await input.repository.getThreadOwner(record.threadId) !== binding.actorKey) return reply.code(403).send({ message: '无权访问该任务' });
      } catch { return reply.code(403).send({ message: '无权访问该任务' }); }
    }
    const lastEventId = headerValue(request, 'last-event-id');
    if (lastEventId !== undefined && !validEventCursor(lastEventId)) {
      return reply.code(400).send({ message: '事件游标不合法' });
    }
    const subscription = eventHub.subscribe(params.runId);
    const socket = reply.raw.socket;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      subscription.close();
      request.raw.off('aborted', cleanup);
      reply.raw.off('close', cleanup);
      socket?.off('close', cleanup);
    };
    request.raw.once('aborted', cleanup);
    reply.raw.once('close', cleanup);
    socket?.once('close', cleanup);

    try {
      let cursor = lastEventId;
      let lastSent = lastEventId === undefined ? 0n : BigInt(lastEventId);
      const replay = async () => {
        while (!cleaned) {
          const events = await input.repository.listEvents(params.runId, cursor);
          if (events.length === 0) break;
          for (const event of events) {
            const eventId = BigInt(event.eventId);
            cursor = event.eventId;
            if (eventId <= lastSent) continue;
            lastSent = eventId;
            if (!(await writeRaw(reply, formatPersistedEvent(event)))) return false;
            if (isTerminalEvent(event)) return true;
          }
          if (events.length < EVENT_REPLAY_BATCH_SIZE) break;
        }
        return false;
      };

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders();

      if (!(await replay())) {
        let lastActivityAt = Date.now();
        while (!cleaned && !reply.raw.destroyed && !reply.raw.writableEnded) {
          if (subscription.overflowed || subscription.closed) break;
          const event = await subscription.next(SSE_HEARTBEAT_INTERVAL_MS);
          if (!event) {
            if (subscription.overflowed || subscription.closed) break;
            if (Date.now() - lastActivityAt >= SSE_MAX_IDLE_MS) break;
            if (!(await writeRaw(reply, ': keep-alive\n\n'))) break;
            continue;
          }
          const eventId = BigInt(event.eventId);
          if (eventId <= lastSent) continue;
          lastSent = eventId;
          if (!(await writeRaw(reply, formatPersistedEvent(event)))) break;
          lastActivityAt = Date.now();
          if (isTerminalEvent(event)) break;
        }
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    } finally {
      cleanup();
    }
  });

  return app;
}
