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
  leaseOwnerToken?: string;
}

export interface AppendMessageInput {
  threadId: string;
  runId?: string;
  role: 'user' | 'assistant';
  content: string;
  structured?: unknown;
  leaseOwnerToken?: string;
}

export interface AgentRuntimeRepository {
  createRun(input: CreateRunInput): Promise<{ run: AgentRunRecord; created: boolean }>;
  findRun(runId: string): Promise<AgentRunRecord | null>;
  claimRunForResume(runId: string): Promise<AgentRunRecord | null>;
  claimNextRun(ownerToken: string, leaseDurationMs: number): Promise<LeasedAgentRunRecord | null>;
  renewRunLease(runId: string, ownerToken: string, leaseDurationMs: number): Promise<boolean>;
  releaseRunLease(runId: string, ownerToken: string): Promise<boolean>;
  requeueExpiredRunLeases(limit: number): Promise<number>;
  updateRun(input: UpdateRunInput): Promise<AgentRunRecord>;
  updateRunWithEvent(
    input: UpdateRunInput,
    event: AssistantEvent,
  ): Promise<{ run: AgentRunRecord; event: PersistedAssistantEvent }>;
  appendMessage(input: AppendMessageInput): Promise<void>;
  appendEvent(
    runId: string,
    event: AssistantEvent,
    leaseOwnerToken?: string,
  ): Promise<PersistedAssistantEvent>;
  listEvents(runId: string, afterEventId?: string): Promise<PersistedAssistantEvent[]>;
  close(): Promise<void>;
}

export type LeasedAgentRunRecord = AgentRunRecord & {
  leaseOwnerToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
};

type RunRow = {
  id: string;
  thread_id: string;
  status: AssistantRun['status'];
  user_message: string;
  client_request_id: string | null;
};

type LeasedRunRow = RunRow & {
  lease_owner_token: string;
  lease_expires_at: Date;
  attempt_count: number;
};

function toLeasedRun(row: LeasedRunRow): LeasedAgentRunRecord {
  return {
    ...toRun(row),
    leaseOwnerToken: row.lease_owner_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    attemptCount: row.attempt_count,
  };
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 86_400_000) {
    throw new Error('运行租约时长必须是 1 到 86400000 毫秒的整数');
  }
}

function assertBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('过期租约回收数量必须是 1 到 1000 的整数');
  }
}

function assertRunEventTransition(update: UpdateRunInput, event: AssistantEvent): void {
  const expectedEvent =
    update.status === 'waiting_for_input'
      ? 'clarification.requested'
      : update.status === 'completed'
        ? 'run.completed'
        : update.status === 'failed'
          ? 'run.failed'
          : undefined;
  if (!expectedEvent || event.type !== expectedEvent) {
    throw new Error('运行状态与持久化事件不匹配');
  }
}

