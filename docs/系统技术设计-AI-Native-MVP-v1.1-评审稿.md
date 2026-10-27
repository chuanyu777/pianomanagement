# 琴行管理系统 AI Native 技术设计（MVP v1.1 评审稿）

> 本文继承《系统技术设计 AI Native（MVP v1.0）》全部未列明内容，仅记录新原型和 v1.1 产品需求的技术调整。  
> 本文是评审稿；未完成的 API、字段和测试不得按已实现汇报。

## 1. Web 路由与可恢复状态

建议统一使用以下结构化路由：

| 路由 | 页面 | 必须可恢复的状态 |
|---|---|---|
| `/` | 工作台 | 当前任务、概览视图 |
| `/structured/students` | 学生与账户 | 搜索、状态筛选、学生 ID、页签、课程账户 ID |
| `/structured/schedule` | 排课与课消 | 周起始日、老师、课程、状态、选中课程 ID |
| `/structured/finance` | 收支与报表 | 月份、页签、老师/分类筛选 |
| `/tasks/:threadId` | 最近任务 | 消息、Run、Workspace、Preview、Receipt |

路由状态不得只存在组件内存。刷新、深链、返回、角色变化和重新登录必须重新鉴权并从 Core 读取领域事实。

## 2. 公开结构化读模型

在 Core Public API 增加面向浏览器的聚合读模型，使用 OpenAPI 生成 Client；不得让前端通过多个接口拼装后自行计算业务指标。至少覆盖：

- 工作台概览：指标、待办、最近业务记录、`asOf` 和来源范围；
- 学生目录/详情、服务端搜索、分页和脱敏联系电话；
- 学生课程账户及流水；
- 完整业务周课表和冲突相关信息；
- 月度经营/现金双口径及差异明细；
- 工资列表/详情；
- 关账检查的阻断项、提醒项、来源记录和检查时间。

公开读模型和 Agent Tool 可以复用 Application Service，但 Controller、鉴权和 DTO 必须分离。所有金额继续以两位小数字符串返回。

## 3. 结构化按钮的 Preview 链路

生产 Web 不得把结构化按钮仅转换为聊天文本，也不得直接调用领域写入 API。统一链路为：

```text
本地类型化表单/选择器
  → 浏览器请求 Core Public Preview
  → actionType + schemaVersion 组件展示 Preview
  → 浏览器携带用户 JWT 调用 Confirm
  → 查询 Receipt 并刷新受影响读模型
  → 可选地向当前任务同步摘要
```

Agent Runtime 仍只能调用 Read/Preview，不能调用 Confirm/Execute。浏览器可调用的 Preview 创建入口已补齐：单节排课、调课、取消、确认上课、手工收支、工资生成/支付、关账/重开关账均经公开 JWT 路由创建 Preview，再由浏览器 Confirm；接口已纳入 OpenAPI、角色校验、幂等、失效和审计链路。

## 4. WorkspaceDocument 扩展

在原 §12.5 白名单中增加：

- `student-detail`；
- `course-account-detail`；
- `weekly-schedule`；
- `finance-comparison`；
- `payroll-detail`；
- `preclose-checklist`；
- `task-history`。

每个组件必须有独立 `schemaVersion`。未知版本只读展示；组件只允许结构化数据、来源 ID 和白名单动作，不允许 HTML、JavaScript、远程组件 URL 或模型生成 React 代码。普通结构化路由优先使用 OpenAPI DTO，不把整个页面强行改为服务端驱动 UI。

## 5. 状态边界

- `activeThreadId` 是全局任务状态，不按四个页面复制聊天数组；
- 路由筛选、分页、选中项和页签是可恢复 UI 状态；
- 余额、课程状态、工资、报表和关账检查是 Core 领域事实，切页、恢复和确认前重新读取；
- Preview/Receipt 以 Core 记录为准，聊天只保存引用和摘要；
- SSE `workspace.patch` 只负责展示更新，不能作为业务事实来源。

## 6. 角色化导航与授权

前端根据 `/api/auth/me` 和能力集合渲染导航、按钮和路由；Core 继续执行 `JwtAuthGuard + RolesGuard + 资源级授权`。老师访问店主路由时，应在加载数据前返回无权限结果；历史任务、Preview、深链和来源记录每次打开都重新校验角色与教师归属。

## 7. 关账读模型

Core 提供确定性的关账检查服务，返回：

- `blockers`：已结束待确认课程、未生成/未支付工资、退款/流水异常等；
- `reminders`：欠费、冻结和其它提示；
- `checkedAt`、业务月份、来源记录；
- 只有规则稳定后才返回准备度百分比。

Web 和 Agent 只展示该结果，不复制阻断判断。关账确认必须再次执行同一检查并在一个事务内校验状态。

## 8. 测试与实施顺序

在原 §17、§18 增加：

1. 四个路由的桌面/平板/手机、深链和刷新 E2E；
2. 店主/老师导航、数据和历史任务隔离；
3. 结构化入口与 AI 入口生成相同 Preview/Receipt 的契约测试；
4. 关账阻断/提醒规则及并发确认测试；
5. 读模型 `asOf`、金额字符串、来源记录和刷新失效测试；
6. 未知 `schemaVersion` 的只读降级测试；
7. 学生联系电话脱敏和同名/同号码消歧测试；
8. 不允许使用原型示例数据替代真实 Core 数据的 smoke 检查。

本轮实施顺序已完成前四项中的业务字段、关账规则、Preview API 和结构化 Web 入口；剩余移动端深链、完整聚合读模型和扩展 Workspace 继续按本清单排期，不以原型静态示例替代真实 Core 数据。
