import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { createBusinessQueryGraph } from '../src/graph/business-query-graph.js';
import { createDialogueGraph } from '../src/graph/dialogue-graph.js';
import { deterministicIntent } from '../src/graph/dialogue-intent.js';

const summary = {
  businessDate: '2026-10-28',
  highlights: ['今日排课 4 节', '本月经营收入 1200.00 元'],
};

function buildQueryGraph(modelAnswer: string) {
  const model = { invoke: vi.fn().mockResolvedValue(new AIMessage(modelAnswer)) };
  const graph = createBusinessQueryGraph({
    checkpointer: new MemorySaver(),
    capability: 'request-capability',
    fetchDashboardSummary: vi.fn().mockResolvedValue(summary),
    model: model as never,
  });
  return { graph, model };
}

async function ask(graph: ReturnType<typeof buildQueryGraph>['graph'], userMessage: string, threadId: string) {
  return graph.invoke(
    { runId: 'e200271f-06a4-45e6-bdb8-6c59b843a1fa', threadId: 'a2b50d20-bd44-4f42-b7f0-148535470c75', userMessage },
    { configurable: { thread_id: threadId } },
  );
}

/**
 * Documents a known over-broad guard: ACTION_CLAIM_PATTERN treats the ordinary
 * business noun phrase「已完成」(a lesson status) as if the model were claiming to
 * have executed an operation, so a factually correct answer is thrown away.
 */
describe('answer guard precision', () => {
  it('keeps a factual answer that does not claim any operation', async () => {
    const { graph } = buildQueryGraph('今天安排了 4 节课。');
    const result = await ask(graph, '今天经营情况怎么样？', 'guard-plain-answer');
    expect(result.answer).toBe('今天安排了 4 节课。');
  });

  it('discards a correct answer only because it mentions the lesson status「已完成」', async () => {
    const truthful = '今天有 2 节课已完成，另有 2 节待上课。';
    expect(truthful).toContain('已完成');
    const { graph } = buildQueryGraph(truthful);

    const result = await ask(graph, '今天经营情况怎么样？', 'guard-false-positive');

    // The model stated a business fact, yet the answer is replaced by the template.
    expect(result.answer).not.toBe(truthful);
  });
});

/**
 * Documents that the deterministic intent rules are unreachable when no model is
 * configured, because the graph gates ALL understanding behind `input.understand`.
 */
describe('deterministic rules when no model is configured', () => {
  it('can recognise a standard query without any model', () => {
    const intent = deterministicIntent({
      businessDate: '2026-10-28',
      task: {},
      userMessage: '今天有哪些课',
    });
    expect(intent?.operation).toBe('lessons.read');
  });

  it('still refuses that same request when the graph runs without an intent interpreter', async () => {
    const graph = createDialogueGraph({
      capability: 'cap',
      tools: {} as Parameters<typeof createDialogueGraph>[0]['tools'],
    });

    const { result } = await graph.invoke({
      turn: { runId: crypto.randomUUID(), threadId: 'task', message: '今天有哪些课', previous: {} },
    });

    expect(result.answer).toContain('AI暂不可用');
  });
});
