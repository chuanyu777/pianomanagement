import { DEFAULT_CORS_ORIGINS, MIN_JWT_SECRET_LENGTH, validateEnv } from './env.validation.js';

const validRaw = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://piano:piano@localhost:5433/piano',
  JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH),
  PORT: '3000',
};

describe('validateEnv', () => {
  it('合法配置能通过，并补齐默认值', () => {
    expect(validateEnv(validRaw)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: validRaw.DATABASE_URL,
      JWT_SECRET: validRaw.JWT_SECRET,
      JWT_EXPIRES_IN: '12h',
      CORS_ORIGINS: DEFAULT_CORS_ORIGINS,
    });
  });

  it('缺 JWT_SECRET 直接抛，不是给个默认值兜过去', () => {
    const { JWT_SECRET: _omitted, ...rest } = validRaw;
    expect(() => validateEnv(rest)).toThrow(/缺少 JWT_SECRET/);
  });

  it('JWT_SECRET 太短要挡住', () => {
    expect(() => validateEnv({ ...validRaw, JWT_SECRET: 'short' })).toThrow(/至少 32 位/);
  });

  it('DATABASE_URL 不是 postgres 连接串要挡住', () => {
    expect(() => validateEnv({ ...validRaw, DATABASE_URL: 'mysql://a:b@localhost/db' })).toThrow(
      /postgresql/,
    );
  });

  it('端口越界要挡住', () => {
    expect(() => validateEnv({ ...validRaw, PORT: '70000' })).toThrow(/PORT/);
  });

  it('JWT_EXPIRES_IN 格式不对要挡住 —— 写错了不会在启动时报错，只会在签 token 时炸', () => {
    expect(() => validateEnv({ ...validRaw, JWT_EXPIRES_IN: '12 hours' })).toThrow(
      /JWT_EXPIRES_IN 格式不对/,
    );
  });

  it('JWT_EXPIRES_IN 是合法时长就接受', () => {
    expect(validateEnv({ ...validRaw, JWT_EXPIRES_IN: '30m' }).JWT_EXPIRES_IN).toBe('30m');
  });

  it('生产环境不给 CORS_ORIGINS 要挡住 —— 否则会静默用开发默认值开一个口子', () => {
    expect(() => validateEnv({ ...validRaw, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
  });

  it('生产环境给了 CORS_ORIGINS 就按逗号切开', () => {
    const env = validateEnv({
      ...validRaw,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('一次把所有问题都报出来，不要只报第一个', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });
});
