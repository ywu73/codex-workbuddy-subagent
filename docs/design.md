# Design

## Goal

Model `codex-workbuddy-subagent` on `codex-deepseek-subagent` and
`codex-opencode-agent`: expose the WorkBuddy `codebuddy` CLI as a native Codex
subagent through a local Responses-to-ACP adapter, while keeping WorkBuddy
Bridge 1.0.1 as a separate parent-side delegation layer.

## Success criteria

1. The four `workbuddy_worker*` profiles are discoverable in a new Codex task.
2. A `fork_turns="none"` child receives the complete Hook-delivered assignment.
3. The child provider reaches WorkBuddy ACP and returns the parent's exact
   random marker.
4. The one-shot pending handoff is consumed.
5. The main task model/provider remains unchanged.
6. Native plan paths remain read-only; execute paths use the separate Bridge
   scope, worktree locks, audit, and approval controls.
7. No OpenCode, CC Switch, 15721, or local shell fallback fakes the result.

## Architecture

```text
Codex main task
  -> $use-workbuddy-worker
  -> stage assignment
  -> resolve profile/model
  -> spawn the exact returned workbuddy_worker* type, fork_turns="none"
  -> SubagentStart Hook injects the assignment
  -> local WorkBuddy Responses adapter
  -> codebuddy ACP session with plan + Read
  -> child returns marker and provider result
  -> main task verifies and integrates
```

Key decisions:

- The agent TOML owns the child identity and a read-only sandbox.
- `config/workbuddy-worker-routing.json` owns the model/profile allowlist and
  selector aliases; the parent must stage and spawn the same resolved type.
- The plaintext Hook protocol is reused from `codex-deepseek-subagent`.
- The native adapter is the path that invokes `codebuddy` for native workers.
- The Bridge remains the independent path for parent-side MCP delegation.
- `WORKBUDDY_CLI_PROXY` is a local network override; model selection is bounded
  to the four explicit WorkBuddy CLI IDs and defaults to `hy3`.

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
| Unsupported model requested | Native adapter rejects it against the four-model allowlist |
| Cross-provider V2 ciphertext | Trusted `SubagentStart` Hook delivers the assignment |
| Write safety | Execute only through bridge scope guard and explicit user confirmation |
| Windows | Hook script is included; macOS/POSIX is the verified baseline |
