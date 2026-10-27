import { createHash } from 'node:crypto';
import { z } from 'zod';

// Only call after verifying Core's HMAC, which binds this exact capability.
// This is scope binding, not a substitute for Core's EdDSA/permission checks.
const BindingSchema = z.object({ sub: z.string().min(1), role: z.string().min(1), teacherId: z.string().optional(), threadId: z.string().uuid(), runId: z.string().uuid(), exp: z.number().int() });
export function trustedCapabilityBinding(token: string, expected: { threadId?: string; runId?: string } = {}): { actorKey: string; threadId: string; runId: string } {
  try {
    const part = token.split('.')[1];
    if (!part) throw new Error();
    const claims = BindingSchema.parse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    if (claims.exp * 1000 <= Date.now() || (expected.threadId && expected.threadId !== claims.threadId) || (expected.runId && expected.runId !== claims.runId)) throw new Error();
    return { actorKey: createHash('sha256').update(JSON.stringify([claims.sub, claims.role, claims.teacherId ?? null])).digest('hex'), threadId: claims.threadId, runId: claims.runId };
  } catch { throw new Error('任务身份或作用域无效'); }
}
