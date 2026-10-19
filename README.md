# 琴行管理系统

前后端同仓。新系统以本仓库 `docs/` 中已经冻结的业务需求、AI Native 产品需求和目标技术设计为实施基线。

| 目录 | 内容 |
|---|---|
| `apps/core-api` | NestJS + Prisma 确定性业务核心；独占 Core PostgreSQL |
| `apps/agent-runtime` | Fastify + LangGraph.js 编排运行时；独占 Agent PostgreSQL |
| `apps/web` | React AI 工作台与结构化降级页面 |
| `packages/assistant-protocol` | Workspace、SSE 等非领域传输协议 |
| `packages/generated-core-client` | 由 Core OpenAPI 生成的类型化 Client；当前覆盖 Spike 与账号/老师基础接口 |

## 目标设计

- [系统需求设计 V2（MVP v1.0）](./docs/系统需求设计-V2-MVP-v1.0.md)：已冻结的业务需求基线，聚焦按课程金额账户、排课、课消、退款、工资和经营报表。
- [AI Native 产品需求设计（MVP v1.0）](./docs/系统需求设计-AI-Native-MVP-v1.0.md)：已冻结归档；定义 AI 主入口、对话执行协议、风险确认、业务场景和验收标准。
- [AI Native 技术设计（MVP v1.0）](./docs/系统技术设计-AI-Native-MVP-v1.0.md)：独立 Agent Runtime、确定性业务核心、LangGraph 编排、预览确认、目标数据模型和分阶段实施方案。

## 历史资料（非业务基线）

- [系统需求设计](./docs/系统需求设计.md)：产品范围、角色权限、业务规则、流程、验收口径与当前交付缺口。
- [系统技术设计](./docs/系统技术设计.md)：架构、数据模型、接口、事务、安全、测试、部署与技术债。

原《系统需求设计》和《系统技术设计》以及历史实施计划只用于逐条复核历史背景，不得作为新系统业务基线。
新系统唯一业务基线是上面列出的两份冻结需求；目标架构和实施边界以冻结的 AI Native 技术设计为准。
旧实现保存在 Git 标签 `design-ai-native-mvp-v1.0`，当前分支不从旧代码演进。

## 交互原型

