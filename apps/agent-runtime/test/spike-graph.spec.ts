import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph';
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
});
