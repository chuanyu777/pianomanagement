# AGENTS.md — 琴行管理系统 项目规约

本文件是**硬约束**，不是建议。WorkBuddy 在每次 agent 运行前会自动读取本文件并注入上下文，
所以：**加内容前先想「这条值不值得每次对话都烧一遍 token」**。能靠代码表达的就别写在这儿。

## 1. 这个项目是什么

琴行经营管理系统。前后端同仓：`apps/api` 是后端（NestJS + Prisma + PostgreSQL），
`apps/web` 是前端（Refine，尚未开始）。

业务需求在**另一个仓库**：`D:\DevSpace\琴行经营报表\docs\需求-用户故事.md`（44 条故事 / 14 个模块）。
那是需求的唯一来源，本仓库不复制一份。

## 2. 仓库结构

```
apps/api/          NestJS 后端
  prisma/schema.prisma     ← 数据模型的唯一来源
  src/generated/prisma/    ← Prisma 生成物，不手改、不进 git
  src/prisma/              ← 全项目唯一接触生成产物的地方
  src/config/              ← 环境变量校验
  src/common/              ← 跨模块通用件（禁止依赖 src/modules）
  src/modules/<领域>/      ← 每个领域一个模块
apps/web/          前端占位（Refine）
packages/shared/   前后端共享的接口契约类型
```

## 3. 技术栈（已锁，别随手升）

NestJS 12 · Prisma 7（`prisma-client` generator）· PostgreSQL 16 · TypeScript 6 · ESM ·
Vitest 4 · oxlint · npm workspaces。

**三个已经踩过的坑，改依赖前先读**：

- `prisma` 的 npm `latest` 现在指向 **8.0.0-rc**。CLI 和 `@prisma/client` 必须**钉同一版本**
  （当前 `7.10.0`）。版本不一致会出现难以定位的生成/运行时错配。
- `.npmrc` 里 `legacy-peer-deps=true` 是**必须的**：npm 10 在解 vitest 的 peer 集时会崩
  （`Cannot read properties of null (reading 'edgesOut')`）。代价是 peer 冲突不再报错，
  所以**动完依赖必须跑一遍 build + test**。
- 不使用 tsconfig path 别名。ESM + tsc 不会重写别名，能编译过、跑起来找不到模块。
  一律用带 `.js` 后缀的相对路径（`import { X } from './x.js'`）。

## 4. 常用命令

```bash
npm install                     # 根目录一次装完；会自动 prisma generate + 构建 shared
npm run db:up                   # 起 Postgres（需要 Docker，端口 5433）
npm run db:down                 # 停库
npm run db:migrate -w @piano/api   # 建/改表后生成迁移
npm run start:dev -w @piano/api    # 开发模式，接口在 http://localhost:3000/api
npm run typecheck -w @piano/api
npm run lint -w @piano/api
npm test -w @piano/api          # 单元测试（不需要数据库）
npm run test:e2e -w @piano/api  # 端到端，**需要库先起来**
```

## 5. 硬规则

| # | 规则 |
|---|---|
| R1 | **`prisma/schema.prisma` 是数据模型的唯一来源。** 禁止在 `packages/shared`、前端或常量文件里再抄一份枚举/实体/状态定义。抄一份就是「同一规则两份实现」，改一处忘一处会静默跑偏。 |
| R2 | **金额一律用 Decimal，禁止 float/double。** 不许用 JS `number` 做金额加减。 |
| R3 | **跨表写必须在一个事务里**（`$transaction`）。唯一性靠数据库约束兜底，不许用「先查再插」——并发下必然漏。 |
| R4 | **业务规则只写在 service。** controller 只做参数绑定和转发，不写业务判断。前端不做业务算术（前端判断能被绕过，且是第二份实现）。 |
| R5 | **时间一律存 UTC**，展示层再转本地时区。直接切 ISO 字符串会差整整一个时区且看不出来。 |
| R6 | 密码只存 bcrypt 哈希。**任何返回用户信息的接口必须走 `PUBLIC_USER_SELECT` 白名单**，不许「查全表再删字段」。 |
| R7 | 需要鉴权的接口**必须同时挂 `JwtAuthGuard` + `RolesGuard`**。只挂 RolesGuard 会让 `@Roles` 形同虚设（默认放行）且不报错。 |
| R8 | **不留假实现。** 没做的、没验的，写进「§8 已知未做」，不许假装完成或用假数据糊过去。 |
| R9 | **新检查必须见过红。** 先让它失败，再让它通过。待查集合不许与被检查的名单同源，否则变异测试会假绿。 |
| R10 | 登录失败对外**只有一句话**（「用户名或密码不正确」），不许区分「用户不存在／密码错／已停用」。 |
| R11 | 500 类错误对外只给通用文案，细节只进日志 —— 别把栈和 SQL 泄露给前端。 |
| R12 | `.env` 不进 git。日志、报错、对话里都禁止出现密钥或完整连接串（要回显目标就只回显 `host:port/db`）。 |
| R13 | 引用了任何历史清单/旧结论前，**逐条复核是否仍然成立**。把上一阶段的状态当现状汇报，就是一句假话。 |

## 6. 禁改清单

- `apps/api/src/generated/**` —— Prisma 生成物，改了下次 `generate` 就没了。
- `apps/api/prisma/migrations/**` 里**已经应用过**的迁移文件。要改表就加新迁移。
- 不要为了「让测试变绿」而把真实数据库换成假数据；测试红是有信息量的。

## 7. 改完必须过的门槛

在 `apps/api` 下依次跑通，三条全绿才能说「做完了」：

```bash
npm run typecheck && npm run lint && npm test
```

碰了数据库或接口的，再加 `npm run test:e2e`（需要 `npm run db:up`）。
汇报时必须区分「我实测过的」和「我没验的」。

## 8. 已知未做（诚实清单）

- **领域模型只有 `User` / `UserRole`。** 那 44 条用户故事还没落成 schema —— 这是下一步的独立任务，
  不要顺手在别处用「临时字段」凑。
- 无 refresh token、无改密流程、无登录失败限流。当前 JWT 有效期 12h，只有 access token。
- 删除策略：用户是**硬删**（`DELETE`）。建业务表时要单独决定——凡是需要追溯的，一律软删。
- `apps/web` 是空目录。前端还没开始。
- 端到端测试（`test/app.e2e-spec.ts`）**尚未在真实 Postgres 上跑通过**。
- `packages/shared` 目前只有分页信封和错误体；前端接进来以后才知道还需要共享什么。
