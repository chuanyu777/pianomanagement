import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresDialogueTaskStore, TaskAccessError } from '../src/persistence/task-store.js';

const databaseUrl = process.env['AGENT_DATABASE_URL'];
const integration = databaseUrl ? it : it.skip;

describe('PostgresDialogueTaskStore', () => {
  const stores: PostgresDialogueTaskStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('exposes the durable task-store API and a public-safe access error', () => {
    const store = new PostgresDialogueTaskStore('postgresql://unused');
    stores.push(store);

    expect(store).toHaveProperty('withTask');
    expect(store).toHaveProperty('close');
    const error = new TaskAccessError();
    expect(error.name).toBe('TaskAccessError');
    expect(error.message).toBe('任务访问范围不匹配');
    expect(error.message).not.toContain('actor');
  });

  integration('persists state and binds a thread to the first actor', async () => {
    const ids = await createRun(databaseUrl!, { status: 'queued' });
    const first = new PostgresDialogueTaskStore(databaseUrl!);
    const second = new PostgresDialogueTaskStore(databaseUrl!);
    stores.push(first, second);

    try {
      await expect(
        first.withTask(
          { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1' },
          async (state) => ({ state: { ...(state as object), lastRunId: ids.runId }, result: 'saved' }),
        ),
      ).resolves.toBe('saved');

      await expect(
        second.withTask(
          { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1' },
          async (state) => ({ state, result: state }),
        ),
      ).resolves.toEqual({ lastRunId: ids.runId });

      let called = false;
      await expect(
        second.withTask(
          { threadId: ids.threadId, runId: ids.runId, actorKey: 'teacher:2' },
          async (state) => {
            called = true;
            return { state, result: null };
          },
        ),
      ).rejects.toBeInstanceOf(TaskAccessError);
      expect(called).toBe(false);
    } finally {
      await cleanupRun(databaseUrl!, ids);
    }
  }, 30_000);

  integration('serializes callbacks for one thread while allowing a lease update during work', async () => {
    const leaseOwner = crypto.randomUUID();
    const ids = await createRun(databaseUrl!, {
      status: 'running',
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const store = new PostgresDialogueTaskStore(databaseUrl!);
    const control = new Pool({ connectionString: databaseUrl });
    stores.push(store);
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let secondStarted = false;

    try {
      const first = store.withTask(
        { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1', leaseOwnerToken: leaseOwner },
        async () => {
          firstStarted = true;
          await firstReleased;
          return { state: { step: 1 }, result: 'first' };
        },
      );
      await expect
        .poll(() => firstStarted)
        .toBe(true);

      const second = store.withTask(
        { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1', leaseOwnerToken: leaseOwner },
        async (state) => {
          secondStarted = true;
          return { state: { ...(state as object), step: 2 }, result: 'second' };
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondStarted).toBe(false);

      await expect(
        control.query(
          `UPDATE agent_runtime.agent_runs
              SET lease_expires_at = now() + interval '1 minute'
            WHERE id = $1 AND lease_owner_token = $2::uuid`,
          [ids.runId, leaseOwner],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      releaseFirst();
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
    } finally {
      releaseFirst();
      await control.end();
      await cleanupRun(databaseUrl!, ids);
    }
  }, 30_000);

  integration('rejects a lease-fenced save after ownership changes and does not expose stale state', async () => {
    const firstOwner = crypto.randomUUID();
    const secondOwner = crypto.randomUUID();
    const ids = await createRun(databaseUrl!, {
      status: 'running',
      leaseOwner: firstOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const store = new PostgresDialogueTaskStore(databaseUrl!);
    const control = new Pool({ connectionString: databaseUrl });
    stores.push(store);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await store.withTask(
        { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1', leaseOwnerToken: firstOwner },
        async () => ({ state: { lastRunId: 'already-durable' }, result: null }),
      );

      const inFlight = store.withTask(
        { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1', leaseOwnerToken: firstOwner },
        async () => {
          await released;
          return { state: { lastRunId: 'must-not-save' }, result: 'unfenced' };
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(
        control.query(
          `UPDATE agent_runtime.agent_runs
              SET lease_owner_token = $2::uuid, lease_expires_at = now() + interval '1 minute'
            WHERE id = $1`,
          [ids.runId, secondOwner],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      release();
      await expect(inFlight).rejects.toBeInstanceOf(TaskAccessError);
      await expect(
        store.withTask(
          { threadId: ids.threadId, runId: ids.runId, actorKey: 'owner:1', leaseOwnerToken: secondOwner },
          async (state) => ({ state, result: state }),
        ),
      ).resolves.toEqual({ lastRunId: 'already-durable' });

      const row = await control.query<{ state: unknown }>(
        'SELECT state FROM agent_runtime.dialogue_tasks WHERE thread_id = $1',
        [ids.threadId],
      );
      expect(row.rows[0]?.state).toEqual({ lastRunId: 'already-durable' });
    } finally {
      release();
      await control.end();
      await cleanupRun(databaseUrl!, ids);
    }
  }, 30_000);
});

async function createRun(
  connectionString: string,
  input: { status: 'queued' | 'running'; leaseOwner?: string; leaseExpiresAt?: Date },
): Promise<{ threadId: string; runId: string }> {
  const threadId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const pool = new Pool({ connectionString });
  try {
    await pool.query('BEGIN');
    await pool.query('INSERT INTO agent_runtime.agent_threads (id) VALUES ($1)', [threadId]);
    await pool.query(
      `INSERT INTO agent_runtime.agent_runs
         (id, thread_id, status, user_message, lease_owner_token, lease_expires_at)
       VALUES ($1, $2, $3, 'task store test', $4::uuid, $5)`,
      [runId, threadId, input.status, input.leaseOwner ?? null, input.leaseExpiresAt ?? null],
    );
    await pool.query('COMMIT');
    return { threadId, runId };
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    await pool.end();
  }
}

async function cleanupRun(connectionString: string, ids: { threadId: string; runId: string }): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query('DELETE FROM agent_runtime.dialogue_tasks WHERE thread_id = $1', [ids.threadId]);
    await pool.query('DELETE FROM agent_runtime.agent_run_events WHERE run_id = $1', [ids.runId]);
    await pool.query('DELETE FROM agent_runtime.agent_messages WHERE run_id = $1', [ids.runId]);
    await pool.query('DELETE FROM agent_runtime.agent_runs WHERE id = $1', [ids.runId]);
    await pool.query('DELETE FROM agent_runtime.agent_threads WHERE id = $1', [ids.threadId]);
  } finally {
    await pool.end();
  }
}
