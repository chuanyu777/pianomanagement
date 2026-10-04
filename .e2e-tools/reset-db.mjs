/** 清空并重建数据库结构（测试可重复用）。跑完需要再执行 prisma migrate deploy。 */
import pg from 'pg';
import { execSync } from 'node:child_process';
const url = 'postgresql://piano:piano@127.0.0.1:5433/piano?schema=public';
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE');
await c.query('CREATE SCHEMA public');
await c.end();
console.log('schema 已重建');
execSync('npx prisma migrate deploy', {
  cwd: 'D:/DevSpace/piano-management/apps/api',
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
});
console.log('迁移已应用，数据库为空库');
