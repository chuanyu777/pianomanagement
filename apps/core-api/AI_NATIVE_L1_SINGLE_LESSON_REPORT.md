# AI Native L1 单节排课 Preview/Confirm 实施报告

## 已完成

- 内部 `POST /api/internal/assistant-actions/lessons/single/preview` 要求服务间 HMAC 与 `PREVIEW_L1` Capability。Core 根据 Capability 的 `sub` 读取用户角色，校验教师范围，再调用 `LessonsService.previewSingle`。
- Core 持久化规范化排课命令、课程账户版本、教师与冲突快照、5 分钟有效期和 Preview 创建审计。预览不会创建 Lesson。
- 浏览器确认入口 `POST /api/assistant/previews/:previewId/confirm` 只接受 JWT + Roles（店主或教师）并要求 UUID `Idempotency-Key`。确认使用数据库事务锁定 Preview、教师和课程账户；由 LessonsService 复核资源版本、课程时长与时间冲突并创建排课。Lesson、Preview 执行状态和确认审计/回执在同一事务提交。
- 重复确认仅在相同用户、相同确认幂等键下返回原回执；不同确认键、预览过期、资源变化、冲突、错误归属均拒绝。Capability 没有 Confirm/Execute 路由或执行权限。
- Assistant Gateway 签发 `READ + PREVIEW_L1` 的短期运行 Capability；现有 `READ` 仍保留，未添加任何执行权限。

## 验证

- Core 全量测试连接本地 Docker PostgreSQL：42 个测试文件、133 项通过；含 2 项本次新增的真实 PostgreSQL Preview/Confirm 集成测试。
- Core typecheck、lint、build 和 `git diff --check` 均通过。
- 红绿验证：更新 Gateway 权限合同前，Gateway 的 start/resume 权限断言失败；实现 Capability 扩展后通过。真实 PostgreSQL 集成测试还先捕获了确认初次回执与幂等重放回执字段不一致，修复后两项集成测试通过。

## 接口摘要

```text
POST /api/internal/assistant-actions/lessons/single/preview
  Auth: HMAC + Capability(PREVIEW_L1)

POST /api/assistant/previews/:previewId/confirm
  Auth: JWT + Roles(OWNER | TEACHER)
  Header: Idempotency-Key (UUID)
```

本次没有修改数据库 Schema、迁移、生成代码、共享协议、Agent 或 Web。
