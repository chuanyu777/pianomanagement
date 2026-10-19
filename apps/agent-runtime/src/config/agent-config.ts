import { z } from 'zod';

const AgentConfigSchema = z
  .object({
    AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    AGENT_WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
    AGENT_WORKER_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30_000),
    AGENT_WORKER_RENEW_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
    AGENT_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    AGENT_WORKER_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    AI_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    AI_PROVIDER: z.enum(['', 'deepseek']).default(''),
    AI_MODEL: z.enum(['', 'deepseek-chat', 'deepseek-reasoner']).default(''),
    AI_API_KEY: z.string().trim().default(''),
    AGENT_DATABASE_URL: z.string().min(1),
    CORE_INTERNAL_API_URL: z.url(),
    INTERNAL_SERVICE_SECRET: z.string().min(32),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    AI_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    AI_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
    AI_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(20).default(6),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(8_192).default(1_200),
    AI_TRACING_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  })
  .superRefine((value, context) => {
    if (value.AGENT_WORKER_RENEW_INTERVAL_MS >= value.AGENT_WORKER_LEASE_DURATION_MS) {
      context.addIssue({
        code: 'custom',
        path: ['AGENT_WORKER_RENEW_INTERVAL_MS'],
        message: 'Worker 续租间隔必须小于租约时长',
      });
    }
    if (!value.AI_ENABLED) return;
    if (!value.AI_PROVIDER)
      context.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: '启用 AI 时必须配置供应商' });
    if (!value.AI_MODEL)
      context.addIssue({ code: 'custom', path: ['AI_MODEL'], message: '启用 AI 时必须配置支持的模型' });
    if (!value.AI_API_KEY)
      context.addIssue({ code: 'custom', path: ['AI_API_KEY'], message: '启用 AI 时必须配置密钥' });
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function parseAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const result = AgentConfigSchema.safeParse(env);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Agent Runtime 配置无效 (${details})`);
}
