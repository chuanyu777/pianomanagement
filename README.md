# 琴行管理系统

前后端同仓。新系统以本仓库 `docs/` 中已经冻结的业务需求、AI Native 产品需求和目标技术设计为实施基线。

| 目录 | 内容 |
|---|---|
| `apps/api` | NestJS + Prisma + PostgreSQL 后端 |
| `apps/web` | React + Refine + Ant Design 前端 |
| `packages/shared` | 前后端共享的接口契约类型 |

## 目标设计

- [系统需求设计 V2（MVP v1.0）](./docs/系统需求设计-V2-MVP-v1.0.md)：已冻结的业务需求基线，聚焦按课程金额账户、排课、课消、退款、工资和经营报表。
- [AI Native 产品需求设计（MVP v1.0）](./docs/系统需求设计-AI-Native-MVP-v1.0.md)：已冻结归档；定义 AI 主入口、对话执行协议、风险确认、业务场景和验收标准。
- [AI Native 技术设计（MVP v1.0）](./docs/系统技术设计-AI-Native-MVP-v1.0.md)：独立 Agent Runtime、确定性业务核心、LangGraph 编排、预览确认、目标数据模型和分阶段实施方案。

## 现状参考

- [系统需求设计](./docs/系统需求设计.md)：产品范围、角色权限、业务规则、流程、验收口径与当前交付缺口。
- [系统技术设计](./docs/系统技术设计.md)：架构、数据模型、接口、事务、安全、测试、部署与技术债。

原《系统需求设计》和《系统技术设计》只用于理解仓库现状，不是新系统的目标设计基线。

## 交互原型

- [需求设计 V2（MVP v1.0）结构化后台原型](https://piano-mvp-v1-prototype.elvenrain2.chatgpt.site)：侧边导航、表格、日历和业务弹窗为主要交互。
- [AI Native 经营助手原型 V1](https://piano-ai-native-prototype.elvenrain2.chatgpt.site)：第一版 AI 对话主入口方案，保留用于设计对比。
- [AI Native 经营中枢原型 V2](https://piano-ai-native-v2-prototype.elvenrain2.chatgpt.site)：按最新技术设计重做，突出 AI 理解、业务核心计算、用户确认执行三层边界及 AI 降级入口。

两套原型均使用演示数据，只用于产品评审，不连接真实业务后端。

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
