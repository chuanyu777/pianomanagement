import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Command, isInterrupted } from '@langchain/langgraph';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createCheckpointer } from '../src/checkpoint/checkpointer.js';
import { createSpikeGraph } from '../src/graph/spike-graph.js';

const databaseUrl = process.env.AGENT_DATABASE_URL;
const test = databaseUrl ? it : it.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe('real PostgresSaver stage 0 integration', () => {
  test('sets up, interrupts, closes, restores in a new instance, and does not repeat the read tool', async () => {
    const schema = `stage0_${crypto.randomUUID().replaceAll('-', '')}`;
    const first = createCheckpointer(databaseUrl!, schema);
    const second = createCheckpointer(databaseUrl!, schema);
    const cleanup = new Pool({ connectionString: databaseUrl });
    const threadId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };
    const fetchSystemStatus = vi.fn().mockResolvedValue({
      status: 'available',
      businessTimezone: 'Asia/Shanghai',
      serverTime: '2026-10-16T00:00:00.000Z',
    });

    try {
      await first.setup();
      const paused = await createSpikeGraph({ checkpointer: first, fetchSystemStatus }).invoke(
        { runId, threadId, userMessage: '阶段 0 PostgresSaver 验证' },
        config,
      );
      expect(isInterrupted(paused)).toBe(true);
      expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
      await first.end();

      const restored = await createSpikeGraph({
        checkpointer: second,
        fetchSystemStatus: vi.fn().mockRejectedValue(new Error('只读工具被重复调用')),
      }).invoke(new Command({ resume: { approved: true } }), config);

      expect(restored.answer).toBe('技术验证已确认完成。');
      expect(fetchSystemStatus).toHaveBeenCalledTimes(1);
    } finally {
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await cleanup.end();
    }
  }, 30_000);
});

describe('PostgresSaver construction', () => {
  it('uses the official saver and keeps the configured schema isolated', () => {
    const saver = createCheckpointer('postgresql://unused', 'stage0_schema');
    expect(saver).toBeInstanceOf(PostgresSaver);
  });
});
