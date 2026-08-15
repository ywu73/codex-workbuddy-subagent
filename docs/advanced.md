[English](advanced.en.md)

# 高级说明

## 组合边界

Codex 主任务保持当前模型、provider 和登录不变。四个 `workbuddy_worker*` 是 Codex 原生
管理的独立 child，通过受信任的 `SubagentStart` Hook 接收父 Agent 的一次性
plaintext assignment。child 的 provider 指向本地 Responses-to-ACP adapter，
由 adapter 启动 WorkBuddy `codebuddy` CLI 执行实际任务。

WorkBuddy Bridge 是另一条父任务直接委派的 MCP 路径，不是 native worker 的
provider。native adapter 负责 Responses 与 ACP 的协议转换；Bridge 继续提供
scope guard、worktree 锁、审计、审批、持久任务和 batch 等父任务能力。

## 为什么需要 Hook

Multi-agent V2 的理想语义是父 Agent 在 `spawn_agent.message` 中给 child 一个
自洽任务。当前跨 provider 路径可能把 collaboration 参数生成为
provider-internal ciphertext，child 看不到 `Payload:`。本仓库用受信任
`SubagentStart` Hook 把 assignment 以 developer context 注入 child，避免跨
provider 表示问题，也保证一次任务只交付一次。

## 一次任务流程

1. 父 Agent 形成完整、自洽的 assignment，包含 `operation`、精确 `cwd`、
   `task_spec`、scope、marker 和输出合同。
2. 通过 resolver 选择 profile/model，并通过 stdin stage 到单槽本地 state。
3. 以唯一 task name、与 stage 返回值完全一致的 agent type 和 `fork_turns="none"` 创建 child。
4. 受信任 Hook 原子 claim，并通过 additionalContext 注入 assignment。
5. native provider adapter 启动 `codebuddy --acp --acp-transport stdio`。
6. adapter 将 WorkBuddy ACP 结果转换成 Responses 结果。
7. child 通过 Codex 原生 callback 返回，父 Agent 独立验证后整合。

## Agent 配置

四个 `agents/workbuddy-worker*.toml` 分别定义：

- agent types: `workbuddy_worker`、`workbuddy_worker_glm52`、`workbuddy_worker_minimax_m3`、`workbuddy_worker_kimi_k27`
- provider: `workbuddy_local`
- models: `hy3`、`glm-5.2`、`minimax-m3`、`kimi-k2.7`
- base_url: `http://127.0.0.1:17891/v1`
- sandbox_mode: `read-only`
- model_context_window: `1000000`

native worker 当前只支持只读 plan；明确授权的写操作仍走独立的 Bridge execute
路径，受 Bridge scope guard 控制。

## Bridge 执行层

`mcp-server/` 是 WorkBuddy Bridge 1.0.1：

- `workbuddy_health`：CLI 能力、版本一致性、持久化与限制；
- `workbuddy_plan`：只读 foreground 分析；
- `workbuddy_execute`：已确认的 foreground 编辑，带 scope 证据；
- `workbuddy_plan_start` / `workbuddy_execute_prepare` / `workbuddy_execute_start`：
  持久后台任务与审批 token；
- `workbuddy_batch_start` / `workbuddy_task_status` / `workbuddy_batch_status` /
  `workbuddy_task_cancel`：batch、事件游标与取消。

## 文件映射

| 路径 | 用途 |
| --- | --- |
| `agents/workbuddy-worker.toml` | Codex custom agent |
| `agents/workbuddy-worker-glm52.toml` / `workbuddy-worker-minimax-m3.toml` / `workbuddy-worker-kimi-k27.toml` | 其他模型绑定的 Codex custom agents |
| `config/workbuddy-worker-routing.json` / `scripts/resolve-worker.mjs` | profile、模型与 task alias 路由 |
| `skills/use-workbuddy-worker/SKILL.md` | 父 Agent 按需加载的委派协议 |
| `hooks/plaintext_handoff.py` | POSIX stage/Hook 脚本 |
| `hooks/hooks.posix.example.json` | Hook 结构模板 |
| `snippets/AGENTS.md` | 父 Agent skill 索引 |
| `mcp-server/src/native-provider.ts` | Responses-to-ACP native provider adapter |
| `mcp-server/` | WorkBuddy Bridge 执行层与 CLI 适配 |
| `prompts/install-with-codex.md` | 安装合同 |
| `prompts/quick-smoke-test.md` | 无 checkout 的快速 smoke |
| `prompts/smoke-test.md` | 仓库内 fixture smoke |
| `tests/test_plaintext_handoff.py` | Hook 协议测试 |

## 验证矩阵

| 层级 | 验证 | 通过条件 |
| --- | --- | --- |
| Hook 协议 | `python3 -m unittest tests.test_plaintext_handoff` | Hook、agent type 选择与错配隔离测试通过 |
| Bridge | `cd mcp-server && npm run typecheck && npm test` | 构建、typecheck 与测试通过 |
| STDIO | `npm run test:stdio` | MCP server 启动并返回 health |
| Native smoke | 新任务执行 `quick-smoke-test.md` | marker、child identity、adapter/ACP 成功、handoff 消费 |
| 安装校验 | `node scripts/validate-installation.mjs` | agent、skill、hook、bridge 配置就绪 |

## 已知限制与未来项

- 当前模型 allowlist 为 `hy3`、`glm-5.2`、`minimax-m3`、`kimi-k2.7`，默认 `hy3`；可通过 resolver 或单次 Responses `model` 选择。
- `minimax-m3` 与 `kimi-k2.7` 的图片请求必须同时满足模型 allowlist 和 ACP initialize 返回的 image prompt capability；adapter 不抓取远程图片 URL。
- WorkBuddy CLI 启动时会下载内置 marketplace；网络受限时需要通过
  `WORKBUDDY_CLI_PROXY` 走代理，否则启动可能长时间卡住。
- WorkBuddy CLI 默认 `auto` 模型在当前 API 上返回 `400 invalid parameter value`，
  因此 bridge 总是显式传 `--model`。
- Windows Hook 脚本已包含，但本仓库只在本机 macOS/POSIX 验证。
- native adapter 默认监听 `127.0.0.1:17891`；Hook 会在目标 child 启动前自动探测并按需拉起它，也可以手动预启动。
- native worker 当前固定为 `plan + Read`；写操作不通过 native provider 暗中放开。

## 参考

- [codex-deepseek-subagent](https://github.com/Utopia-V/codex-deepseek-subagent)
- [codex-opencode-agent](https://github.com/ywu73/codex-opencode-subagent)
