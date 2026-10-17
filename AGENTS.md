# AGENTS.md — 琴行管理系统项目规约

本文件是硬约束。能由类型、数据库约束、测试或脚本表达的规则，不重复写在这里。

## 1. 产品与设计基线

这是全新实现的 AI Native 琴行经营管理系统。冻结需求只有：

- `docs/系统需求设计-V2-MVP-v1.0.md`：确定性业务规则；
- `docs/系统需求设计-AI-Native-MVP-v1.0.md`：AI 产品形态和交互边界；
- `docs/系统技术设计-AI-Native-MVP-v1.0.md`：目标架构和实施顺序。

不得从旧代码反向推导需求。旧实现已保存在 Git 标签 `design-ai-native-mvp-v1.0`，只用于逐条复核后的参考，不复制旧领域模型。

## 2. 目标结构与依赖方向

```text
apps/web/                       React AI 工作台与结构化降级页面
apps/core-api/                  NestJS 确定性业务核心
  prisma/schema.prisma          领域数据模型唯一来源
  src/generated/prisma/         Prisma 生成物，不手改、不进 git
  src/prisma/                   唯一允许接触 Prisma 生成物的目录
  src/common/                   跨模块通用件，禁止依赖 src/modules
  src/modules/<领域>/           controller → service → repository
apps/agent-runtime/             Fastify + LangGraph.js 编排运行时
packages/assistant-protocol/    Workspace、SSE 等非领域传输协议
packages/generated-core-client/由 Core OpenAPI 生成，不手写领域 DTO
```

固定依赖方向：Web → Core；Agent Runtime → Core Internal Read/Preview API；Core controller → service → repository → Prisma。
Agent Runtime 禁止连接 Core 数据库或调用 Confirm/Execute API；Core 禁止持有模型密钥。

## 3. 技术栈

Node.js 24 · TypeScript 6 · ESM · npm workspaces · oxlint · Vitest 4。
Core 使用 NestJS 12、Prisma 7.10.0、PostgreSQL 16；Agent 使用 Fastify、LangChain.js、LangGraph.js 和独立 PostgreSQL；Web 使用 React、Vite、React Router、TanStack Query、Ant Design。

- Prisma CLI、`@prisma/client` 和 adapter 必须固定为同一版本；npm `latest` 指向预发布版时禁止跟随。
- `.npmrc` 的 `legacy-peer-deps=true` 保留；依赖变更后必须跑完整门禁。
- 不使用 tsconfig path alias。ESM 本地相对导入一律写 `.js` 后缀。
- 不提前引入 DeepAgents、Redis、向量数据库、多 Agent 或第二模型供应商。

## 4. 常用命令

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run db:up                    # Core DB 5433，Agent DB 5434
npm run db:down
npm run db:generate
npm run db:migrate
npm run agent:db:migrate
npm run dev:core
npm run dev:agent
npm run dev:web
npm run openapi:export -w @piano/core-api
npm run generate -w @piano/generated-core-client -- \
  --input ../../apps/core-api/openapi.json
