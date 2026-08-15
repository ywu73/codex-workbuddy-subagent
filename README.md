# codex-workbuddy-subagent

让 Codex 主任务继续使用当前模型/provider，同时把 WorkBuddy `codebuddy` CLI 通过本地 Responses-to-ACP adapter 作为四个可选的原生 worker 使用，用于边界明确的本地分析或已经确认的受限文件编辑。本仓库复用原生 child + one-shot Hook 架构，并将 WorkBuddy Bridge 作为父任务直接委派的独立 MCP 能力保留。

四个 `workbuddy_worker*` agent type 都是 Codex 原生 child，通过受信任的 `SubagentStart` Hook 接收父 Agent 的一次性 plaintext assignment；每个 standalone TOML 固定一个模型，provider 指向本地 adapter，由 adapter 启动 WorkBuddy ACP/CLI 完成任务。

当前默认模型为 `hy3`，可选模型为 `hy3`、`glm-5.2`、`minimax-m3`、`kimi-k2.7`；其中后两个 profile 允许在 ACP capability negotiation 成功后传递图片。native adapter 默认监听 `127.0.0.1:17891`。

## 三步安装

### 1. 准备 WorkBuddy

确保 macOS 上已安装 WorkBuddy，`codebuddy` CLI 可用且已登录。本仓库通过本地 native adapter 调用 WorkBuddy CLI，不直接操作 WorkBuddy GUI。

如果 WorkBuddy CLI 所在网络需要代理，在启动 native adapter 的 shell 环境中设置；若父任务也使用 Bridge，则在 Bridge 的环境中设置：

```sh
export WORKBUDDY_CLI_MODEL="hy3" # 可选：hy3 / glm-5.2 / minimax-m3 / kimi-k2.7
export WORKBUDDY_CLI_PROXY="http://127.0.0.1:7892" # 可选
```

Bridge 配置对应为：

```toml
[mcp_servers.workbuddy-bridge.env]
WORKBUDDY_CLI_MODEL = "hy3" # 可选：hy3 / glm-5.2 / minimax-m3 / kimi-k2.7
WORKBUDDY_CLI_PROXY = "http://127.0.0.1:7892" # 可选
```

`WORKBUDDY_CLI_PROXY` 只是 CLI 的可选网络代理，不是 native provider 地址；`WORKBUDDY_CLI_MODEL` 只作为 native adapter 启动时的默认模型，单次 Responses 请求也可以通过 `model` 选择四个 allowlisted ID。

启动 native adapter：

```sh
cd mcp-server
npm install
npm run build
WORKBUDDY_NATIVE_CWD="/absolute/path/to/target" npm run native-adapter
```

adapter 提供 `http://127.0.0.1:17891/v1/responses` 和 `/healthz`，内部通过 `codebuddy --acp --acp-transport stdio` 调用 WorkBuddy。

### 2. 让 Codex 安装 subagent

把 [prompts/install-with-codex.md](prompts/install-with-codex.md) 交给 Codex 执行。安装会新增：

- `<codex-home>/agents/workbuddy-worker*.toml`（四个模型绑定的 agent 文件）
- `<codex-home>/skills/use-workbuddy-worker/`
- `<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py`
- 四个独立 agent TOML，分别绑定 `hy3`、`glm-5.2`、`minimax-m3`、`kimi-k2.7`
- 一条 `SubagentStart` Hook，matcher 覆盖四个 `workbuddy_worker*` agent type
- 一个 `workbuddy-worker-routing.json` 和 resolver，用于主 Agent 显式选择 profile/model
- 个人 `AGENTS.md` 中带 marker 的 `$use-workbuddy-worker` 索引

如果还要让父任务直接调用 `workbuddy_plan` 或 `workbuddy_execute`，再安装 WorkBuddy Bridge MCP 插件，并确保 `[mcp_servers.workbuddy-bridge]` 指向本仓库的 `mcp-server/dist/src/server.js`；这不是 native worker 的 provider。

### 3. 信任 Hook 并测试

1. 在 Codex 输入 `/hooks`，确认它只匹配四个 `workbuddy_worker*` 类型，命令指向刚安装的 `plaintext_handoff.py`，然后信任。
2. 新开一个 Codex 任务。
3. 把 [prompts/quick-smoke-test.md](prompts/quick-smoke-test.md) 交给新任务。

## 怎样算成功

Native 快速测试应同时满足：

- Codex 暴露独立原生 child，agent type 与 resolver 返回值一致；
- child 返回父 Agent 的随机 marker；
- child 的 provider 请求进入本地 WorkBuddy adapter；
- adapter 通过 ACP 启动 WorkBuddy，并返回 marker；
- 请求的 `model` 与返回的 Responses `model` 保持一致；
- 一次性 pending handoff 已被消费；
- 主任务仍使用原来的模型/provider；
- 不依赖 OpenCode、CC Switch 或 15721；
- 目标仓库没有修改。

## 文件边界

- `agents/workbuddy-worker.toml`：child session 配置。
- `skills/use-workbuddy-worker/SKILL.md`：父 Agent 按需加载的委派协议。
- `hooks/plaintext_handoff.py`：stage 与 `SubagentStart` Hook。
- `mcp-server/src/native-provider.ts`：Responses-to-ACP native provider adapter。
- `mcp-server/`：WorkBuddy Bridge 执行层，负责父任务直接委派时的 CLI、scope guard、审计和审批。
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
