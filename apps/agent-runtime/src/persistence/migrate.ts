import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { parseAgentConfig } from '../config/agent-config.js';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

function migrationVersion(fileName: string): string {
  return basename(fileName, '.sql');
}

async function main(): Promise<void> {
  const config = parseAgentConfig(process.env);
  const pool = new Pool({ connectionString: config.AGENT_DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('piano_agent_runtime_migrations'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS agent_runtime');
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_runtime.schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDirectory))
      .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
      .sort();

    for (const fileName of files) {
      const version = migrationVersion(fileName);
      const existing = await client.query(
        'SELECT 1 FROM agent_runtime.schema_migrations WHERE version = $1',
        [version],
      );
      if (existing.rowCount) continue;

      try {
        await client.query('BEGIN');
        await client.query(await readFile(join(migrationDirectory, fileName), 'utf8'));
        await client.query(
          'INSERT INTO agent_runtime.schema_migrations (version) VALUES ($1)',
          [version],
        );
        await client.query('COMMIT');
        console.log(`Applied Agent Runtime migration ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('piano_agent_runtime_migrations'))");
    client.release();
    await pool.end();
  }
}

await main();
