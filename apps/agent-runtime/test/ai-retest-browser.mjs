import { randomUUID } from 'node:crypto';

/**
 * Test-only equivalents of what the browser does after rendering an Assistant
 * action-preview. They deliberately use the public Core JWT endpoints; the
 * Agent is never allowed to call these endpoints in production.
 */
export async function readPreview(env, previewId, auth) {
  return env.request(`/assistant/previews/${previewId}`, undefined, auth);
}

export async function confirmPreview(env, previewId, auth, options = {}) {
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const first = await env.request(
    `/assistant/previews/${previewId}/confirm`,
    null,
    auth,
    'POST',
    { 'Idempotency-Key': idempotencyKey },
  );
  const repeat = options.repeat === false ? null : await env.request(
    `/assistant/previews/${previewId}/confirm`,
    null,
    auth,
    'POST',
    { 'Idempotency-Key': idempotencyKey },
  );
  return { first, repeat, idempotencyKey };
}

export async function readBalance(env, accountId, auth) {
  return env.request(`/student-course-accounts/${accountId}/balance`, undefined, auth);
}

export async function readLessons(env, auth) {
  return env.request('/lessons', undefined, auth);
}

export async function readPayrolls(env, period, auth) {
  return env.request(`/payrolls?period=${encodeURIComponent(period)}`, undefined, auth);
}

export async function recordManualPayment(env, accountId, amount, occurredAt, auth, options = {}) {
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const first = await env.request(
    `/student-course-accounts/${accountId}/payments`,
    { amount, channel: options.channel ?? 'WECHAT', occurredAt },
    auth,
    'POST',
    { 'Idempotency-Key': idempotencyKey },
  );
  const repeat = options.repeat === false ? null : await env.request(
    `/student-course-accounts/${accountId}/payments`,
    { amount, channel: options.channel ?? 'WECHAT', occurredAt },
    auth,
    'POST',
    { 'Idempotency-Key': idempotencyKey },
  );
  return { first, repeat, idempotencyKey };
}

export async function countCoreRows(env, table, where = {}) {
  const allowed = new Set(['PaymentRecord', 'LedgerEntry', 'Lesson', 'Payroll', 'BusinessAuditEvent']);
  if (!allowed.has(table)) throw new Error('AUDIT_UNSAFE_ROW_COUNT');
  const predicates = Object.keys(where);
  const values = predicates.map((key) => where[key]);
  const clause = predicates.length === 0
    ? ''
    : ` WHERE ${predicates.map((key, index) => `"${key}" = $${index + 1}`).join(' AND ')}`;
  const result = await env.pool.query(`SELECT COUNT(*)::int AS count FROM "${table}"${clause}`, values);
  return result.rows[0].count;
}

export async function restartAuditAgent(env, overrides = {}) {
  await env.restartAgent(overrides);
}

