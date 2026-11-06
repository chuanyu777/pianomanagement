# 真实模型隔离验证

只运行本目录入口；旧 `ai-retest-environment.mjs` 会清空旧 audit 库，旧 `ai-dialogue-live-audit.mjs` 默认指向开发服务，均不能用于此方案。每次调用生成不可指定的随机 Compose 项目，先检查项目名未被占用，再新建两个无宿主机端口、无持久卷的 tmpfs PostgreSQL 容器。检查 Compose 标签、网络、挂载和空 schema 后，live 才启动应用、迁移和写入合成数据。禁止手动复用该 Compose 文件指向其他数据库。

```sh
node --test tools/isolated-ai-audit/guard.test.mjs
node --test tools/isolated-ai-audit/inventory.test.mjs
node --test tools/isolated-ai-audit/account-assertions.test.mjs
node tools/isolated-ai-audit/run.mjs guard
```

真实模型验证需要先在当前 shell 安全地设置 `AI_MODEL`（`deepseek-chat` 或 `deepseek-reasoner`）和 `AI_API_KEY`，不要把密钥写入命令、历史记录或仓库，然后执行：

```sh
node tools/isolated-ai-audit/run.mjs live
```

live 在新库迁移后创建随机密码临时店主和合成学生、课程、账户及交费；测试模型查询余额、交费 Preview 与确认前余额不变。测试会确认合成学生的建档，不确认 AI 缴费预览。输出只有固定结果代码，不输出模型响应、密码、密钥或连接串。密码经 stdin 送入容器，模型密钥通过环境传递；Docker 守护进程和有权限检查容器环境的本机用户仍能读取容器环境，须使用可信本机环境。镜像构建和容器日志不应另行公开或上传。

意图理解还可单独运行 `npm run build -w @piano/agent-runtime` 后执行 `node apps/agent-runtime/test/multi-step-language-live.mjs`。该检查只向模型发送合成文本，不连接数据库；覆盖单项缴费和建档、查询、多步骤、否定及跨轮代词和课程名称。每次运行只能证明该次有限语句的结果，不能代替隔离业务链路验证。

两个模式均在 finally 根据随机项目标签和服务名清除本次容器和网络，失败时不打印底层错误内容；不会删除卷、镜像或任何其他项目。进程遭 SIGKILL、主机断电或 Docker 不可用时 finally 可能无法完成；若显示 CLEANUP_FAILED，使用打印的项目标识核查并仅清理该项目。tmpfs 数据随容器移除或重启而丢失。模型需要外网，因此 Agent 额外连接出口网络；该网络不构成防火墙，不能防御恶意代码主动访问其他网络地址。本方案固定数据库目标、不给测试任何现存数据库凭据，适用于可信代码及可信 Docker 主机，不应声称网络层面已隔绝所有宿主服务。

`probe-no-key.mjs` 使用明确无效的测试密钥和本机旧 audit 镜像，在容器中覆盖本机构建的 Core、协议与迁移后执行 smoke；它用于核对 Core 实际响应及失败清理，不证明当前 Agent 构建或真实模型验证通过。

2026-11-04 实测 `live`：新建随机隔离项目后，真实模型的余额查询与交费预览通过，Core 权威预览的账户和金额正确，确认前后余额、账本及收款记录不变；测试容器与网络已清理。该次不包含浏览器确认或其他业务流程。

同日后续新增同名学生检查并重新运行 `live`：两位同名学生仅一人有课程账户，选择前工作区不显示账户余额；按候选 ID 选择有账户的学生后读取到该账户余额。再次选择无账户学生时返回未找到账户，未展示另一人的余额，账本保持不变。该验证经真实模型、Core 和 Agent 接口执行，不包含真实浏览器。

随后在新的临时库增加同一学生的两门课程及各自的实收和赠送，用独立 Core 账户结果逐项核对真实模型工作区中的课程名称、实收、赠送、总余额和单价；两门课程的账本在查询前后保持不变。该检查不代表 Q05 的所有表达和完整浏览器验收均已通过。

另以隔离老师账号询问学生课程余额：真实模型与 Core 链路返回无权提示，未展示测试账户 ID、余额或操作预览，两个账户的账本未变化。其他越权表达与跨角色场景尚未完整验收。

## 83 例复用评估

`ai-retest-catalog.mjs` 的独立目录校验和 `ai-retest-*-journeys.mjs` 的部分断言可复用，但现有 runner 和 environment 硬编码旧 Compose、3010/3110/5443，且会 TRUNCATE、直接改历史数据、恢复快照；journey 还会确认、注入故障、重启 Agent 和访问数据库。不能通过改几个端口直接运行。需要新增隔离 adapter，所有 HTTP、SQL、故障注入和重启均绑定本次项目、复核数据库容器身份，并逐条对齐 83 例独立清单；浏览器确认、异常恢复和权限边界要单独覆盖且计入结果。当前只实现两项 smoke，未接入 83 例 runner/journey，也未实现浏览器验收。

`node tools/isolated-ai-audit/inventory.mjs` 用评审稿标题与独立目录交叉核对完整的 83 项，初始状态全部为 `unverified`。当前该清单不读取或保存运行证据；单项测试或 smoke 不会自动升级成整项通过。
