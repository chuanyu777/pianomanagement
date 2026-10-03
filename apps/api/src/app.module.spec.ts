import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module.js';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * 装配自检：**不连数据库**，用替身顶掉 PrismaService。
 *
 * 它验的是「模块能不能装起来、守卫有没有挂上、校验管道生不生效」。
 * 脚手架最常见的死法就是 DI 装不起来，而这个用真库反而测不出来 ——
 * 真库连不上和装配失败长得一模一样。
 *
 * 注意边界：这里**没有**验证任何数据库行为。
 * 数据库本身由 test/app.e2e-spec.ts（需要真实 Postgres）负责。
 */
describe('应用装配自检', () => {
  let app: INestApplication;

  const prismaStub = {
    $queryRaw: async () => [{ ok: 1 }],
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    user: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
    },
    $transaction: async () => [[], 0],
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // 与 main.ts 保持一致：管道不一致测的就不是线上那条路径
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('健康检查能通（走的是替身，不含真实数据库）', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });

  it('/api/users 上挂了鉴权：无 token 必须 401，不能是 200 或 500', async () => {
    await request(app.getHttpServer()).get('/api/users').expect(401);
  });

  it('错误响应是统一信封（前端能稳定解析）', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'nothing' })
      .expect(401);

    expect(response.body).toMatchObject({ statusCode: 401 });
  });

  it('声明外的多余字段会被管道拒绝', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'nothing', role: 'OWNER' })
      .expect(400);
  });
});
