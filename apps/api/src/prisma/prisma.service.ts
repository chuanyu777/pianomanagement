import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated.js';

/**
 * 只回显 host:port/database，**绝不回显连接串本身** —— 里面有密码。
 */
function describeDatabaseTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(DATABASE_URL 不是合法 URL)';
  }
}

/**
 * 打掉错误信息里可能夹带的凭据（形如 //user:pass@host）。
 * 日志和报错都可能被人看到，别在这里漏密码。
 * pg 的连接失败常被裹成 AggregateError（外层 message 是空的），所以要往下挖一层。
 */
function sanitizeError(error: unknown): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    const raw = value instanceof Error ? value.message : String(value ?? '');
    const cleaned = raw.replace(/\/\/[^@\s/]+@/g, '//<REDACTED>@').trim();
    if (cleaned.length > 0) parts.push(cleaned);
  };

  collect(error);
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const inner = (error as { errors?: unknown }).errors;
    if (Array.isArray(inner)) inner.forEach(collect);
  }
  if (parts.length > 0) return parts.join(' | ');

  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  return code ? `${name} (code=${code})` : name;
}

/**
 * Prisma 客户端 + Nest 生命周期托管。
 *
 * Prisma 7 起不再有内置查询引擎，必须显式传 driver adapter，
 * 连接串也从 schema.prisma 里挪走了，所以这里从 DATABASE_URL 读。
 *
 * 两件必须记住的事：
 * 1. 库里没有连接串就直接抛，不要退化成「一个连不上任何库的 client」。
 * 2. **启动时必须真查一次库**。driver adapter 下 `$connect()` 是懒的：
 *    数据库没起它也会「成功」，于是日志里会留下一条骗人的「连接已建立」，
 *    而请求打到第一个真实查询才炸。已实测踩过这个坑。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        '缺少 DATABASE_URL：PrismaService 建不起来。请从 .env.example 复制出 .env。',
      );
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    const target = describeDatabaseTarget(process.env.DATABASE_URL ?? '');
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      // 起不来比起得来但服务不了请求要好：一个连不上库的业务 API，
      // 会把所有请求都变成 500，还让人以为是接口写错了。
      throw new Error(
        `数据库连不上（目标 ${target}）。先确认 Postgres 已启动：npm run db:up。` +
          `底层错误：${sanitizeError(error)}`,
      );
    }
    this.logger.log(`数据库连通性已确认（${target}）`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
