import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

function describeDatabaseTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(CORE_DATABASE_URL 不是合法 URL)';
  }
}

function sanitizeError(error: unknown): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    const raw = value instanceof Error ? value.message : String(value ?? '');
    const cleaned = raw.replace(/\/\/[^@\s/]+@/g, '//<REDACTED>@').trim();
    if (cleaned.length > 0) parts.push(cleaned);
  };

  collect(error);
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const nested = (error as { errors?: unknown }).errors;
    if (Array.isArray(nested)) nested.forEach(collect);
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
 * Core 唯一 Prisma 访问层。
 * Prisma 7 必须显式传入 adapter；业务模块不得自行 new PrismaClient。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env['CORE_DATABASE_URL'];
    if (!connectionString) {
      throw new Error('缺少 CORE_DATABASE_URL：PrismaService 无法建立数据库连接。');
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    const target = describeDatabaseTarget(process.env['CORE_DATABASE_URL'] ?? '');
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new Error(
        `Core 数据库连不上（目标 ${target}）。底层错误：${sanitizeError(error)}`,
      );
    }
    this.logger.log(`Core 数据库连通性已确认（${target}）`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
