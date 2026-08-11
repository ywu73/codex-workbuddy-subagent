# Design

## Goal

Model `codex-workbuddy-subagent` on `codex-deepseek-subagent` and
`codex-opencode-agent`: expose the WorkBuddy `codebuddy` CLI as a native Codex
subagent while keeping WorkBuddy Bridge 1.0.1 as the safety-critical execution
layer.

## Success criteria

1. `workbuddy_worker` is discoverable in a new Codex task.
2. A `fork_turns="none"` child receives the complete Hook-delivered assignment.
3. The child calls `workbuddy_plan` through the bridge and returns the parent's
   exact random marker.
4. The one-shot pending handoff is consumed.
5. The main task model/provider remains unchanged.
6. Execute paths still enforce scope, worktree locks, audit, and approvals.
7. No local shell fallback or direct API call fakes the result.

## Architecture

```text
Codex main task
  -> $use-workbuddy-worker
  -> stage assignment
  -> spawn workbuddy_worker, fork_turns="none"
  -> SubagentStart Hook injects the assignment
  -> child calls WorkBuddy Bridge MCP tools
  -> bridge launches codebuddy CLI with TaskSpec v1 and scope guard
  -> child returns marker and ResultEnvelope v1
  -> main task verifies and integrates
```

Key decisions:

- The agent TOML owns the child identity and a read-only sandbox.
- The plaintext Hook protocol is reused from `codex-deepseek-subagent`.
- The bridge remains the only path that invokes `codebuddy`.
- `WORKBUDDY_CLI_PROXY` and `WORKBUDDY_CLI_MODEL` are local environment
  overrides for network and model behavior.

## Repository structure

| Path | Purpose |
| --- | --- |
| `agents/workbuddy-worker.toml` | Codex custom agent |
| `skills/use-workbuddy-worker/SKILL.md` | Parent-side delegation protocol |
| `hooks/plaintext_handoff.py` | POSIX stage/Hook script |
| `prompts/install-with-codex.md` | Installation contract |
| `prompts/quick-smoke-test.md` | Checkout-free smoke |
| `prompts/smoke-test.md` | Repository fixture smoke |
| `mcp-server/` | WorkBuddy Bridge execution layer |
| `tests/` | Hook protocol tests |
| `scripts/validate-installation.mjs` | Install validation |

## Verification

1. Parse and validate the agent TOML.
2. Run `python3 -m unittest tests.test_plaintext_handoff`.
3. Run bridge build, typecheck, and tests.
4. Install into a new Codex task, trust the Hook, and run the quick smoke.
5. Run `node scripts/validate-installation.mjs`.

## Risks

| Risk | Handling |
| --- | --- |
| WorkBuddy CLI startup hangs on marketplace download | `WORKBUDDY_CLI_PROXY` routes downloads through a local proxy |
| Default `auto` model rejected with 400 | Bridge always passes an explicit `WORKBUDDY_CLI_MODEL` |
| Cross-provider V2 ciphertext | Trusted `SubagentStart` Hook delivers the assignment |
| Write safety | Execute only through bridge scope guard and explicit user confirmation |
| Windows | Hook script is included; macOS/POSIX is the verified baseline |
