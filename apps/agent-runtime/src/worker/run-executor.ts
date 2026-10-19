import { isInterrupted, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunExecutionContext } from './run-worker.js';
import { createBusinessQueryGraph } from '../graph/business-query-graph.js';
import type { CoreToolClient } from '../tools/core-tool-client.js';

function checkpointThreadId(threadId: string, runId: string): string {
  return `${threadId}:${runId}`;
}

export function createBusinessRunExecutor(input: {
  checkpointer: BaseCheckpointSaver;
  coreTools: CoreToolClient;
  model?: BaseChatModel;
  runTimeoutMs: number;
}): (context: RunExecutionContext) => Promise<void> {
  return async (context) => {
    const capability = context.run.capability;
    if (!capability) throw new Error('RUN_CAPABILITY_MISSING');
    const graph = createBusinessQueryGraph({
      checkpointer: input.checkpointer,
      ...(input.model ? { model: input.model } : {}),
      capability,
      fetchDashboardSummary: (value) => input.coreTools.getDashboardSummary(value),
      findCourseAccountCandidates: (value, query) => input.coreTools.getCourseAccountCandidates(value, query),
      findStudentCandidates: (value, query) => input.coreTools.getStudentCandidates(value, query),
      findTeacherCandidates: (value, query) => input.coreTools.getTeacherCandidates(value, query),
      findLessonCandidates: (value, query) => input.coreTools.getLessonCandidates(value, query),
      findPayrollCandidates: (value, query) => input.coreTools.getPayrollCandidates(value, query),
      createSingleLessonPreview: (value, request) => input.coreTools.createSingleLessonPreview(value, request),
      createBatchLessonPreview: (value, request) => input.coreTools.createBatchLessonPreview(value, request),
      createFinalRefundPreview: (value, request) => input.coreTools.createFinalRefundPreview(value, request),
      createPaymentPreview: (value, request) => input.coreTools.createPaymentPreview(value, request),
      createGiftPreview: (value, request) => input.coreTools.createGiftPreview(value, request),
      createActionPreview: (value, request) => input.coreTools.createStructuredActionPreview(value, request),
    });
    await context.appendEvent({
      type: 'run.started',
      runId: context.run.runId,
      threadId: context.run.threadId,
    });
    const result = await graph.invoke(
      { runId: context.run.runId, threadId: context.run.threadId, userMessage: context.run.userMessage },
      {
        configurable: { thread_id: checkpointThreadId(context.run.threadId, context.run.runId) },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(input.runTimeoutMs)]),
      },
    );
    if (isInterrupted(result) || typeof result.answer !== 'string' || !result.workspace) {
      throw new Error('READ_ONLY_GRAPH_DID_NOT_RETURN_RESULT');
    }
    await context.appendMessage({
      threadId: context.run.threadId,
      role: 'assistant',
      content: result.answer,
    });
    await context.appendEvent({ type: 'workspace.replace', document: result.workspace });
    await context.appendEvent({ type: 'assistant.delta', text: result.answer });
  };
}
