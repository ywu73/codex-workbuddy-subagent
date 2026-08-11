# Advanced notes

## Composition boundary

The Codex main task keeps its current model, provider, and login.
`workbuddy_worker` is a native Codex child that receives a one-shot plaintext
assignment through a trusted `SubagentStart` Hook. The child calls the WorkBuddy
Bridge MCP tools, and the bridge launches the WorkBuddy `codebuddy` CLI to do the
actual work.

Unlike `codex-deepseek-subagent`, the WorkBuddy CLI is not a Responses API
provider that Codex can call directly, so this repository keeps WorkBuddy Bridge
as the execution layer. The bridge provides scope guard, worktree locks, audit,
approvals, persistent tasks, and batches.

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
3. It creates a native child with the exact `workbuddy_worker` role and
   `fork_turns="none"`.
4. The trusted Hook atomically claims the assignment and injects it as developer
   context.
5. The child calls `workbuddy_plan` or a confirmed `workbuddy_execute`.
6. The bridge launches `codebuddy` and returns ResultEnvelope v1.
7. The child returns through the native callback; the parent verifies and
   integrates.

## Agent configuration

`agents/workbuddy-worker.toml` defines:

- agent type: `workbuddy_worker`
- provider: `custom` (generated at install time)
- model: follows the local install
- sandbox_mode: `read-only`
- model_context_window: `1000000`

The child stays read-only because actual writes are executed by the bridge MCP
server outside the Codex sandbox, under the bridge scope guard.

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
| `skills/use-workbuddy-worker/SKILL.md` | Parent-side delegation protocol |
| `hooks/plaintext_handoff.py` | POSIX stage/Hook script |
| `hooks/hooks.posix.example.json` | Hook structure template |
| `snippets/AGENTS.md` | Parent-side skill index |
| `mcp-server/` | WorkBuddy Bridge execution layer |
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
| Quick smoke | New task follows `quick-smoke-test.md` | Marker, child identity, handoff consumption, `workbuddy_plan` success |
| Install validation | `node scripts/validate-installation.mjs` | Agent, skill, Hook, and bridge config are ready |

## Known limits

- The default model is `hy3`; override with `WORKBUDDY_CLI_MODEL`.
- WorkBuddy CLI downloads a built-in marketplace on startup. On restricted
  networks, use `WORKBUDDY_CLI_PROXY`; otherwise startup can hang.
- The default `auto` model is rejected by the current API with
  `400 invalid parameter value`, so the bridge always passes an explicit
  `--model`.
- The Windows Hook script is included but only macOS/POSIX is verified here.
- A future option is to evaluate `codebuddy --acp` / `--serve` as a local
  provider adapter and remove the MCP dependency.

## References

- [codex-deepseek-subagent](https://github.com/Utopia-V/codex-deepseek-subagent)
- [codex-opencode-agent](https://github.com/ywu73/codex-opencode-subagent)
