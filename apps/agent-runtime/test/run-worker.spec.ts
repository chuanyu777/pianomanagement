import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRunRecord,
  AssistantEvent,
  LeasedAgentRunRecord,
  PersistedAssistantEvent,
} from '../src/persistence/repository.js';
import { RunWorker, type RunWorkerRepository } from '../src/worker/run-worker.js';

function runRecord(status: AgentRunRecord['status'] = 'queued'): AgentRunRecord {
  return {
    runId: randomUUID(),
    threadId: randomUUID(),
    status,
    userMessage: '测试运行',
    capability: 'worker-capability',
  };
}

function leasedRun(): LeasedAgentRunRecord {
  return {
    ...runRecord('running'),
    leaseOwnerToken: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
    attemptCount: 1,
  };
}

function createRepository(run: LeasedAgentRunRecord): RunWorkerRepository & {
  requeued: number[];
  renewals: string[];
  terminalUpdates: Array<{ token: string | undefined; status: AgentRunRecord['status'] }>;
  appendedEvents: Array<{ token: string | undefined; event: AssistantEvent }>;
} {
  let claimed = false;
  const state = {
    requeued: [] as number[],
    renewals: [] as string[],
    terminalUpdates: [] as Array<{ token: string | undefined; status: AgentRunRecord['status'] }>,
    appendedEvents: [] as Array<{ token: string | undefined; event: AssistantEvent }>,
  };
  return {
    ...state,
    async requeueExpiredRunLeases(limit) {
      state.requeued.push(limit);
      return 0;
    },
    async claimNextRun() {
      if (claimed) return null;
      claimed = true;
      return run;
    },
    async renewRunLease(runId, ownerToken) {
      state.renewals.push(`${runId}:${ownerToken}`);
      return true;
    },
    async updateRunWithEvent(input, event) {
      state.terminalUpdates.push({ token: input.leaseOwnerToken, status: input.status });
      const persisted: PersistedAssistantEvent = {
        eventId: '1',
        event,
        createdAt: new Date().toISOString(),
      };
      return { run: { ...run, status: input.status }, event: persisted };
    },
    async appendEvent(runId, event, leaseOwnerToken) {
      state.appendedEvents.push({ token: leaseOwnerToken, event });
      return { eventId: '1', event, createdAt: new Date().toISOString() };
    },
    async appendMessage() {},
  };
}

describe('RunWorker', () => {
  it('reclaims expired leases on startup, renews during execution, and fences terminal writes', async () => {
    const run = leasedRun();
    const repository = createRepository(run);
    let finishExecution!: () => void;
    const execution = new Promise<void>((resolve) => { finishExecution = resolve; });
    const worker = new RunWorker({
      repository,
      ownerToken: randomUUID(),
      leaseDurationMs: 30,
      renewIntervalMs: 5,
      pollIntervalMs: 5,
      recoveryBatchSize: 20,
      execute: async (context) => {
        await context.appendEvent({ type: 'assistant.delta', text: '执行中' });
        await execution;
      },
    });

    await worker.start();
    await vi.waitFor(() => expect(repository.renewals.length).toBeGreaterThan(0));
    finishExecution();
    await worker.drain();
    await worker.stop();

    expect(repository.requeued).toEqual([20]);
    expect(repository.appendedEvents).toEqual([
      { token: run.leaseOwnerToken, event: { type: 'assistant.delta', text: '执行中' } },
    ]);
    expect(repository.terminalUpdates).toEqual([{ token: run.leaseOwnerToken, status: 'completed' }]);
  });

  it('stops writing as soon as lease renewal fails', async () => {
    const run = leasedRun();
    const repository = createRepository(run);
    repository.renewRunLease = async () => false;
    const worker = new RunWorker({
      repository,
      ownerToken: randomUUID(),
      leaseDurationMs: 30,
      renewIntervalMs: 5,
      pollIntervalMs: 5,
      recoveryBatchSize: 20,
      execute: async (context) => {
        await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
        await expect(context.appendEvent({ type: 'assistant.delta', text: '不应写入' })).rejects.toThrow(
          '运行租约已失效',
        );
      },
    });

    await worker.start();
    await worker.drain();
    await worker.stop();

    expect(repository.terminalUpdates).toEqual([]);
    expect(repository.appendedEvents).toEqual([]);
  });

  it('waits for the active run before completing graceful shutdown', async () => {
    const run = leasedRun();
    const repository = createRepository(run);
    let finishExecution!: () => void;
    const execution = new Promise<void>((resolve) => { finishExecution = resolve; });
    const worker = new RunWorker({
      repository,
      ownerToken: randomUUID(),
      leaseDurationMs: 30,
      renewIntervalMs: 5,
      pollIntervalMs: 5,
      recoveryBatchSize: 20,
      execute: async () => execution,
    });

    await worker.start();
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    finishExecution();
    await stopping;
    expect(repository.terminalUpdates).toEqual([{ token: run.leaseOwnerToken, status: 'completed' }]);
  });
});
