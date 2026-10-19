import {
  AssistantRunSchema,
  type AssistantEvent,
} from '@piano/assistant-protocol';
import type {
  AgentRunRecord,
  AgentRuntimeRepository,
  AppendMessageInput,
  CreateRunInput,
  LeasedAgentRunRecord,
  PersistedAssistantEvent,
  UpdateRunInput,
} from '../src/persistence/repository.js';

export function createTestRepository(): AgentRuntimeRepository {
  const runs = new Map<string, AgentRunRecord>();
  const events = new Map<string, PersistedAssistantEvent[]>();
  const leases = new Map<string, { ownerToken: string; expiresAt: number; attemptCount: number }>();
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
        ...AssistantRunSchema.parse({ runId: input.runId, threadId: input.threadId, status: 'queued' }),
        userMessage: input.userMessage,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.capability ? { capability: input.capability } : {}),
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
      if (input.leaseOwnerToken) assertLease(input.runId, input.leaseOwnerToken);
      const updated = { ...current, status: input.status };
      runs.set(input.runId, updated);
      if (input.status !== 'running') leases.delete(input.runId);
      return updated;
    },
    async updateRunWithEvent(input: UpdateRunInput, event: AssistantEvent) {
      const current = runs.get(input.runId);
      if (!current) throw new Error('运行不存在');
      if (input.leaseOwnerToken) assertLease(input.runId, input.leaseOwnerToken);
      const updated = { ...current, status: input.status };
      const persisted = {
        eventId: String(nextEventId++),
        event,
        createdAt: new Date().toISOString(),
      };
      runs.set(input.runId, updated);
      if (input.status !== 'running') leases.delete(input.runId);
      events.get(input.runId)?.push(persisted);
      return { run: updated, event: persisted };
    },
    async appendMessage(_input: AppendMessageInput) {},
    async appendEvent(runId: string, event: AssistantEvent, leaseOwnerToken?: string) {
      if (leaseOwnerToken) assertLease(runId, leaseOwnerToken);
      const persisted = {
        eventId: String(nextEventId++),
        event,
        createdAt: new Date().toISOString(),
      };
      events.get(runId)?.push(persisted);
      return persisted;
    },
    async claimNextRun(ownerToken: string, leaseDurationMs: number): Promise<LeasedAgentRunRecord | null> {
      const now = Date.now();
      const candidate = [...runs.values()].find((run) => {
        const lease = leases.get(run.runId);
        return run.status === 'queued' || (run.status === 'running' && lease !== undefined && lease.expiresAt <= now);
      });
      if (!candidate) return null;
      const previous = leases.get(candidate.runId);
      const lease = { ownerToken, expiresAt: now + leaseDurationMs, attemptCount: (previous?.attemptCount ?? 0) + 1 };
      leases.set(candidate.runId, lease);
      const updated = { ...candidate, status: 'running' as const };
      runs.set(candidate.runId, updated);
      return {
        ...updated,
        leaseOwnerToken: ownerToken,
        leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
        attemptCount: lease.attemptCount,
      };
    },
    async renewRunLease(runId: string, ownerToken: string, leaseDurationMs: number) {
      const lease = leases.get(runId);
      if (!lease || lease.ownerToken !== ownerToken || lease.expiresAt <= Date.now()) return false;
      lease.expiresAt = Date.now() + leaseDurationMs;
      return true;
    },
    async releaseRunLease(runId: string, ownerToken: string) {
      assertLease(runId, ownerToken);
      const current = runs.get(runId);
      if (!current) return false;
      runs.set(runId, { ...current, status: 'queued' });
      leases.delete(runId);
      return true;
    },
    async requeueExpiredRunLeases(limit: number) {
      let count = 0;
      for (const [runId, lease] of leases) {
        const current = runs.get(runId);
        if (count >= limit) break;
        if (current?.status === 'running' && lease.expiresAt <= Date.now()) {
          runs.set(runId, { ...current, status: 'queued' });
          leases.delete(runId);
          count += 1;
        }
      }
      return count;
    },
    async listEvents(runId, afterEventId) {
      const after = afterEventId ? Number(afterEventId) : 0;
      return (events.get(runId) ?? []).filter((event) => Number(event.eventId) > after);
    },
    async close() {},
  };

  function assertLease(runId: string, ownerToken: string): void {
    const lease = leases.get(runId);
    if (!lease || lease.ownerToken !== ownerToken || lease.expiresAt <= Date.now()) {
      throw new Error('运行不存在或租约已失效');
    }
  }
}
