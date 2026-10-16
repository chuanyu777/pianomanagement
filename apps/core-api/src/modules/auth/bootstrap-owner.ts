import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../../app.module.js';
import { OwnerBootstrapService } from './owner-bootstrap.service.js';

const InputSchema = z.object({
  OWNER_BOOTSTRAP_USERNAME: z.string().trim().min(1).max(80),
  OWNER_BOOTSTRAP_PASSWORD: z.string().min(12).max(128),
});

const input = InputSchema.parse(process.env);
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

try {
  const owner = await app.get(OwnerBootstrapService).createOwner({
    username: input.OWNER_BOOTSTRAP_USERNAME,
    password: input.OWNER_BOOTSTRAP_PASSWORD,
  });
  console.log(`已创建店主账号：${owner.username}（${owner.id}）`);
} finally {
  await app.close();
}
