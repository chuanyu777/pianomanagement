# 琴行管理系统

前后端同仓。**业务需求在另一个仓库**：`D:\DevSpace\琴行经营报表\docs\需求-用户故事.md`。

| 目录 | 内容 |
|---|---|
| `apps/api` | NestJS + Prisma + PostgreSQL 后端 |
| `apps/web` | Refine 前端（尚未开始） |
| `packages/shared` | 前后端共享的接口契约类型 |

## 快速开始

```bash
npm install                            # 自动生成 Prisma client、构建 shared
cp apps/api/.env.example apps/api/.env # 然后把 JWT_SECRET 换成随机串
npm run db:up                          # 起 Postgres（需要 Docker）
npm run db:migrate -w @piano/api       # 建表
npm run start:dev -w @piano/api        # http://localhost:3000/api
```

接口统一前缀 `api`，探活：`GET http://localhost:3000/api/health`。

## 约定

**动手前先读 [`AGENTS.md`](./AGENTS.md)。** 里面的硬规则、禁改清单和「已知未做」是这个仓库的约束，
每次 agent 运行都会被自动加载。
