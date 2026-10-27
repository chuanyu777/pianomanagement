// Fixture/evidence helper, not a browser automation or a runtime Core database client.
import { readFileSync, writeFileSync } from 'node:fs';
import { createEnvironment, assertAuditDatabase, docker } from '../../agent-runtime/test/ai-retest-environment.mjs';
import pg from 'pg';

if (process.argv[2] === 'prepare') {
  const env = await createEnvironment();
  try {
    const { fixture } = await env.use('F1');
    const privateFile = `${env.privateDir}/browser-session.json`;
    writeFileSync(privateFile, JSON.stringify({ ...env.credentials, accessToken: env.token,
      accountId: fixture.accounts.lin.main.id, teacherId: fixture.teachers.wang.id }), { mode: 0o600 });
    console.log(JSON.stringify({ privateFile, prepared: 'F1', expectedPaidBalance: '500.00', expectedGiftBalance: '80.00' }));
  } finally { await env.close(); }
} else if (process.argv[2] === 'check') {
  const privateFile = process.argv[3];
  if (!/^\/private\/tmp\/piano-ai-retest-[^/]+\/browser-session\.json$/.test(privateFile)) throw new Error('PRIVATE_TEST_SESSION_REQUIRED');
  const session = JSON.parse(readFileSync(privateFile, 'utf8'));
  const config = JSON.parse(docker(['config', '--format', 'json']));
  const url = new URL(config.services.core.environment.CORE_DATABASE_URL);
  url.hostname = '127.0.0.1'; url.port = '5443';
  const pool = new pg.Pool({ connectionString: url.href });
  try {
    assertAuditDatabase(url.href, (await pool.query('SELECT current_database() AS db')).rows[0].db);
    const response = await fetch(`http://localhost:3010/api/student-course-accounts/${session.accountId}/balance`, {
      headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('TEST_BALANCE_READ_FAILED');
    const balance = await response.json();
    const counts = (await pool.query('SELECT (SELECT count(*) FROM "PaymentRecord" WHERE "accountId"=$1)::int AS payments, (SELECT count(*) FROM "LedgerEntry" WHERE "accountId"=$1)::int AS ledger', [session.accountId])).rows[0];
    const storedPreviews = (await pool.query('SELECT id,status FROM "ActionPreview" WHERE "normalizedCommandJson"->>\'accountId\'=$1 ORDER BY "createdAt"', [session.accountId])).rows;
    const previews = [];
    for (const stored of storedPreviews) {
      const state = await fetch(`http://localhost:3010/api/assistant/previews/${stored.id}`, {
        headers: { authorization: `Bearer ${session.accessToken}` }, signal: AbortSignal.timeout(10000),
      });
      if (!state.ok) throw new Error('TEST_PREVIEW_READ_FAILED');
      const actual = await state.json();
      previews.push({ id: stored.id, storedStatus: stored.status, status: actual.status, receipt: actual.receipt });
    }
    const proxy = await fetch('http://localhost:5181/__ai_audit_fault').then(r => r.json());
    const evidence = { capturedAt: new Date().toISOString(), balance, counts, previews, proxy };
    if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally { await pool.end(); }
} else throw new Error('EXPECTED_PREPARE_OR_CHECK');
