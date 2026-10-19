import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresInternalRequestReplayStore as CoreReplayStore } from '../src/common/internal-auth/replay-protector.js';

const databaseUrl = process.env['CORE_DATABASE_URL'];
const test = databaseUrl ? it : it.skip;

describe('Core/Agent shared nonce store compatibility', () => {
  const stores: CoreReplayStore[] = [];
  const cleanupPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
  const nonces: string[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.onModuleDestroy();
    }
    if (cleanupPool && nonces.length > 0) {
      await cleanupPool.query(
        'DELETE FROM "InternalRequestNonce" WHERE "nonce" = ANY($1::uuid[])',
        [nonces.splice(0)],
      );
    }
    await cleanupPool?.end();
  });

  test('Core atomically rejects a replayed nonce in its own database', async () => {
    const nonce = crypto.randomUUID();
    nonces.push(nonce);
    const core = new CoreReplayStore();
    const secondCore = new CoreReplayStore();
    stores.push(core, secondCore);

    const results = await Promise.all([core.consume(nonce), secondCore.consume(nonce)]);
    expect(results.sort()).toEqual([false, true]);
  }, 30_000);
});
