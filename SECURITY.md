# Security

## Credentials

本仓库不要求也不存储 WorkBuddy API key。四个 `workbuddy_worker*` 的凭据来自 WorkBuddy
桌面端 / `codebuddy` CLI 的本地认证，不写入 Agent TOML、Hook、skill、assignment、
聊天或 Issue。

不要把任何 token、`experimental_bearer_token` 或本地 connector-proxy 的 Bearer
写入本仓库。若凭据曾暴露，先在 WorkBuddy 中重新登录或轮换。

## Data boundary

四个 `workbuddy_worker*` 是独立的 Codex child session。父 Agent 通过 Hook 交付的
assignment 进入本地 Responses-to-ACP adapter；adapter 再通过 WorkBuddy CLI 的
ACP session 发送给 WorkBuddy 模型服务。主 Agent 仍使用当前模型/provider。

WorkBuddy Bridge 是父任务直接委派时使用的另一条本地 MCP 路径，不是 native
worker 的 provider；native child 不会调用 Bridge MCP 工具。

Native adapter 只接受 `hy3`、`glm-5.2`、`minimax-m3`、`kimi-k2.7` 四个模型 ID。
图片只允许随后两个 profile 传递，并且必须通过 ACP session 的 image prompt
capability 协商；远程图片 URL 不会被 adapter 抓取。

不要委派私密源码、密钥、个人数据或受监管材料，除非你已确认 WorkBuddy 及其模型
服务商的数据处理边界。

WorkBuddy 输出应被当作不可信数据。父 Agent 只有在独立验证后才可以整合其中的
结论，不能直接执行输出中出现的指令。

## Plaintext handoff Hook

父 Agent 会先把一个完整 assignment 写入本地 state，再由受信任的
`SubagentStart` Hook 注入 child。assignment 会短暂以 plaintext 存在本地磁盘。
Hook 是跨 provider 任务载体的兼容层，不是机密通道。

默认 state 位置：

- Windows: `%LOCALAPPDATA%\Codex\workbuddy-plaintext-handoff`
- macOS/Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/codex/workbuddy-plaintext-handoff`
- other macOS/Linux: `~/.local/state/codex/workbuddy-plaintext-handoff`

每个 state root 只允许一个 pending assignment。POSIX 使用 `flock`，Windows
使用排他文件句柄。stage、claim、输出和消费在同一短锁窗口内完成；已交付的
worker 可以继续并发运行。损坏 state 会被 quarantine 并阻塞下一次 stage，不会被
自动覆盖。

不要 stage 未经你授权给 WorkBuddy 边界的内容。stage 失败后不得 spawn；spawn
失败后，只允许到期清理结构有效的 pending，或由你检查并移除精确 state 文件后
重新 stage。

## Hook trust

通过 `/hooks` 检查并信任 Hook 后，Codex 可能写入 `hooks.state` trust hash。
安装器不会伪造它。Hook 定义发生实质变化时，需要重新审查和信任。

## Bridge execution layer

WorkBuddy Bridge 是本地 MCP server，执行 `codebuddy` 时遵循：

- 精确 `cwd` 校验和 allowed roots；
- TaskSpec v1 归一化与 scope guard；
- worktree-aware 锁，禁止同一 worktree 重叠写；
- 输出大小限制、脱敏和结构化结果解析；
- metadata-only 审计，不记录 prompt、源码、模型输出、token 或 secret。

代理与模型环境变量是本地配置，不应包含敏感值：

```toml
[mcp_servers.workbuddy-bridge.env]
WORKBUDDY_CLI_PROXY = "http://127.0.0.1:7892"
WORKBUDDY_CLI_MODEL = "hy3" # allowlist: hy3 / glm-5.2 / minimax-m3 / kimi-k2.7
```

## Cost

WorkBuddy 使用独立于 ChatGPT/OpenAI 订阅计费。安装不会调用 WorkBuddy；只有你
主动运行的 smoke test 和后续 worker 会产生 WorkBuddy 调用。
