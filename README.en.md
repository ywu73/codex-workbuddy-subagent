# codex-workbuddy-subagent

Keep the Codex main task on its current model/provider while using the WorkBuddy
`codebuddy` CLI as a native subagent for bounded local analysis or confirmed
scoped file edits. This repository reuses the native child + one-shot Hook
architecture from `codex-deepseek-subagent` and keeps WorkBuddy Bridge 1.0.1 as
the execution layer.

`workbuddy_worker` is a native Codex child that receives a one-shot plaintext
assignment through a trusted `SubagentStart` Hook, then calls the WorkBuddy
Bridge MCP tools to run `plan` or a confirmed `execute`.

The current default model is `hy3`.

## Three-step install

### 1. Prepare WorkBuddy

Make sure WorkBuddy is installed on macOS and the `codebuddy` CLI is available
and authenticated. This repository calls the CLI through WorkBuddy Bridge and
does not operate the WorkBuddy GUI.

If the CLI needs a proxy on this network, configure the MCP server:

```toml
[mcp_servers.workbuddy-bridge.env]
WORKBUDDY_CLI_PROXY = "http://127.0.0.1:7892"
WORKBUDDY_CLI_MODEL = "hy3"
```

`WORKBUDDY_CLI_PROXY` routes the built-in marketplace download through the proxy
so the 16 MB zip does not stall startup; `WORKBUDDY_CLI_MODEL` selects an
explicit model because the default `auto` value is rejected by the model API.

### 2. Install with Codex

Ask Codex to read and follow
[prompts/install-with-codex.md](prompts/install-with-codex.md) from this
repository. The installer adds:

- `<codex-home>/agents/workbuddy-worker.toml`
- `<codex-home>/skills/use-workbuddy-worker/`
- `<codex-home>/hooks/codex-workbuddy-subagent/plaintext_handoff.py`
- one `SubagentStart` Hook matching `^workbuddy_worker$`
- a marked `$use-workbuddy-worker` index in the personal `AGENTS.md`

The WorkBuddy Bridge MCP plugin must also be installed and
`[mcp_servers.workbuddy-bridge]` must point to this repository's
`mcp-server/dist/src/server.js`.

### 3. Trust the Hook, then test

1. Enter `/hooks` in Codex and confirm the Hook matches only `workbuddy_worker`
   and points to the installed `plaintext_handoff.py`, then trust it.
2. Start a new Codex task.
3. Ask the new task to follow
   [prompts/quick-smoke-test.md](prompts/quick-smoke-test.md).

## What success looks like

The quick smoke passes only when all of these are true:

- Codex exposes a distinct native child task whose agent type is
  `workbuddy_worker`.
- The child returns the parent's exact fresh marker.
- The child completes a read-only `workbuddy_plan` through the bridge.
- The one-shot pending handoff is consumed.
- The main task remains on its original model/provider.
- No secondary CLI, direct API call, or substitute model fakes the result.

## File boundaries

- `agents/workbuddy-worker.toml`: child session configuration.
- `skills/use-workbuddy-worker/SKILL.md`: parent-side delegation protocol.
- `hooks/plaintext_handoff.py`: stage and `SubagentStart` Hook.
- `mcp-server/`: WorkBuddy Bridge execution layer for `codebuddy` invocation,
  scope guard, audit, and approvals.
- `snippets/AGENTS.md`: parent-side skill index.

See [SECURITY.md](SECURITY.md), [docs/advanced.md](docs/advanced.md), and
[docs/design.md](docs/design.md).

## Verification

```sh
cd mcp-server
npm install
npm run typecheck
npm test
python3 -m unittest tests.test_plaintext_handoff
```

MIT.
