/**
 * 启动时校验环境变量。
 *
 * 为什么不用「读不到就给个默认值」：配错的 JWT_SECRET 或 DATABASE_URL
 * 在开发机上看着能跑，到线上会变成静默的安全事故或数据事故。
 * 宁可起不来。
 */

export const MIN_JWT_SECRET_LENGTH = 32;

export const DEFAULT_JWT_EXPIRES_IN = '12h';

/** 只接受「数字 + 单位」：s / m / h / d。和 ms 库的时长写法一致。 */
export const JWT_EXPIRES_IN_PATTERN = /^[0-9]+(s|m|h|d)$/;

export type AppEnv = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  /** 允许跨域的前端来源。逗号分隔。前端和后端不同端口时必须配对，否则浏览器直接拦。 */
  CORS_ORIGINS: string[];
};

export const DEFAULT_CORS_ORIGINS = ['http://localhost:5173'];

const NODE_ENVS = ['development', 'test', 'production'] as const;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const errors: string[] = [];

  const nodeEnv = asNonEmptyString(raw.NODE_ENV) ?? 'development';
  if (!(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    errors.push(`NODE_ENV 只能是 ${NODE_ENVS.join(' / ')}，当前是 "${nodeEnv}"`);
  }

  const databaseUrl = asNonEmptyString(raw.DATABASE_URL);
  if (!databaseUrl) {
    errors.push('缺少 DATABASE_URL');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL 必须是 postgresql:// 开头');
  }

  const jwtSecret = asNonEmptyString(raw.JWT_SECRET);
  if (!jwtSecret) {
    errors.push('缺少 JWT_SECRET');
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET 至少 ${MIN_JWT_SECRET_LENGTH} 位，当前只有 ${jwtSecret.length} 位`);
  }

  // 格式必须校验：写错了不会在启动时报错，只会在签 token 时炸，
  // 或者更糟 —— 被当成一个「奇怪的时长」静默接受，token 有效期不是你以为的那个。
  const jwtExpiresIn = asNonEmptyString(raw.JWT_EXPIRES_IN) ?? DEFAULT_JWT_EXPIRES_IN;
  if (!JWT_EXPIRES_IN_PATTERN.test(jwtExpiresIn)) {
    errors.push(
      `JWT_EXPIRES_IN 格式不对："${jwtExpiresIn}"，应形如 12h / 30m / 7d / 3600s`,
    );
  }

  const portRaw = asNonEmptyString(raw.PORT) ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`PORT 不是合法端口："${portRaw}"`);
  }

  // 生产环境不给默认值：默认值是开发机的地址，放到线上等于「谁都能跨域调」，
  // 而且不会报错、只会静默地多开一个口子。
  const corsRaw = asNonEmptyString(raw.CORS_ORIGINS);
  if (nodeEnv === 'production' && !corsRaw) {
    errors.push('生产环境必须显式配置 CORS_ORIGINS（逗号分隔），不能依赖开发默认值');
  }
  const corsOrigins = corsRaw
    ? corsRaw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : DEFAULT_CORS_ORIGINS;

  if (errors.length > 0) {
    throw new Error('环境变量校验失败：\n  - ' + errors.join('\n  - '));
  }

  return {
    NODE_ENV: nodeEnv as AppEnv['NODE_ENV'],
    PORT: port,
    DATABASE_URL: databaseUrl as string,
    JWT_SECRET: jwtSecret as string,
    JWT_EXPIRES_IN: jwtExpiresIn,
    CORS_ORIGINS: corsOrigins,
  };
}
