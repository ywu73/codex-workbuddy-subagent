# codex-workbuddy-subagent

让 Codex 主任务继续使用当前模型/provider，同时把 WorkBuddy `codebuddy` CLI 当作原生 subagent，用于边界明确的本地分析或已经确认的受限文件编辑。本仓库复用 `codex-deepseek-subagent` 的原生 child + one-shot Hook 架构，并保留 WorkBuddy Bridge 1.0.1 作为执行层。

`workbuddy_worker` 是 Codex 原生 child，通过受信任的 `SubagentStart` Hook 接收父 Agent 的一次性 plaintext assignment，再调用 WorkBuddy Bridge MCP 工具执行 `plan` 或已确认的 `execute`。

当前默认模型为 `hy3`。

## 三步安装

### 1. 准备 WorkBuddy

确保 macOS 上已安装 WorkBuddy，`codebuddy` CLI 可用且已登录。本仓库通过 WorkBuddy Bridge 调用 CLI，不直接操作 WorkBuddy GUI。

如果 CLI 所在网络需要代理，在 MCP server 配置中设置：

```toml
[mcp_servers.workbuddy-bridge.env]
WORKBUDDY_CLI_PROXY = "http://127.0.0.1:7892"
WORKBUDDY_CLI_MODEL = "hy3"
```

`WORKBUDDY_CLI_PROXY` 让 CLI 通过代理下载内置 marketplace 包，避免直连 16MB 下载卡死启动流程；`WORKBUDDY_CLI_MODEL` 显式指定模型，避免默认 `auto` 被模型 API 拒绝。

### 2. 让 Codex 安装 subagent

把 [prompts/install-with-codex.md](prompts/install-with-codex.md) 交给 Codex 执行。安装会新增：

- `<codex-home>/agents/workbuddy-worker.toml`
- `<codex-home>/skills/use-workbuddy-worker/`
- `<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py`
- 一条 `SubagentStart` Hook，matcher 为 `^workbuddy_worker$`
- 个人 `AGENTS.md` 中带 marker 的 `$use-workbuddy-worker` 索引

同时需要先安装 WorkBuddy Bridge MCP 插件，并确保 `[mcp_servers.workbuddy-bridge]` 指向本仓库的 `mcp-server/dist/src/server.js`。

### 3. 信任 Hook 并测试

1. 在 Codex 输入 `/hooks`，确认它只匹配 `workbuddy_worker`，命令指向刚安装的 `plaintext_handoff.py`，然后信任。
2. 新开一个 Codex 任务。
3. 把 [prompts/quick-smoke-test.md](prompts/quick-smoke-test.md) 交给新任务。

## 怎样算成功

快速测试应同时满足：

- Codex 暴露独立原生 child，agent type 为 `workbuddy_worker`；
- child 返回父 Agent 的随机 marker；
- child 通过 bridge 完成一次只读 `workbuddy_plan`；
- 一次性 pending handoff 已被消费；
- 主任务仍使用原来的模型/provider；
- 没有另起 CLI、直连 API 或换模型冒充成功。

## 文件边界

- `agents/workbuddy-worker.toml`：child session 配置。
- `skills/use-workbuddy-worker/SKILL.md`：父 Agent 按需加载的委派协议。
- `hooks/plaintext_handoff.py`：stage 与 `SubagentStart` Hook。
- `mcp-server/`：WorkBuddy Bridge 执行层，负责调用 `codebuddy`、scope guard、审计和审批。
- `snippets/AGENTS.md`：父 Agent skill 索引。

完整说明见 [SECURITY.md](SECURITY.md)、[docs/advanced.md](docs/advanced.md) 和 [docs/design.md](docs/design.md)。

## 验证

```sh
cd mcp-server
npm install
npm run typecheck
npm test
python3 -m unittest tests.test_plaintext_handoff
```

MIT。
