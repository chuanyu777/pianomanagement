import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../config/agent-config.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export type ModelFactoryOptions = {
  fetch?: typeof fetch;
};

/** Creates the only supported chat model. The optional fetch is for isolated tests. */
export function createChatModel(
  config: AgentConfig,
  options: ModelFactoryOptions = {},
): ChatOpenAI | undefined {
  if (!config.AI_ENABLED) return undefined;

  if (
    config.AI_PROVIDER !== 'deepseek' ||
    (config.AI_MODEL !== 'deepseek-chat' && config.AI_MODEL !== 'deepseek-reasoner') ||
    !config.AI_API_KEY
  ) {
    throw new Error('AI 模型配置无效');
  }

  return new ChatOpenAI({
    model: config.AI_MODEL,
    apiKey: config.AI_API_KEY,
    maxTokens: config.AI_MAX_OUTPUT_TOKENS,
    timeout: config.AI_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    configuration: {
      baseURL: DEEPSEEK_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
}
