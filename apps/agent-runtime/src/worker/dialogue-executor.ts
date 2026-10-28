import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createDialogueGraph } from '../graph/dialogue-graph.js';
import type { UnderstandIntent } from '../graph/dialogue-intent.js';
import { createIntentParser, type IntentParser } from '../graph/intent-parser.js';
import { createModelMultiStepInterpreter, type UnderstandMultiStep } from '../graph/dialogue-multi-step.js';
import type { DialogueTaskStore } from '../persistence/task-store.js';
import { trustedCapabilityBinding } from '../persistence/trusted-capability.js';
import type { CoreToolClient } from '../tools/core-tool-client.js';
import type { DialogueReadClient } from '../tools/dialogue-tools.js';
import type { RunExecutionContext } from './run-worker.js';

export function createDialogueRunExecutor(input: {
  tasks: DialogueTaskStore;
  coreTools: CoreToolClient;
  reads: DialogueReadClient;
  model?: BaseChatModel;
  understand?: UnderstandIntent;
  intentParser?: IntentParser;
  understandMultiStep?: UnderstandMultiStep;
  now?: () => Date;
  runTimeoutMs: number;
}) {
  // The parser is the single entry point for understanding. Legacy rules are
  // shadow-only by default so their accuracy can be compared before removal,
  // and can be re-enabled as an emergency fallback without a code change.
  const intentParser = input.intentParser ?? (input.understand
    ? undefined
    : createIntentParser(input.model, {
        shadowRules: process.env['AGENT_INTENT_SHADOW_RULES'] !== 'false',
        emergencyRuleFallback: process.env['AGENT_INTENT_RULE_FALLBACK'] === 'true',
      }));
  const understandMultiStep = input.understandMultiStep ?? (input.model ? createModelMultiStepInterpreter(input.model) : undefined);
  return async (context: RunExecutionContext): Promise<void> => {
    const capability = context.run.capability;
    if (!capability) throw new Error('任务缺少访问凭据');
    const binding = trustedCapabilityBinding(capability, { threadId: context.run.threadId, runId: context.run.runId });
    await context.appendEvent({ type: 'run.started', runId: context.run.runId, threadId: context.run.threadId });
    await context.appendEvent({ type: 'progress.changed', label: '正在理解并核对业务' });
    const result = await input.tasks.withTask({ threadId: context.run.threadId, runId: context.run.runId, actorKey: binding.actorKey, ...(context.leaseOwnerToken ? { leaseOwnerToken: context.leaseOwnerToken } : {}) }, async (previous) => {
      const tools = Object.assign(Object.create(input.coreTools) as CoreToolClient, {
        readLessons: input.reads.readLessons.bind(input.reads), readAccount: input.reads.readAccount.bind(input.reads), invalidatePreview: input.reads.invalidatePreview.bind(input.reads),
        readPreview: input.reads.readPreview.bind(input.reads),
        checkActionAccess: input.reads.checkActionAccess.bind(input.reads),
        readMonthlyReport: input.reads.readMonthlyReport.bind(input.reads),
        readAccountLedger: input.reads.readAccountLedger.bind(input.reads),
        readMonthlyPayroll: input.reads.readMonthlyPayroll.bind(input.reads),
        readDirectory: input.reads.readDirectory.bind(input.reads),
        readArrearsAndFrozen: input.reads.readArrearsAndFrozen.bind(input.reads),
        readMonthlyConsumption: input.reads.readMonthlyConsumption.bind(input.reads),
        readPeriodPreclose: input.reads.readPeriodPreclose.bind(input.reads),
      });
      const graph = createDialogueGraph({
        tools,
        capability,
        ...(input.understand ? { understand: input.understand } : {}),
        ...(intentParser ? { intentParser } : {}),
        ...(understandMultiStep ? { understandMultiStep } : {}),
        ...(input.now ? { now: input.now } : {}),
      });
      const { result } = await graph.invoke({ turn: { runId: context.run.runId, threadId: context.run.threadId, message: context.run.userMessage, previous } }, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(input.runTimeoutMs)]) });
      return { state: result.task, result };
    });
    await context.appendMessage({ threadId: context.run.threadId, role: 'assistant', content: result.answer });
    await context.appendEvent({ type: 'workspace.replace', document: result.workspace });
    await context.appendEvent({ type: 'assistant.delta', text: result.answer });
  };
}
