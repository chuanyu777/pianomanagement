import {
  AssistantRunSchema,
  type AssistantEvent,
} from '@piano/assistant-protocol';
import type {
  AgentRunRecord,
  AgentRuntimeRepository,
  AppendMessageInput,
  CreateRunInput,
  PersistedAssistantEvent,
  UpdateRunInput,
} from '../src/persistence/repository.js';

export function createTestRepository(): AgentRuntimeRepository {
  const runs = new Map<string, AgentRunRecord>();
  const events = new Map<string, PersistedAssistantEvent[]>();
  let nextEventId = 1;

  return {
    async createRun(input: CreateRunInput) {
      const existing = [...runs.values()].find(
        (run) =>
          run.runId === input.runId ||
          (input.clientRequestId !== undefined && run.threadId === input.threadId && run.clientRequestId === input.clientRequestId),
      );
      if (existing) return { run: existing, created: false };
      const run = {
        ...AssistantRunSchema.parse({ runId: input.runId, threadId: input.threadId, status: 'running' }),
        userMessage: input.userMessage,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      };
      runs.set(run.runId, run);
      events.set(run.runId, []);
      return { run, created: true };
    },
    async findRun(runId) {
      return runs.get(runId) ?? null;
    },
    async claimRunForResume(runId) {
      const current = runs.get(runId);
      if (!current || current.status !== 'waiting_for_input') return null;
      const claimed = { ...current, status: 'running' as const };
      runs.set(runId, claimed);
      return claimed;
    },
    async updateRun(input: UpdateRunInput) {
      const current = runs.get(input.runId);
      if (!current) throw new Error('运行不存在');
      const updated = { ...current, status: input.status };
      runs.set(input.runId, updated);
      return updated;
    },
    async appendMessage(_input: AppendMessageInput) {},
    async appendEvent(runId: string, event: AssistantEvent) {
      const persisted = {
        eventId: String(nextEventId++),
        event,
        createdAt: new Date().toISOString(),
      };
      events.get(runId)?.push(persisted);
      return persisted;
    },
    async listEvents(runId, afterEventId) {
      const after = afterEventId ? Number(afterEventId) : 0;
      return (events.get(runId) ?? []).filter((event) => Number(event.eventId) > after);
    },
    async close() {},
  };
}
