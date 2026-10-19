import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/config/agent-config.js';
import { createChatModel } from '../src/llm/model-factory.js';

const config: AgentConfig = {
  AGENT_PORT: 3100,
  AI_ENABLED: true,
  AI_PROVIDER: 'deepseek',
  AI_MODEL: 'deepseek-chat',
  AI_API_KEY: 'unit-test-only-key',
  AGENT_DATABASE_URL: 'postgresql://unused',
  CORE_INTERNAL_API_URL: 'http://core.test',
  INTERNAL_SERVICE_SECRET: 'unit-test-secret-012345678901234567890123',
  AI_REQUEST_TIMEOUT_MS: 1_000,
  AI_RUN_TIMEOUT_MS: 5_000,
  AI_MAX_STEPS: 8,
  AI_MAX_TOOL_CALLS: 6,
  AI_MAX_OUTPUT_TOKENS: 128,
  AI_TRACING_ENABLED: false,
};

describe('DeepSeek model factory', () => {
  it('does not construct a model while AI is disabled', () => {
    expect(createChatModel({ ...config, AI_ENABLED: false })).toBeUndefined();
  });

  it('calls only the mocked OpenAI-compatible endpoint and parses the response', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-chat',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'mock response' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const model = createChatModel(config, { fetch: mockFetch });
    if (!model) throw new Error('configured model should be created');

    const response = await model.invoke('health probe');

    expect(response.content).toBe('mock response');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, request] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'health probe' }],
    });
    expect(String(request?.body)).not.toContain(config.AI_API_KEY);
    expect(JSON.stringify(request?.headers)).not.toContain(config.AI_API_KEY);
  });

  it('fails closed if an enabled config bypasses startup validation', () => {
    expect(() =>
      createChatModel({ ...config, AI_PROVIDER: 'unsupported' as AgentConfig['AI_PROVIDER'] }),
    ).toThrow('AI 模型配置无效');
  });
});