npm run agent:checkpoint:setup
```

`npm run agent:checkpoint:setup` 是 Agent PostgreSQL 的官方 LangGraph
`PostgresSaver.setup()` 初始化命令；不要写成 `agent:checkpointer:setup`。

## 5. 硬规则

| # | 规则 |
|---|---|
| R1 | `apps/core-api/prisma/schema.prisma` 是领域数据模型唯一来源。Web、Agent 和传输协议不得抄写领域枚举/实体；使用 OpenAPI 生成 Client。 |
| R2 | 金额只用 Prisma Decimal 运算，对外一律为两位小数字符串；禁止用 JS `number` 做金额运算。 |
| R3 | 跨表写必须在同一 `$transaction`；唯一性靠数据库约束，禁止“先查再插”。 |
| R4 | 业务规则只写在 Core service。Controller、Agent 工具和前端不得重算余额、手续费、工资或报表。 |
| R5 | 时间存 UTC；业务日历按 `Asia/Shanghai` 转换，禁止直接截 ISO 字符串。 |
| R6 | 密码只存 bcrypt 哈希；用户响应必须走 `PUBLIC_USER_SELECT` 白名单。 |
| R7 | Core 公共受限接口同时使用 `JwtAuthGuard` 与 `RolesGuard`；内部工具接口使用短期最小权限 Capability。两套鉴权不得混用或省略。 |
| R8 | 不留假实现。未完成、未实测的内容写入 §8，禁止用演示数据冒充业务实现。 |
| R9 | 新检查必须见过红再变绿；被检查名单和待查集合不得同源。 |
| R10 | 登录失败对外统一为“用户名或密码不正确”。 |
| R11 | 500 错误只返回通用文案，细节仅进脱敏日志。 |
| R12 | `.env` 不进 Git；日志、错误和对话禁止出现密钥或完整连接串。 |
| R13 | 引用历史代码、报告或环境结论前必须重新验证。 |
| R14 | Agent 只能查询和申请 Preview；确认执行必须由浏览器携带用户登录态直接调用 Core。 |

## 6. 禁改清单

- `apps/core-api/src/generated/**`；
- `packages/generated-core-client/src/generated/**`；
- 已应用的 `apps/core-api/prisma/migrations/**`；
- LangGraph checkpointer 官方表结构。

数据库和接口测试不得为了变绿而替换为假数据。

## 7. 完成门槛

所有改动至少通过：

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

涉及数据库、API、Capability、Preview 或资金逻辑时，还要运行对应集成测试、E2E 和业务 smoke。汇报必须明确区分实测与未验证。

## 8. 已知未做

- 当前已从阶段 0 技术 Spike 进入阶段 1 的业务内核，但尚未形成可用业务系统。Core 数据库已有
  `User`、`Teacher`、`Student`、`Course`、`StudentCourseAccount`、`PaymentRecord`、`GiftRecord`、`LedgerEntry`、`Lesson` 及两张
  Spike 表；课程账户的期初金额、交费、赠送、余额查询和一次冲正已实现。单节排课、调课、取消、上课确认及店主撤销确认已实现；
  按周批量排课、退款、工资、收支和关账模型仍未实现。
- `assistant-protocol`、Core Capability、Agent Runtime、Core 内部 Gateway、技术 Preview、
  OpenAPI 导出/生成链路和 Web 工作台骨架已经落地；完整门禁和阶段 0 退出条件仍需以本次实测为准，
  不能据此宣称业务系统已完成。
- Capability 当前只包含 `sub`、`threadId`、`runId`、`jti`、`permissions`、`iat`、`exp`，
  权限为 `READ`、`PREVIEW_L1`、`PREVIEW_L2`；Core 的 `UserRole`、`Teacher` 已落库，但 Capability 尚缺需求/技术设计
  预留的 `role`、`teacherId`。不得在 assistant-protocol 或 Agent 中另写一份角色/老师枚举。
- Core 已实现公开 `POST /api/auth/login`、`GET /api/auth/me`、`JwtAuthGuard`、`RolesGuard` 和店主限定的
  `/api/teachers`、`/api/students`、`/api/courses`、`/api/students/:studentId/course-accounts` 基础接口；课程账户
  创建时使用课程默认价或店主输入的个性化两位小数单价，后续改价递增账户版本。店主限定的课程账户余额、交费、赠送和
  冲正接口使用 `Idempotency-Key`，追加不可变 `LedgerEntry`，并在账户行锁内增加版本；当前仅支持交费/赠送的冲正。
  密码仅存 bcrypt hash，响应统一走 `PUBLIC_USER_SELECT`。没有公开注册；初始店主仅能通过 `auth:bootstrap:owner` 命令
  创建。单节排课、调课、取消、确认上课和店主撤销确认均为公开受限接口；确认上课在账户行锁内固定单价快照、赠送优先扣减并追加不可变流水，
  撤销确认追加反向流水。按周批量排课、退款等业务接口尚未实现。内部工具和技术 Preview 仍同时校验短期 Capability 与带时间戳、nonce 的 HMAC。公开 Assistant
  Gateway Controller 仍未实现，Web 不能创建会话。
- Agent 的 LangGraph `interrupt`/`Command(resume)` 和官方 `PostgresSaver` 已有真实 PostgreSQL
  集成测试。HTTP Run/Event 持久化的 SQL migration、repository 和运行时接线已经出现在代码中，
  基础 typecheck、server 测试、数据库 migration，以及“实例 A 的 Run 进入 `waiting_for_input` 后正常关闭，
  由实例 B 恢复 Run/Events 历史并 Resume”的真实 PostgreSQL 集成测试已通过。当前 Events 接口只回放
  持久化历史后保持连接，并通过进程内有界事件 Hub 推送本实例的新事件；支持心跳、客户端断开清理、终态
  关闭和 `Last-Event-ID` 补读。实时广播不跨 Agent 实例；完成跨实例通知前，MVP 部署必须保持单 Agent 实例，
  跨实例恢复只保证重连后从 PostgreSQL 补读。
- Agent Run 租约 migration 与 PostgreSQL 原子 claim/renew/release/requeue repository 已有真实并发测试，
  租约 owner 也会通过行锁 fencing 状态、消息和事件写入，Run 状态与对应事件在同一事务提交，终态清空
  租约；但尚未接入执行 worker、续租心跳和启动回收流程，因此进程在图执行期间崩溃后，`running` Run
  仍不会自动恢复。当前 HTTP inline 路径创建的 `running` Run 不持有租约，claim API 不会接管它们，以免
  抢占仍在执行的请求；切换到 worker 前必须补一次显式状态对账/迁移。
- 当前技术 Preview 只在 Core 事务中记录一个不落业务数据的 Preview 和审计事件，没有
  Confirm、Execute 或 Receipt；直接 Core API 的交费、赠送和课消写入不等同于 AI Preview/Confirm 链路。并发幂等集成测试覆盖的是这个技术 Preview，不能替代业务验收。
- Web 当前为产品骨架；`/api/assistant/status` 已接通 Core 数据库和 Agent 健康探测，但会话、Run 与业务操作
  仍未接通。不得添加演示业务数据冒充已完成。
- 服务间 HMAC 的 nonce 防重放缓存由 Core 和 Agent 各自的单进程内存实现；同一实例可拒绝重放，但不能
  在多实例间共享，进程重启后也会丢失缓存。生产环境需改为共享或持久化 nonce 存储。
- 服务间 HMAC 同时绑定请求体、Bearer Authorization、`x-assistant-capability` 和 `Last-Event-ID`；
  该签名格式不向后兼容，Core 与 Agent 必须同步部署。
- Core Gateway 当前只为已实现的只读图签发 `READ` 权限；协议和 Core Capability 虽预留
  `PREVIEW_L1`、`PREVIEW_L2`，公开 Gateway 尚未提供对应调用链。
- Agent 默认 `AI_ENABLED=false`，首期模型供应商、模型、数据区域、保留条款和 Live Model 验证方案仍需确认；
  无密钥的默认安装、测试和构建不得调用 Live Model。
- 2026-10-17 阶段 0/1 对账已实测完整 typecheck/lint/test/build、Agent Runtime migration、PostgresSaver 初始化、
  带本地数据库配置的 Agent 27/27 与 Core 69/69 测试，以及 OpenAPI 导出/Client 生成；Core、Agent、Web 也已在本机 Docker 双数据库上完成启动与健康探测。Agent 进程重启后
  Run/Event 历史、实时 SSE、重复 Resume 幂等、并发 Resume 原子抢占、租约 fencing 与签名头篡改拒绝
  也有专门测试。
