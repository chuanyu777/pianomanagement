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

阶段 0 已完成一组可运行的技术 Spike：双 PostgreSQL、Core Prisma 初始迁移、LangGraph
`PostgresSaver` 初始化、Capability 骨架、内部只读工具、技术 Preview、SSE 协议、Core OpenAPI
导出/生成链路和 Web AI 工作台骨架。阶段 1 已开始：Core 已具备店主/老师账号、bcrypt 登录、JWT、角色 Guard、
店主创建老师接口，以及学生、课程、学生课程账户的数据模型。它仍不是可用业务系统：基础资料和课程账户尚未提供
业务操作，金额流水、排课、Confirm/Execute/Receipt 和真实 AI 调用也仍未完成；Agent HTTP Run/Event 已有 SQL migration、repository 和运行时接线，
真实 PostgreSQL 测试验证了 Run 进入 `waiting_for_input` 后正常关闭旧实例，再由新实例恢复历史并 Resume。
当前 Events 接口可在历史补发后持续推送本实例事件，并支持心跳、断开清理和 `Last-Event-ID`；跨实例需重连
后从 PostgreSQL 补读。租约数据层已经实现，但执行 worker、续租心跳、崩溃自动恢复和公开 Gateway 仍未完成，
因此这不代表完整业务系统已完成。

精确的环境变量名、启动顺序、已实测项和待验收项见
[`docs/阶段0-开发运行手册.md`](./docs/阶段0-开发运行手册.md)。

## 快速开始

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
成功后从环境中移除这两个 bootstrap 变量。然后执行
`npm run agent:checkpoint:setup` 初始化 Agent PostgreSQL 的官方检查点表。

当前探活路径为 Core 的 `GET http://localhost:3000/api/health`、助手聚合状态
`GET http://localhost:3000/api/assistant/status` 和 Agent 的 `GET http://localhost:3100/health`。
浏览器可通过 Core 的 `POST /api/auth/login` 登录，但尚不能创建 Assistant Run；Web 目前只接通聚合状态检查与结构化降级入口。

## 约定

**动手前先读 [`AGENTS.md`](./AGENTS.md)。** 里面的硬规则、禁改清单和「已知未做」是这个仓库的约束，
每次 agent 运行都会被自动加载。
