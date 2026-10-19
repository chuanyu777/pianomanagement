import { Pool } from 'pg';

export const INTERNAL_REQUEST_NONCE_RETENTION_SECONDS = 600;

export interface InternalRequestReplayStore {
  consume(nonce: string, retentionSeconds?: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Shared with Core through Agent PostgreSQL; the atomic insert is the lock. */
export class PostgresInternalRequestReplayStore implements InternalRequestReplayStore {
  readonly #pool: Pool;
  #nextCleanupAt = 0;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 4 });
  }

  async consume(
    nonce: string,
    retentionSeconds = INTERNAL_REQUEST_NONCE_RETENTION_SECONDS,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1 || retentionSeconds > 86_400) {
      throw new Error('nonce 保留时间必须是 1 到 86400 秒的整数');
    }
    const result = await this.#pool.query(
      `INSERT INTO agent_runtime.internal_request_nonces (nonce, expires_at)
       VALUES ($1::uuid, now() + ($2::double precision * interval '1 second'))
       ON CONFLICT (nonce) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
       WHERE agent_runtime.internal_request_nonces.expires_at <= now()
       RETURNING nonce`,
      [nonce, retentionSeconds],
    );
    this.#scheduleCleanup();
    return result.rowCount === 1;
  }

  #scheduleCleanup(): void {
    const now = Date.now();
    if (now < this.#nextCleanupAt) return;
    this.#nextCleanupAt = now + 60_000;
    void this.#pool
      .query('DELETE FROM agent_runtime.internal_request_nonces WHERE expires_at <= now()')
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export class InMemoryInternalRequestReplayStore implements InternalRequestReplayStore {
  readonly #seen = new Map<string, number>();

  async consume(
    nonce: string,
    retentionSeconds = INTERNAL_REQUEST_NONCE_RETENTION_SECONDS,
  ): Promise<boolean> {
    const now = Date.now();
    for (const [seenNonce, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(seenNonce);
    }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, now + retentionSeconds * 1_000);
    return true;
  }

  async close(): Promise<void> {}
}
