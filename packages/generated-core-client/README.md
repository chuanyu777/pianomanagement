# `@piano/generated-core-client`

这个包只负责把 Core 导出的 OpenAPI 规范转换为 TypeScript 类型，并提供一个使用生成类型的 `openapi-fetch` 客户端工厂。
它不包含领域 DTO、枚举、示例 schema 或从旧代码复制的接口定义。

## 生成流程

生成流程的输入必须来自 Core 的 OpenAPI 导出。主流程应先在 `apps/core-api` 生成规范，例如：

```bash
# 由 Core 提供并维护的导出命令（具体命令以 Core 实现为准）
npm run openapi:export -w @piano/core-api

# 在本包中生成，不提交生成物
npm run generate -w @piano/generated-core-client -- \
  --input ../../apps/core-api/openapi.json
```

如果没有 `openapi.json`，生成命令会以非零状态明确失败，并提示先由 Core 导出规范。不要创建临时 schema 让生成流程“通过”。

默认输出位置是 `src/generated/core-api.ts`。`src/generated/` 和包内 `openapi.json` 都已忽略；它们必须由生成流程产生，不能手工编辑或提交。

## 在调用方使用生成类型

生成完成后，调用方可以直接导入生成模块，并把它传给通用客户端工厂：

```ts
import createClient from 'openapi-fetch';
import type { paths } from '@piano/generated-core-client/generated/core-api.js';

const core = createClient<paths>({ baseUrl: process.env.CORE_API_URL });
```

应用层不得在 `packages/generated-core-client` 或其他包中另写 Core 领域 DTO/枚举。若 Core 的接口发生变化，应重新导出规范并重新生成。

## 本包门禁

```bash
npm run typecheck -w @piano/generated-core-client
npm run lint -w @piano/generated-core-client
npm test -w @piano/generated-core-client
npm run build -w @piano/generated-core-client
```

这些检查验证生成工具和通用客户端工厂；没有 Core 规范时不会伪造业务类型。真实生成链路还必须在 Core 完成 OpenAPI 导出后执行。

## 主流程集成步骤

主代理需要在根工作区执行以下集成动作：

1. 将本包加入根 workspace（当前根 `workspaces` 已使用 `packages/*`，无需额外路径声明）。
2. 安装本包声明的依赖：`openapi-fetch@0.15.0` 与开发依赖 `openapi-typescript@7.13.0`；这会更新根 `package-lock.json`，本包自身不修改根锁文件。
3. 在 Core 实现并固定 OpenAPI 导出命令，输出 `apps/core-api/openapi.json` 或通过 `--input` 传入其他明确路径。
4. 在 Core 构建后先导出规范，再执行本包 `generate`，最后运行 workspace 的 typecheck、lint、test、build。
5. 将生成步骤接入主流程 CI；若规范不存在，CI 应保留生成失败，不得用 fixture schema 绕过。