async function lockRunForWrite(
  client: PoolClient,
  runId: string,
  leaseOwnerToken?: string,
): Promise<{ thread_id: string }> {
  const result = await client.query<{ thread_id: string }>(
    `SELECT thread_id
       FROM ${schema}.agent_runs
      WHERE id = $1
        AND (
          (lease_owner_token IS NULL AND $2::uuid IS NULL)
          OR (
            lease_owner_token = $2::uuid
            AND lease_expires_at > now()
          )
        )
      FOR UPDATE`,
    [runId, leaseOwnerToken ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('运行不存在或租约已失效');
  return row;
}

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

    async claimNextRun(ownerToken, leaseDurationMs) {
      assertLeaseDuration(leaseDurationMs);
      const result = await pool.query<LeasedRunRow>(
        `WITH candidate AS (
           SELECT id
             FROM ${schema}.agent_runs
            WHERE status = 'queued'
               OR (status = 'running' AND lease_expires_at <= now())
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE ${schema}.agent_runs AS run
            SET status = 'running',
                lease_owner_token = $1::uuid,
                lease_expires_at = now() + ($2::double precision * interval '1 millisecond'),
                attempt_count = run.attempt_count + 1,
                started_at = COALESCE(run.started_at, now()),
                updated_at = now()
           FROM candidate
          WHERE run.id = candidate.id
         RETURNING run.id, run.thread_id, run.status, run.user_message, run.client_request_id,
                   run.lease_owner_token, run.lease_expires_at, run.attempt_count`,
        [ownerToken, leaseDurationMs],
      );
      const row = result.rows[0];
      return row ? toLeasedRun(row) : null;
    },

    async renewRunLease(runId, ownerToken, leaseDurationMs) {
      assertLeaseDuration(leaseDurationMs);
      const result = await pool.query(
        `UPDATE ${schema}.agent_runs
            SET lease_expires_at = now() + ($3::double precision * interval '1 millisecond'),
                updated_at = now()
          WHERE id = $1
            AND status = 'running'
            AND lease_owner_token = $2::uuid
            AND lease_expires_at > now()`,
        [runId, ownerToken, leaseDurationMs],
      );
      return result.rowCount === 1;
    },

    async releaseRunLease(runId, ownerToken) {
      const result = await pool.query(
        `UPDATE ${schema}.agent_runs
            SET status = 'queued',
                lease_owner_token = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND status = 'running'
            AND lease_owner_token = $2::uuid
            AND lease_expires_at > now()`,
        [runId, ownerToken],
      );
      return result.rowCount === 1;
    },

    async requeueExpiredRunLeases(limit) {
      assertBatchLimit(limit);
      const result = await pool.query(
        `WITH expired AS (
           SELECT id
             FROM ${schema}.agent_runs
            WHERE status = 'running'
              AND lease_expires_at <= now()
            ORDER BY lease_expires_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE ${schema}.agent_runs AS run
            SET status = 'queued',
                lease_owner_token = NULL,
                lease_expires_at = NULL,
                updated_at = now()
           FROM expired
          WHERE run.id = expired.id`,
        [limit],
      );
      return result.rowCount ?? 0;
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
                  lease_owner_token = CASE WHEN $2 = 'running' THEN lease_owner_token ELSE NULL END,
                  lease_expires_at = CASE WHEN $2 = 'running' THEN lease_expires_at ELSE NULL END,
                  completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE completed_at END,
                  updated_at = now()
            WHERE id = $1
              AND (
                (lease_owner_token IS NULL AND $5::uuid IS NULL)
                OR (
                  lease_owner_token = $5::uuid
                  AND lease_expires_at > now()
                )
              )
            RETURNING id, thread_id, status, user_message, client_request_id`,
          [
            update.runId,
            update.status,
            update.errorCode ?? null,
            update.errorMessage ?? null,
            update.leaseOwnerToken ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('运行不存在或租约已失效');
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

    async updateRunWithEvent(update, event) {
      const checked = AssistantEventSchema.parse(event);
      assertRunEventTransition(update, checked);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const runResult = await client.query<RunRow>(
          `UPDATE ${schema}.agent_runs
              SET status = $2,
                  error_code = $3,
                  error_message = $4,
                  lease_owner_token = CASE WHEN $2 = 'running' THEN lease_owner_token ELSE NULL END,
                  lease_expires_at = CASE WHEN $2 = 'running' THEN lease_expires_at ELSE NULL END,
                  completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE completed_at END,
                  updated_at = now()
            WHERE id = $1
              AND (
                (lease_owner_token IS NULL AND $5::uuid IS NULL)
                OR (
                  lease_owner_token = $5::uuid
                  AND lease_expires_at > now()
                )
              )
            RETURNING id, thread_id, status, user_message, client_request_id`,
          [
            update.runId,
            update.status,
            update.errorCode ?? null,
            update.errorMessage ?? null,
            update.leaseOwnerToken ?? null,
          ],
        );
        const runRow = runResult.rows[0];
        if (!runRow) throw new Error('运行不存在或租约已失效');
        const eventResult = await client.query<{ event_id: string; created_at: Date }>(
          `INSERT INTO ${schema}.agent_run_events (run_id, event_type, payload)
           VALUES ($1, $2, $3)
           RETURNING event_id, created_at`,
          [update.runId, checked.type, checked],
        );
        const eventRow = eventResult.rows[0];
        if (!eventRow) throw new Error('事件持久化失败');
        await client.query(
          `UPDATE ${schema}.agent_threads
              SET last_activity_at = now(), updated_at = now()
            WHERE id = $1`,
          [runRow.thread_id],
        );
        await client.query('COMMIT');
        return {
          run: toRun(runRow),
          event: {
            eventId: eventRow.event_id,
            event: checked,
            createdAt: eventRow.created_at.toISOString(),
          },
        };
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
        if (message.runId) {
          const run = await lockRunForWrite(client, message.runId, message.leaseOwnerToken);
          if (run.thread_id !== message.threadId) throw new Error('运行与会话不匹配');
        }
        const inserted = message.runId
          ? await client.query(
              `INSERT INTO ${schema}.agent_messages (id, thread_id, run_id, role, content, structured)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                randomUUID(),
                message.threadId,
                message.runId,
                message.role,
                message.content,
                message.structured ?? null,
              ],
            )
          : await client.query(
              `INSERT INTO ${schema}.agent_messages (id, thread_id, run_id, role, content, structured)
               VALUES ($1, $2, NULL, $3, $4, $5)`,
              [
                randomUUID(),
                message.threadId,
                message.role,
                message.content,
                message.structured ?? null,
              ],
            );
        if (inserted.rowCount !== 1) throw new Error('消息持久化失败或租约已失效');
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

    async appendEvent(runId, event, leaseOwnerToken) {
      const checked = AssistantEventSchema.parse(event);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const run = await lockRunForWrite(client, runId, leaseOwnerToken);
        const result = await client.query<{ event_id: string; created_at: Date }>(
          `INSERT INTO ${schema}.agent_run_events (run_id, event_type, payload)
           VALUES ($1, $2, $3)
           RETURNING event_id, created_at`,
          [runId, checked.type, checked],
        );
        const row = result.rows[0];
        if (!row) throw new Error('事件持久化失败或租约已失效');
        await client.query(
          `UPDATE ${schema}.agent_threads
              SET last_activity_at = now(), updated_at = now()
            WHERE id = $1`,
          [run.thread_id],
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
