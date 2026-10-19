import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '../src/config/agent-config.js';

const baseEnv: NodeJS.ProcessEnv = {
  AGENT_DATABASE_URL: 'postgresql://unused',
  CORE_INTERNAL_API_URL: 'http://core.test',
  INTERNAL_SERVICE_SECRET: 'unit-test-secret-012345678901234567890123',
};

describe('Agent configuration for AI provider', () => {
  it('defaults AI off and does not require model credentials', () => {
    const config = parseAgentConfig(baseEnv);
    expect(config.AI_ENABLED).toBe(false);
    expect(config.AI_PROVIDER).toBe('');
    expect(config.AI_MODEL).toBe('');
    expect(config.AI_API_KEY).toBe('');
    expect(config.AGENT_WORKER_ENABLED).toBe(true);
    expect(config.AGENT_WORKER_LEASE_DURATION_MS).toBe(30_000);
    expect(config.AGENT_WORKER_RENEW_INTERVAL_MS).toBe(10_000);
  });

  it('requires the worker to renew before its lease expires', () => {
    expect(() => parseAgentConfig({
      ...baseEnv,
      AGENT_WORKER_LEASE_DURATION_MS: '1000',
      AGENT_WORKER_RENEW_INTERVAL_MS: '1000',
    })).toThrow(/续租间隔/);
  });

  it('requires the supported provider, model, and a non-empty key when AI is enabled', () => {
    expect(() => parseAgentConfig({ ...baseEnv, AI_ENABLED: 'true' })).toThrow(/AI_PROVIDER/);
    expect(() =>
      parseAgentConfig({ ...baseEnv, AI_ENABLED: 'true', AI_PROVIDER: 'deepseek' }),
    ).toThrow(/AI_MODEL/);
    expect(() =>
      parseAgentConfig({
        ...baseEnv,
        AI_ENABLED: 'true',
        AI_PROVIDER: 'deepseek',
        AI_MODEL: 'deepseek-chat',
      }),
    ).toThrow(/AI_API_KEY/);
  });

  it('rejects unsupported provider and model values without echoing a supplied key', () => {
    const sentinel = 'do-not-echo-secret';
    expect(() =>
      parseAgentConfig({
        ...baseEnv,
        AI_ENABLED: 'true',
        AI_PROVIDER: 'other-provider',
        AI_MODEL: 'unsupported-model',
        AI_API_KEY: sentinel,
      }),
    ).toThrow(/AI_PROVIDER.*AI_MODEL/);
    try {
      parseAgentConfig({
        ...baseEnv,
        AI_ENABLED: 'true',
        AI_PROVIDER: 'other-provider',
        AI_MODEL: 'unsupported-model',
        AI_API_KEY: sentinel,
      });
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it('accepts the configured DeepSeek models and trims the key', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner']) {
      const config = parseAgentConfig({
        ...baseEnv,
        AI_ENABLED: 'true',
        AI_PROVIDER: 'deepseek',
        AI_MODEL: model,
        AI_API_KEY: '  test-key  ',
      });
      expect(config.AI_MODEL).toBe(model);
      expect(config.AI_API_KEY).toBe('test-key');
    }
  });
});
