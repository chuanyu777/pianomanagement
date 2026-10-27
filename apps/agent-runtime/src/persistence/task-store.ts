import { Pool, type PoolClient } from 'pg';

const schema = 'agent_runtime';

export interface DialogueTaskStore {
  withTask<T>(
    input: {
      threadId: string;
      runId: string;
      actorKey: string;
      leaseOwnerToken?: string;
    },
    work: (state: unknown) => Promise<{ state: unknown; result: T }>,
  ): Promise<T>;
  close(): Promise<void>;
}

export class TaskAccessError extends Error {
  constructor() {
    super('任务访问范围不匹配');
    this.name = 'TaskAccessError';
  }
}

type RunLeaseRow = {
  thread_id: string;
  lease_owner_token: string | null;
  lease_expires_at: Date | null;
};

type DialogueTaskRow = {
  actor_key: string;
  state: unknown;
};

function jsonState(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined is not JSON');
    return serialized;
  } catch {
    throw new Error('任务状态必须是可持久化的 JSON 值');
  }
}

async function assertLiveRun(
  client: PoolClient,
  input: {
    threadId: string;
    runId: string;
    leaseOwnerToken?: string;
  },
  lock: boolean,
): Promise<void> {
  const result = await client.query<RunLeaseRow>(
    `SELECT thread_id, lease_owner_token, lease_expires_at
       FROM ${schema}.agent_runs
      WHERE id = $1
        AND thread_id = $2
        AND (
          ($3::text IS NULL AND lease_owner_token IS NULL AND lease_expires_at IS NULL)
          OR (
            $3::text IS NOT NULL
            AND lease_owner_token::text = $3::text
            AND lease_expires_at > clock_timestamp()
          )
        )${lock ? ' FOR UPDATE' : ''}`,
    [input.runId, input.threadId, input.leaseOwnerToken ?? null],
  );
  if (!result.rows[0]) throw new TaskAccessError();
}

export class PostgresDialogueTaskStore implements DialogueTaskStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString });
  }

  async withTask<T>(
    input: {
      threadId: string;
      runId: string;
      actorKey: string;
      leaseOwnerToken?: string;
    },
    work: (state: unknown) => Promise<{ state: unknown; result: T }>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.threadId]);

      await assertLiveRun(client, input, false);
      await client.query(
        `INSERT INTO ${schema}.dialogue_tasks (thread_id, actor_key)
         VALUES ($1, $2)
         ON CONFLICT (thread_id) DO NOTHING`,
        [input.threadId, input.actorKey],
      );
      const task = await client.query<DialogueTaskRow>(
        `SELECT actor_key, state
           FROM ${schema}.dialogue_tasks
          WHERE thread_id = $1`,
        [input.threadId],
      );
      const row = task.rows[0];
      if (!row || row.actor_key !== input.actorKey) throw new TaskAccessError();

      const outcome = await work(row.state);
      const serializedState = jsonState(outcome.state);

      await assertLiveRun(client, input, true);
      const saved = await client.query(
        `UPDATE ${schema}.dialogue_tasks
            SET state = $2::jsonb, updated_at = clock_timestamp()
          WHERE thread_id = $1
            AND actor_key = $3`,
        [input.threadId, serializedState, input.actorKey],
      );
      if (saved.rowCount !== 1) throw new TaskAccessError();

      await client.query('COMMIT');
      return outcome.result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
