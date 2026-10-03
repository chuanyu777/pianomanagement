// Prisma 7 的 CLI 配置文件（官方约定名）。
// 注意：Prisma 7 不再从 schema.prisma 读 url，也不再自动加载 .env，
// 所以这里必须显式 import 'dotenv/config'。
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