- [需求设计 V2（MVP v1.0）结构化后台原型](https://piano-mvp-v1-prototype.elvenrain2.chatgpt.site)：侧边导航、表格、日历和业务弹窗为主要交互。
- [AI Native 经营助手原型 V1](https://piano-ai-native-prototype.elvenrain2.chatgpt.site)：第一版 AI 对话主入口方案，保留用于设计对比。
- [AI Native 经营中枢原型 V2](https://piano-ai-native-v2-prototype.elvenrain2.chatgpt.site)：按最新技术设计重做，突出 AI 理解、业务核心计算、用户确认执行三层边界及 AI 降级入口。

三套原型均使用演示数据，只用于产品评审，不连接真实业务后端。

## 当前状态

阶段 0 基础设施和当前 MVP 业务链路已经可以运行：双 PostgreSQL、Core Prisma 迁移、LangGraph
`PostgresSaver`、Capability、内部只读工具、公开 Assistant Gateway、SSE、Core OpenAPI 导出/生成链路和
Web AI 工作台均已落地。Core 已具备店主/老师账号、JWT/角色鉴权、学生、课程、课程账户、交费、赠送、单节/批量排课、
调课、请假、课消、退款、工资、手工收支、关账/重开和月度报表；业务 Preview/Confirm 已覆盖排课、交费、赠送和最终退费，
Confirm 由浏览器携带用户登录态直接调用 Core。

Agent 的 HTTP Start 只创建 `queued` Run，Run Worker 负责领取、执行、续租、过期回收和带租约 fencing 的终态写入；
Web 已接通登录、Assistant Run、SSE、Workspace 和 Preview 确认，并提供学生、排课、月度报表结构化页面。
Compose 已包含 Core、Agent、Web 和两套 PostgreSQL，Agent 默认启用 Worker、关闭 Live Model。

当前仍需单独验收或建设：Capability 的 `role`/`teacherId`、跨 Agent 实例实时广播、共享/持久化 nonce 防重放、完整浏览器/HTTP
业务 smoke、真实 Live Model 验收，以及生产部署、密钥轮换和限流等非 MVP 能力。退款、工资、手工收支、关账和 Preview/Confirm
虽已有代码与测试，但本次文档同步不把跳过的真实 PostgreSQL 集成测试或未执行的浏览器 E2E 计为全部验收通过。

精确的环境变量名、启动顺序、已实测项和待验收项见
[`docs/阶段0-开发运行手册.md`](./docs/阶段0-开发运行手册.md)。

## 快速开始

### 完整本地 Docker 测试环境

需要 Docker Compose 和可访问 npm 镜像源。仓库根目录执行：

```bash
npm run docker:up
docker compose ps
```

Compose 会构建并启动 Core、Agent Runtime、Web 和两套 PostgreSQL。Core 等待 Core PostgreSQL 健康后自动执行 `prisma migrate deploy` 再启动；Agent 等待自己的 PostgreSQL 和 Core 健康后，依次执行 Agent Runtime SQL migration、官方 `PostgresSaver.setup()`，启动 Run Worker 后再提供服务。Web 由 Nginx 提供静态页面，并将 `/api/*` 请求转发到 Core。

服务就绪后：

- Web：<http://localhost:5173>
- Core 健康检查：<http://localhost:3000/api/health>
- Core API 文档：<http://localhost:3000/api/docs>
- Agent 健康检查：<http://localhost:3100/health>
- Core PostgreSQL：`localhost:5433`（数据库 `piano_core`）
- Agent PostgreSQL：`localhost:5434`（数据库 `piano_agent`）

本地首次创建店主账号（密码至少 12 位）：

```bash
printf '店主用户名: '
IFS= read -r OWNER_BOOTSTRAP_USERNAME
printf '店主密码（输入不回显）: '
IFS= read -rs OWNER_BOOTSTRAP_PASSWORD
printf '\n'
export OWNER_BOOTSTRAP_USERNAME OWNER_BOOTSTRAP_PASSWORD
docker compose exec \
  -e OWNER_BOOTSTRAP_USERNAME \
  -e OWNER_BOOTSTRAP_PASSWORD \
  core npm run auth:bootstrap:owner -w @piano/core-api
unset OWNER_BOOTSTRAP_USERNAME OWNER_BOOTSTRAP_PASSWORD
```

按提示输入用户名和至少 12 位密码。店主创建成功后，打开 <http://localhost:3000/api/docs>，调用 `POST /api/auth/login` 获取 `accessToken`，再通过 Swagger `Authorize`（如当前页面提供）调用 `GET /api/auth/me` 和店主受限接口；完整操作步骤见[阶段 0 开发运行手册](docs/阶段0-开发运行手册.md#swagger-登录与受限接口测试)。用户名已存在表示数据库中已有该账号。以上数据库密码、JWT/HMAC 密钥均为 Compose 内的本地开发值，只用于隔离的本机测试，不得用于共享、预发布或生产环境。每次 Core 容器启动会生成临时 Ed25519 Capability 私钥。AI 默认关闭，不需要模型密钥。

查看日志或停止容器：

```bash
npm run docker:logs
npm run docker:down
```

`docker:down` 会保留 PostgreSQL 数据卷；需要删除数据卷时，需明确执行 `docker compose down --volumes`。

### 不使用 Docker 的本机开发

```bash
npm install
npm run db:up       # Core DB 5433，Agent DB 5434
npm run db:generate
npm run db:migrate
npm run agent:db:migrate
npm run agent:checkpoint:setup
npm run check
```

首次启动前请按运行手册复制并填写 `apps/core-api/.env.example` 和
`apps/agent-runtime/.env.example`；Core 的 Capability 私钥变量名是
`CAPABILITY_SIGNING_PRIVATE_KEY_B64`，且必须设置独立的 `JWT_SIGNING_SECRET`。首次初始化店主时，临时设置
`OWNER_BOOTSTRAP_USERNAME` 与 `OWNER_BOOTSTRAP_PASSWORD`，执行 `npm run auth:bootstrap:owner -w @piano/core-api`，
成功后从环境中移除这两个 bootstrap 变量。Docker 启动流程会自动执行上述 Core/Agent 数据库初始化步骤；本机开发需手动完成。

当前探活路径为 Core 的 `GET http://localhost:3000/api/health`、助手聚合状态
`GET http://localhost:3000/api/assistant/status` 和 Agent 的 `GET http://localhost:3100/health`。
浏览器可通过 Core 的 `POST /api/auth/login` 登录，并通过公开 Gateway 创建 Assistant Run、订阅 SSE；写入类动作仍须在 Workspace 中确认后由浏览器直接调用 Core。Web 的结构化页面与 AI 工作台都读取真实 API，不使用演示业务数据。

## 约定

**动手前先读 [`AGENTS.md`](./AGENTS.md)。** 里面的硬规则、禁改清单和「已知未做」是这个仓库的约束，
每次 agent 运行都会被自动加载。
