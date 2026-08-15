# Advanced notes

## Composition boundary

The Codex main task keeps its current model, provider, and login. The four
`workbuddy_worker*` types are native Codex children that receive a one-shot plaintext
assignment through a trusted `SubagentStart` Hook. Its provider points to a
local Responses-to-ACP adapter, which launches the WorkBuddy `codebuddy` CLI.

WorkBuddy Bridge is a separate parent-side MCP delegation path, not the native
worker provider. The native adapter translates Responses to ACP; the Bridge
continues to provide scope guard, worktree locks, audit, approvals, persistent
tasks, and batches for direct parent delegation.

## Why the Hook is needed

Multi-agent V2 ideally passes a self-contained task through `spawn_agent.message`.
Cross-provider paths may serialize collaboration arguments as provider-internal
ciphertext that the child cannot read. This repository uses a trusted
`SubagentStart` Hook to inject the assignment as developer context, avoiding the
cross-provider representation problem and delivering each task at most once.

## Task flow

1. The parent builds a complete assignment with `operation`, exact `cwd`,
   `task_spec`, scope, marker, and output contract.
2. It stages the assignment through stdin into a single-slot local state.
3. It resolves a profile/model and creates a native child with the exact
   returned `workbuddy_worker*` role and `fork_turns="none"`.
4. The trusted Hook atomically claims the assignment and injects it as developer
   context.
5. The native provider adapter launches `codebuddy --acp --acp-transport stdio`.
6. The adapter translates WorkBuddy ACP output into a Responses result.
7. The child returns through the native callback; the parent verifies and
   integrates.

## Agent configuration

The four `agents/workbuddy-worker*.toml` files define:

- agent types: `workbuddy_worker`, `workbuddy_worker_glm52`,
  `workbuddy_worker_minimax_m3`, and `workbuddy_worker_kimi_k27`
- provider: `workbuddy_local`
- models: `hy3`, `glm-5.2`, `minimax-m3`, and `kimi-k2.7`
- base URL: `http://127.0.0.1:17891/v1`
- sandbox_mode: `read-only`
- model_context_window: `1000000`

The native worker is currently read-only. Explicit writes use the separate
Bridge execute path under its scope guard.

## Bridge execution layer

`mcp-server/` is WorkBuddy Bridge 1.0.1:

- `workbuddy_health`: CLI capability, version consistency, persistence, limits;
- `workbuddy_plan`: read-only foreground analysis;
- `workbuddy_execute`: confirmed foreground edit with scope evidence;
- `workbuddy_plan_start` / `workbuddy_execute_prepare` / `workbuddy_execute_start`:
  persistent background tasks and approval tokens;
- `workbuddy_batch_start` / `workbuddy_task_status` / `workbuddy_batch_status` /
  `workbuddy_task_cancel`: batches, event cursors, and cancellation.

## File map

| Path | Purpose |
| --- | --- |
| `agents/workbuddy-worker.toml` | Codex custom agent |
| `agents/workbuddy-worker-glm52.toml`, `workbuddy-worker-minimax-m3.toml`, `workbuddy-worker-kimi-k27.toml` | Additional model-bound agents |
| `config/workbuddy-worker-routing.json`, `scripts/resolve-worker.mjs` | Profile/model/task routing |
| `skills/use-workbuddy-worker/SKILL.md` | Parent-side delegation protocol |
| `hooks/plaintext_handoff.py` | POSIX stage/Hook script |
| `hooks/hooks.posix.example.json` | Hook structure template |
| `snippets/AGENTS.md` | Parent-side skill index |
| `mcp-server/src/native-provider.ts` | Responses-to-ACP native provider adapter |
| `mcp-server/` | WorkBuddy Bridge execution layer and CLI adapter |
| `prompts/install-with-codex.md` | Installation contract |
| `prompts/quick-smoke-test.md` | Checkout-free smoke |
| `prompts/smoke-test.md` | Repository fixture smoke |
| `tests/test_plaintext_handoff.py` | Hook protocol tests |

## Validation matrix

| Layer | Validation | Pass condition |
| --- | --- | --- |
| Hook protocol | `python3 -m unittest tests.test_plaintext_handoff` | 27 protocol tests pass |
| Bridge | `cd mcp-server && npm run typecheck && npm test` | Build, typecheck, and tests pass |
| STDIO | `npm run test:stdio` | MCP server starts and returns health |
| Native smoke | New task follows `quick-smoke-test.md` | Marker, child identity, adapter/ACP success, handoff consumption |
| Install validation | `node scripts/validate-installation.mjs` | Agent, skill, Hook, and bridge config are ready |

## Known limits

- The model allowlist is `hy3`, `glm-5.2`, `minimax-m3`, and `kimi-k2.7`; the
  default is `hy3`. Select with the resolver or per-request `model`.
- `minimax-m3` and `kimi-k2.7` accept images only when ACP initialization
  advertises image prompt capability; remote image URLs are rejected.
- WorkBuddy CLI downloads a built-in marketplace on startup. On restricted
  networks, use `WORKBUDDY_CLI_PROXY`; otherwise startup can hang.
- The default `auto` model is rejected by the current API with
  `400 invalid parameter value`, so the bridge always passes an explicit
  `--model`.
- The Windows Hook script is included but only macOS/POSIX is verified here.
- The native adapter listens on `127.0.0.1:17891` by default. The Hook probes
  it before the target child starts and launches it on demand; manual startup
  is also supported.
- The native worker is fixed to `plan + Read`; writes do not get enabled
  implicitly through the native provider.

## References

- [codex-deepseek-subagent](https://github.com/Utopia-V/codex-deepseek-subagent)
- [codex-opencode-agent](https://github.com/ywu73/codex-opencode-subagent)
