import 'dotenv/config';
import { createCheckpointer } from './checkpoint/checkpointer.js';
import { parseAgentConfig } from './config/agent-config.js';
import { createAgentRuntimeRepository } from './persistence/repository.js';
import { buildServer } from './server.js';
import { RunEventHub } from './events/run-event-hub.js';
import { createDialogueRunExecutor } from './worker/dialogue-executor.js';
import { PostgresDialogueTaskStore } from './persistence/task-store.js';
import { DialogueReadClient } from './tools/dialogue-tools.js';
import { RunWorker } from './worker/run-worker.js';
import { CoreToolClient } from './tools/core-tool-client.js';
import { createChatModel } from './llm/model-factory.js';
import { PostgresInternalRequestReplayStore } from './persistence/replay-protector.js';

const config = parseAgentConfig(process.env);
const checkpointer = createCheckpointer(config.AGENT_DATABASE_URL);
const repository = createAgentRuntimeRepository({ connectionString: config.AGENT_DATABASE_URL });
const eventHub = new RunEventHub();
const replayStore = new PostgresInternalRequestReplayStore(config.AGENT_DATABASE_URL);
const tasks = new PostgresDialogueTaskStore(config.AGENT_DATABASE_URL);
const app = buildServer({ config, checkpointer, repository, eventHub, replayStore, requireActorBinding: true });
const coreTools = new CoreToolClient(
  config.CORE_INTERNAL_API_URL,
  config.AI_REQUEST_TIMEOUT_MS,
  config.INTERNAL_SERVICE_SECRET,
);
const model = createChatModel(config);
const executeBusinessRun = createDialogueRunExecutor({
  tasks,
  reads: new DialogueReadClient(config.CORE_INTERNAL_API_URL, config.AI_REQUEST_TIMEOUT_MS, config.INTERNAL_SERVICE_SECRET),
  coreTools,
  ...(model ? { model } : {}),
  runTimeoutMs: config.AI_RUN_TIMEOUT_MS,
});
const worker = config.AGENT_WORKER_ENABLED
  ? new RunWorker({
      repository,
      execute: executeBusinessRun,
      leaseDurationMs: config.AGENT_WORKER_LEASE_DURATION_MS,
      renewIntervalMs: config.AGENT_WORKER_RENEW_INTERVAL_MS,
      pollIntervalMs: config.AGENT_WORKER_POLL_INTERVAL_MS,
      recoveryBatchSize: config.AGENT_WORKER_RECOVERY_BATCH_SIZE,
      onEvent: (runId, event) => eventHub.publish(runId, event),
      onError: (error) => {
        const message = error instanceof Error ? error.message : '未知错误';
        console.error(`Agent Run Worker 执行失败：${message}`);
      },
    })
  : undefined;

let closing: Promise<void> | undefined;
const close = async (): Promise<void> => {
  closing ??= (async () => {
    const failures: unknown[] = [];
    for (const closeStep of [
      worker ? () => worker.stop() : undefined,
      () => app.close(),
      () => checkpointer.end(),
      () => repository.close(),
      () => tasks.close(),
    ]) {
      if (!closeStep) continue;
      try {
        await closeStep();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Runtime 关闭失败');
  })();
  return closing;
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

if (worker) await worker.start();
await app.listen({ port: config.AGENT_PORT, host: '0.0.0.0' });
