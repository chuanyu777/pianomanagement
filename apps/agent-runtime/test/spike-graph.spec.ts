import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createSpikeGraph } from '../src/graph/spike-graph.js';

describe('stage 0 spike graph', () => {
  it('persists an interrupt and resumes without repeating the read tool', async () => {
    const checkpointer = new MemorySaver();
    const fetchSystemStatus = vi.fn().mockResolvedValue({
      status: 'available',
      businessTimezone: 'Asia/Shanghai',
      serverTime: '2026-10-16T00:00:00.000Z',
    });
    const graph = createSpikeGraph({ checkpointer, fetchSystemStatus });
    const config = { configurable: { thread_id: 'a2b50d20-bd44-4f42-b7f0-148535470c75' } };

    const paused = await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75',
        userMessage: '执行阶段 0 技术验证',
      },
      config,
    );
    expect(isInterrupted(paused)).toBe(true);

    const completed = await graph.invoke(new Command({ resume: { approved: true } }), config);
    expect(completed.answer).toBe('技术验证已确认完成。');
    expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('uses the injected mock model only after approval and returns its response', async () => {
    const model = { invoke: vi.fn().mockResolvedValue(new AIMessage('mock assistant reply')) };
    const graph = createSpikeGraph({
      checkpointer: new MemorySaver(),
      fetchSystemStatus: vi.fn().mockResolvedValue({
        status: 'available',
        businessTimezone: 'Asia/Shanghai',
        serverTime: '2026-10-16T00:00:00.000Z',
      }),
      model: model as never,
    });
    const config = { configurable: { thread_id: 'model-test-thread' } };
    await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'model-test-thread',
        userMessage: '请简要回应',
      },
      config,
    );
    expect(model.invoke).not.toHaveBeenCalled();

    const completed = await graph.invoke(new Command({ resume: { approved: true } }), config);
    expect(completed.answer).toBe('mock assistant reply');
    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it('does not expose provider errors when a model request fails', async () => {
    const model = { invoke: vi.fn().mockRejectedValue(new Error('sensitive provider detail')) };
    const graph = createSpikeGraph({
      checkpointer: new MemorySaver(),
      fetchSystemStatus: vi.fn().mockResolvedValue({
        status: 'available',
        businessTimezone: 'Asia/Shanghai',
        serverTime: '2026-10-16T00:00:00.000Z',
      }),
      model: model as never,
    });
    const config = { configurable: { thread_id: 'model-failure-thread' } };
    await graph.invoke(
      {
        runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa',
        threadId: 'model-failure-thread',
        userMessage: '请简要回应',
      },
      config,
    );

    let thrown: unknown;
    try {
      await graph.invoke(new Command({ resume: { approved: true } }), config);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('AI_MODEL_REQUEST_FAILED');
    expect(String(thrown)).not.toContain('sensitive provider detail');
  });
});
