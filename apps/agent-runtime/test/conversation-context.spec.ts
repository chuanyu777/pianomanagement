import { describe, expect, it, vi } from 'vitest';
import { compactConversation } from '../src/graph/conversation-context.js';

describe('长会话上下文', () => {
  it('短会话完整保留，不调用模型', async () => {
    const invoke = vi.fn();
    const history = [{role:'user' as const, content:'学生叫张小鱼'}, {role:'assistant' as const, content:'好的'}];
    expect(await compactConversation({invoke} as never, history)).toEqual(history);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('长会话由模型总结早期对话，保留近期原文和更正', async () => {
    const invoke = vi.fn().mockResolvedValue({content:'早期用户提到学生张小鱼，后来更正为张小雨。'});
    const history = Array.from({length:30}, (_, index) => ({role:'user' as const,content:index === 0 ? `学生张小鱼，${'甲'.repeat(1000)}` : `第${index}轮 ${'乙'.repeat(1000)}`}));
    const result = await compactConversation({invoke} as never, history);
    expect(invoke).toHaveBeenCalled();
    expect(JSON.stringify(invoke.mock.calls)).toContain('学生张小鱼');
    expect(JSON.stringify(result)).toContain('张小雨');
    expect(result.at(-1)).toEqual(history.at(-1));
    expect(history).toHaveLength(30);
  });
  it('总结失败时明确失败，不能悄悄丢弃历史', async () => {
    const history = Array.from({length:30}, () => ({role:'user' as const,content:'甲'.repeat(1000)}));
    await expect(compactConversation({invoke:vi.fn().mockRejectedValue(new Error('offline'))} as never,history)).rejects.toThrow();
  });
});
