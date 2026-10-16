import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  AssistantEventSchema,
  AssistantRunSchema,
  type AssistantEvent,
  type AssistantRun,
} from '@piano/assistant-protocol';

const schema = 'agent_runtime';

export type AgentRunRecord = AssistantRun & {
  userMessage: string;
  clientRequestId?: string | undefined;
};

export interface PersistedAssistantEvent {
  eventId: string;
  event: AssistantEvent;
  createdAt: string;
}

export interface CreateRunInput {
  runId: string;
  threadId: string;
  userMessage: string;
  clientRequestId?: string | undefined;
}

export interface UpdateRunInput {
  runId: string;
  status: AssistantRun['status'];
  errorCode?: string;
  errorMessage?: string;
}

export interface AppendMessageInput {
  threadId: string;
  runId?: string;
  role: 'user' | 'assistant';
  content: string;
  structured?: unknown;
}

export interface AgentRuntimeRepository {
  createRun(input: CreateRunInput): Promise<{ run: AgentRunRecord; created: boolean }>;
  findRun(runId: string): Promise<AgentRunRecord | null>;
  claimRunForResume(runId: string): Promise<AgentRunRecord | null>;
  updateRun(input: UpdateRunInput): Promise<AgentRunRecord>;
  appendMessage(input: AppendMessageInput): Promise<void>;
  appendEvent(runId: string, event: AssistantEvent): Promise<PersistedAssistantEvent>;
  listEvents(runId: string, afterEventId?: string): Promise<PersistedAssistantEvent[]>;
  close(): Promise<void>;
}

type RunRow = {
  id: string;
  thread_id: string;
  status: AssistantRun['status'];
  user_message: string;
  client_request_id: string | null;
};

function toRun(row: RunRow): AgentRunRecord {
  const run = AssistantRunSchema.parse({
    runId: row.id,
    threadId: row.thread_id,
    status: row.status,
  });
  return {
    ...run,
    userMessage: row.user_message,
    ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}),
  };
}

async function findRunWithClient(client: Pool | PoolClient, runId: string): Promise<AgentRunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT id, thread_id, status, user_message, client_request_id
       FROM ${schema}.agent_runs
      WHERE id = $1`,
    [runId],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

function parseEventId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || value === '0') {
    throw new Error('SSE event cursor 不合法');
  }
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new Error('SSE event cursor 不合法');
  }
  return value;
}

export function createAgentRuntimeRepository(input: {
  connectionString: string;
}): AgentRuntimeRepository {
  const pool = new Pool({ connectionString: input.connectionString });

  return {
    async createRun(runInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ${schema}.agent_threads (id, last_activity_at, updated_at)
           VALUES ($1, now(), now())
           ON CONFLICT (id) DO UPDATE SET last_activity_at = now(), updated_at = now()`,
          [runInput.threadId],
        );
        const inserted = await client.query<RunRow>(
          `INSERT INTO ${schema}.agent_runs
             (id, thread_id, client_request_id, status, user_message, started_at)
           VALUES ($1, $2, $3, 'running', $4, now())
           ON CONFLICT DO NOTHING
           RETURNING id, thread_id, status, user_message, client_request_id`,
          [runInput.runId, runInput.threadId, runInput.clientRequestId ?? null, runInput.userMessage],
        );
        if (inserted.rows[0]) {
          await client.query(
            `INSERT INTO ${schema}.agent_messages (id, thread_id, run_id, role, content)
             VALUES ($1, $2, $3, 'user', $4)`,
            [randomUUID(), runInput.threadId, runInput.runId, runInput.userMessage],
          );
          await client.query('COMMIT');
          return { run: toRun(inserted.rows[0]), created: true };
        }

        const existing = await client.query<RunRow>(
          `SELECT id, thread_id, status, user_message, client_request_id
             FROM ${schema}.agent_runs
            WHERE id = $1
               OR ($2::text IS NOT NULL AND thread_id = $3 AND client_request_id = $2)
            ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
            LIMIT 1`,
          [runInput.runId, runInput.clientRequestId ?? null, runInput.threadId],
        );
        const row = existing.rows[0];
        if (!row) throw new Error('插入运行记录失败后无法读取运行记录');
        if (row.id === runInput.runId && row.thread_id !== runInput.threadId) {
          await client.query('ROLLBACK');
          return { run: toRun(row), created: false };
        }
        await client.query('COMMIT');
        return { run: toRun(row), created: false };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    findRun(runId) {
      return findRunWithClient(pool, runId);
    },

    async claimRunForResume(runId) {
      const result = await pool.query<RunRow>(
        `UPDATE ${schema}.agent_runs
            SET status = 'running', updated_at = now()
          WHERE id = $1 AND status = 'waiting_for_input'
          RETURNING id, thread_id, status, user_message, client_request_id`,
        [runId],
      );
      const row = result.rows[0];
      return row ? toRun(row) : null;
    },

    async updateRun(update) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<RunRow>(
          `UPDATE ${schema}.agent_runs
              SET status = $2,
                  error_code = $3,
                  error_message = $4,
                  completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE completed_at END,
                  updated_at = now()
            WHERE id = $1
            RETURNING id, thread_id, status, user_message, client_request_id`,
          [update.runId, update.status, update.errorCode ?? null, update.errorMessage ?? null],
        );
        const row = result.rows[0];
        if (!row) throw new Error('运行不存在');
        await client.query(
          `UPDATE ${schema}.agent_threads
              SET last_activity_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.thread_id],
        );
        await client.query('COMMIT');
        return toRun(row);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async appendMessage(message) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ${schema}.agent_messages (id, thread_id, run_id, role, content, structured)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            message.threadId,
            message.runId ?? null,
            message.role,
            message.content,
            message.structured ?? null,
          ],
        );
        await client.query(
          `UPDATE ${schema}.agent_threads
              SET last_activity_at = now(), updated_at = now()
            WHERE id = $1`,
          [message.threadId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async appendEvent(runId, event) {
      const checked = AssistantEventSchema.parse(event);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{ event_id: string; created_at: Date }>(
          `INSERT INTO ${schema}.agent_run_events (run_id, event_type, payload)
           VALUES ($1, $2, $3)
           RETURNING event_id, created_at`,
          [runId, checked.type, checked],
        );
        const row = result.rows[0];
        if (!row) throw new Error('事件持久化失败');
        await client.query(
          `UPDATE ${schema}.agent_threads
              SET last_activity_at = now(), updated_at = now()
            WHERE id = (SELECT thread_id FROM ${schema}.agent_runs WHERE id = $1)`,
          [runId],
        );
        await client.query('COMMIT');
        return {
          eventId: row.event_id,
          event: checked,
          createdAt: row.created_at.toISOString(),
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEvents(runId, afterEventId) {
      const cursor = parseEventId(afterEventId);
      const result = await pool.query<{ event_id: string; payload: AssistantEvent; created_at: Date }>(
        `SELECT event_id, payload, created_at
           FROM ${schema}.agent_run_events
          WHERE run_id = $1
            AND ($2::bigint IS NULL OR event_id > $2::bigint)
          ORDER BY event_id ASC
          LIMIT 1000`,
        [runId, cursor ?? null],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        event: AssistantEventSchema.parse(row.payload),
        createdAt: row.created_at.toISOString(),
      }));
    },

    close() {
      return pool.end();
    },
  };
}
