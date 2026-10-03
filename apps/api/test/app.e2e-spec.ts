import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

/**
 * 端到端测试。
 *
 * **需要真实 Postgres**：先 `npm run db:up`，再 `npm run test:e2e`（在 apps/api 下）。
 * 它验证的是整条链路：环境变量校验 → 全局异常出口 → 守卫 → 控制器 → 服务 → Prisma → 库。
 *
 * 数据库没起时它会红，这是对的 —— 不要为了让 e2e 变绿而把它改成假数据。
 * 下面三个用例都**不需要预置数据**，空库也能跑。
 */
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    // 和 main.ts 保持一致：管道不一致的 e2e 测的不是线上那条路径
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health 探活通过（含数据库连通性）', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });

  it('未带 token 访问 /api/users 返回 401，不是 403 也不是 200', async () => {
    await request(app.getHttpServer()).get('/api/users').expect(401);
  });

  it('登录失败返回统一的错误体（能被前端稳定解析）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'no-such-user', password: 'whatever' })
      .expect(401);

    expect(response.body).toEqual({
      statusCode: 401,
      message: '用户名或密码不正确',
    });
  });

  it('声明外的多余字段会被拒绝，而不是静默忽略', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'no-such-user', password: 'whatever', isAdmin: true })
      .expect(400);
  });
});
