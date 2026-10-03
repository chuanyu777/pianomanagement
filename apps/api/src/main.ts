import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { validateEnv } from './config/env.validation.js';

async function bootstrap(): Promise<void> {
  // 先校验再创建应用：配置坏了就停在这里，不要起一个「能跑但配错了」的进程
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule);

  // 所有接口统一挂在 /api 下：前端只记一个前缀，将来加 nginx 反代也不用改前端
  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 丢掉 DTO 里没声明的字段
      forbidNonWhitelisted: true, // 声明外的字段直接报错，而不是静默忽略
      transform: true, // 让 @Type 转换生效（分页参数靠它从字符串变数字）
    }),
  );

  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API 已启动：http://localhost:${env.PORT}/api`);
}

await bootstrap();
