import { z } from 'zod';

const AuthConfigSchema = z.object({
  JWT_SIGNING_SECRET: z.string().min(32),
  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  return AuthConfigSchema.parse(env);
}
