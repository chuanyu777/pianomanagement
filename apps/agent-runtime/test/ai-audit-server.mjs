// Same production executor/tools/worker, with only its business date injected.
import { parseAgentConfig } from '../dist/config/agent-config.js';
import { createCheckpointer } from '../dist/checkpoint/checkpointer.js';
import { createAgentRuntimeRepository } from '../dist/persistence/repository.js';
import { PostgresDialogueTaskStore } from '../dist/persistence/task-store.js';
import { PostgresInternalRequestReplayStore } from '../dist/persistence/replay-protector.js';
import { buildServer } from '../dist/server.js';
import { RunEventHub } from '../dist/events/run-event-hub.js';
import { createDialogueRunExecutor } from '../dist/worker/dialogue-executor.js';
import { CoreToolClient } from '../dist/tools/core-tool-client.js';
import { DialogueReadClient } from '../dist/tools/dialogue-tools.js';
import { createChatModel } from '../dist/llm/model-factory.js';
import { RunWorker } from '../dist/worker/run-worker.js';

const config=parseAgentConfig(process.env);
if(new URL(config.AGENT_DATABASE_URL).pathname!=='/piano_agent_ai_audit')throw new Error('ISOLATED_AUDIT_DATABASE_REQUIRED');
const fixed=new Date(process.env.AI_AUDIT_BUSINESS_NOW);
if(!Number.isFinite(fixed.getTime()))throw new Error('AUDIT_CLOCK_REQUIRED');
const repository=createAgentRuntimeRepository({connectionString:config.AGENT_DATABASE_URL});
const checkpointer=createCheckpointer(config.AGENT_DATABASE_URL);
const tasks=new PostgresDialogueTaskStore(config.AGENT_DATABASE_URL);
const replayStore=new PostgresInternalRequestReplayStore(config.AGENT_DATABASE_URL);
const hub=new RunEventHub();
const app=buildServer({config,repository,checkpointer,eventHub:hub,replayStore,requireActorBinding:true});
const worker=new RunWorker({repository,execute:createDialogueRunExecutor({tasks,
  reads:new DialogueReadClient(config.CORE_INTERNAL_API_URL,config.AI_REQUEST_TIMEOUT_MS,config.INTERNAL_SERVICE_SECRET),
  coreTools:new CoreToolClient(config.CORE_INTERNAL_API_URL,config.AI_REQUEST_TIMEOUT_MS,config.INTERNAL_SERVICE_SECRET),
  model:createChatModel(config),now:()=>new Date(fixed),runTimeoutMs:config.AI_RUN_TIMEOUT_MS}),
  leaseDurationMs:config.AGENT_WORKER_LEASE_DURATION_MS,renewIntervalMs:config.AGENT_WORKER_RENEW_INTERVAL_MS,
  pollIntervalMs:config.AGENT_WORKER_POLL_INTERVAL_MS,recoveryBatchSize:config.AGENT_WORKER_RECOVERY_BATCH_SIZE,
  onEvent:(id,event)=>hub.publish(id,event),onError:()=>console.error('AUDIT_WORKER_FAILED')});
let closing;
const close=()=>closing??=(async()=>{await worker.stop();await app.close();await checkpointer.end();await tasks.close();await repository.close();})();
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
await worker.start();await app.listen({port:3100,host:'0.0.0.0'});
