import { z } from 'zod';

const CoreConfigSchema = z.object({
  CORE_DATABASE_URL: z.string().min(1),
  CORE_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  AGENT_DATABASE_URL: z.string().min(1),
  AGENT_RUNTIME_URL: z.url(),
  CAPABILITY_SIGNING_PRIVATE_KEY_B64: z.string().min(1),
  INTERNAL_SERVICE_SECRET: z.string().min(32),
  JWT_SIGNING_SECRET: z.string().min(32),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AGENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  AGENT_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AGENT_STATUS_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
});

export type CoreConfig = z.infer<typeof CoreConfigSchema>;

export function parseCoreConfig(env: NodeJS.ProcessEnv): CoreConfig {
  return CoreConfigSchema.parse(env);
}
