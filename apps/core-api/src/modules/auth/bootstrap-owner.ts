import 'dotenv/config';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OwnerBootstrapService } from './owner-bootstrap.service.js';

const InputSchema = z.object({
  OWNER_BOOTSTRAP_USERNAME: z.string().trim().min(1).max(80),
  OWNER_BOOTSTRAP_PASSWORD: z.string().min(12).max(128),
});

const input = InputSchema.parse(process.env);
// 账号初始化只需要数据库和 bcrypt，不应要求 Agent Gateway 或 Capability
// 等在线服务配置；这样 Docker 中也能在服务启动后单独创建首个店主账号。
const prisma = new PrismaService();
const owners = new OwnerBootstrapService(prisma);

try {
  await prisma.$connect();
  const owner = await owners.createOwner({
    username: input.OWNER_BOOTSTRAP_USERNAME,
    password: input.OWNER_BOOTSTRAP_PASSWORD,
  });
  console.log(`已创建店主账号：${owner.username}（${owner.id}）`);
} finally {
  await prisma.$disconnect();
}
