import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export const INTERNAL_REQUEST_NONCE_RETENTION_SECONDS = 600;

export interface InternalRequestReplayStore {
  consume(nonce: string, retentionSeconds?: number): Promise<boolean>;
}

/**
 * Persistent replay store for Core's own database. Core and Agent each keep
 * their inbound nonce table in their own database; neither service reads the
 * other's database.
 */
@Injectable()
export class PostgresInternalRequestReplayStore
  implements InternalRequestReplayStore, OnModuleDestroy
{
  readonly #pool: Pool;
  #nextCleanupAt = 0;

  constructor() {
    const connectionString = process.env['CORE_DATABASE_URL'];
    if (!connectionString) {
      throw new Error('缺少 CORE_DATABASE_URL：Core 无法启用 nonce 防重放存储。');
    }
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
      `INSERT INTO "InternalRequestNonce" ("nonce", "expiresAt")
       VALUES ($1::uuid, now() + ($2::double precision * interval '1 second'))
       ON CONFLICT ("nonce") DO UPDATE
         SET "expiresAt" = EXCLUDED."expiresAt"
       WHERE "InternalRequestNonce"."expiresAt" <= now()
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
      .query('DELETE FROM "InternalRequestNonce" WHERE "expiresAt" <= now()')
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
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
}
