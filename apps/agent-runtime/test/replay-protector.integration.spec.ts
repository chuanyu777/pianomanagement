import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PostgresInternalRequestReplayStore,
} from '../src/persistence/replay-protector.js';

const databaseUrl = process.env['AGENT_DATABASE_URL'];
const test = databaseUrl ? it : it.skip;

describe('shared internal request nonce replay store', () => {
  const stores: PostgresInternalRequestReplayStore[] = [];
  const cleanupPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
  const nonces: string[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
    if (cleanupPool && nonces.length > 0) {
      await cleanupPool.query(
        'DELETE FROM agent_runtime.internal_request_nonces WHERE nonce = ANY($1::uuid[])',
        [nonces.splice(0)],
      );
    }
  });

  test('atomically allows one of two instances and rejects the other', async () => {
    const nonce = crypto.randomUUID();
    nonces.push(nonce);
    const first = new PostgresInternalRequestReplayStore(databaseUrl!);
    const second = new PostgresInternalRequestReplayStore(databaseUrl!);
    stores.push(first, second);

    const results = await Promise.all([first.consume(nonce), second.consume(nonce)]);
    expect(results.sort()).toEqual([false, true]);
  }, 30_000);

  test('rejects the nonce after a store instance is restarted', async () => {
    const nonce = crypto.randomUUID();
    nonces.push(nonce);
    const first = new PostgresInternalRequestReplayStore(databaseUrl!);
    stores.push(first);
    await expect(first.consume(nonce)).resolves.toBe(true);
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const restarted = new PostgresInternalRequestReplayStore(databaseUrl!);
    stores.push(restarted);
    await expect(restarted.consume(nonce)).resolves.toBe(false);
  }, 30_000);

  test('permits reuse only after the database TTL has expired', async () => {
    const nonce = crypto.randomUUID();
    nonces.push(nonce);
    const store = new PostgresInternalRequestReplayStore(databaseUrl!);
    stores.push(store);
    await expect(store.consume(nonce, 1)).resolves.toBe(true);
    await cleanupPool!.query(
      `UPDATE agent_runtime.internal_request_nonces
          SET expires_at = now() - interval '1 second'
        WHERE nonce = $1`,
      [nonce],
    );
    await expect(store.consume(nonce, 600)).resolves.toBe(true);
    await expect(store.consume(nonce, 600)).resolves.toBe(false);
  }, 30_000);
});
