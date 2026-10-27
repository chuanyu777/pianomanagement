import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphTools = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }));

vi.mock('../src/graph/dialogue-graph.js', () => ({
  createDialogueGraph: vi.fn(({ tools }: { tools: Record<string, unknown> }) => {
    graphTools.current = tools;
    return {
      invoke: async () => {
        const capability = 'capability';
        await (tools.readDirectory as (value: string) => unknown)(capability);
        await (tools.readArrearsAndFrozen as (value: string) => unknown)(capability);
        await (tools.readMonthlyConsumption as (value: string, query: { period: string }) => unknown)(capability, { period: '2026-10' });
        await (tools.readPeriodPreclose as (value: string, query: { period: string }) => unknown)(capability, { period: '2026-10' });
        return { result: { answer: 'ok', task: {}, workspace: {} } };
      },
    };
  }),
}));

import { createDialogueRunExecutor } from '../src/worker/dialogue-executor.js';

describe('DialogueRunExecutor Core read bindings', () => {
  beforeEach(() => { graphTools.current = undefined; });

  it('binds all four read client methods to the graph tools', async () => {
    const calls: unknown[][] = [];
    const reads = {
      readLessons() { return {}; },
      readAccount() { return {}; },
      readMonthlyReport() { return {}; },
      readAccountLedger() { return {}; },
      readMonthlyPayroll() { return {}; },
      invalidatePreview() { return {}; },
      readPreview() { return {}; },
      checkActionAccess() { return {}; },
      readDirectory(this: unknown, ...args: unknown[]) { calls.push(['directory', this === reads, ...args]); return {}; },
      readArrearsAndFrozen(this: unknown, ...args: unknown[]) { calls.push(['arrears', this === reads, ...args]); return {}; },
      readMonthlyConsumption(this: unknown, ...args: unknown[]) { calls.push(['consumption', this === reads, ...args]); return {}; },
      readPeriodPreclose(this: unknown, ...args: unknown[]) { calls.push(['preclose', this === reads, ...args]); return {}; },
    };
    const threadId = '2b7121d1-cd4c-4244-b9c3-0998faff0f17';
    const runId = '5ed31d97-2304-4d81-a124-73103854f2de';
    const capability = `e30.${Buffer.from(JSON.stringify({ sub: 'owner-1', role: 'OWNER', threadId, runId, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.sig`;
    const tasks = { withTask: async (_scope: unknown, work: (state: unknown) => Promise<unknown>) => work(undefined) };
    const executor = createDialogueRunExecutor({
      tasks: tasks as never,
      coreTools: {} as never,
      reads: reads as never,
      runTimeoutMs: 5_000,
    });
    const events: unknown[] = [];
    await executor({
      run: { capability, threadId, runId, userMessage: 'ignored' },
      appendEvent: async (event: unknown) => { events.push(event); },
      appendMessage: async () => undefined,
      signal: new AbortController().signal,
    } as never);

    expect(graphTools.current).toBeDefined();
    expect(calls).toEqual([
      ['directory', true, 'capability'],
      ['arrears', true, 'capability'],
      ['consumption', true, 'capability', { period: '2026-10' }],
      ['preclose', true, 'capability', { period: '2026-10' }],
    ]);
    expect(events).toHaveLength(4);
  });
});
