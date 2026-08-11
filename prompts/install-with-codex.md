# Install with Codex

Copy the prompt below into a Codex task whose workspace is this repository.
It installs the WorkBuddy Bridge MCP plugin (one time) and the native
`workbuddy_worker` custom subagent, its lazy-loaded handoff skill, and its
one-shot plaintext task Hook while preserving the current main-agent model and
provider.

```text
Install the WorkBuddy Bridge MCP plugin from the local marketplace and the
native workbuddy_worker custom subagent from this repository into my personal
Codex configuration. Use the repository checkout as the source.

Scope and invariants:
- Preserve my current main model, model provider, ChatGPT login, and provider
  configuration. Creating or updating the standalone custom-agent TOML, the
  personal use-workbuddy-worker skill, the user Hook script/configuration, and
  the compact personal AGENTS.md index is expected; this is not a
  zero-configuration installation.
- Codex may later add a hooks.state trust hash to the user config when I
  explicitly trust the Hook; do not write or forge that hash yourself.
- Keep the custom-agent registration and model_provider definition inside the
  standalone agent TOML. Do not add agent registration or a top-level provider
  to config.toml.
- Never ask me to paste a secret or API key into chat, never print an existing
  key, and never write a plaintext key into any TOML or committed file.
- Do not make a paid provider call during installation.
- Use Codex native SubagentStart Hook mechanism for task delivery. Do not
  install a separate wrapper process, daemon, direct HTTP/SDK call, separate
  Codex CLI process, or another application as a fallback.

Before the custom subagent:

1. Build the bridge once:
   cd mcp-server
   npm install
   npm run build
   If the build fails, stop and report it.
2. Install the WorkBuddy Bridge MCP plugin once:
   codex plugin add workbuddy-bridge@wuyi-personal
   If the plugin is already installed and enabled, skip this step.
3. Ensure [mcp_servers.workbuddy-bridge] points to this repository's
   mcp-server/dist/src/server.js and that the bridge env includes
   WORKBUDDY_CLI_PROXY and WORKBUDDY_CLI_MODEL when needed.

Then install the native subagent:

4. Detect the active Codex home without changing it.
5. Inspect the target agents directory, any existing workbuddy_worker file,
   the use-workbuddy-worker skill directory, the personal AGENTS.md, user
   hooks.json, inline Hook configuration, and hooks directory.
6. Install exactly one agent file as
   <codex-home>/agents/workbuddy-worker.toml from the repository checkout.
7. Install skills/use-workbuddy-worker including its SKILL.md and
   references/bridge-v1.md.
8. Install the platform handoff script under
   <codex-home>/hooks/codex-workbuddy-subagent:
   - Requires Python 3, install hooks/plaintext_handoff.py.
   - On Windows, install hooks/plaintext-handoff.ps1 when present.
9. Install one SubagentStart command Hook whose matcher is
   ^workbuddy_worker$, timeout 10 seconds, additionalContextLimit 0,
   command invokes the script in hook mode.
10. Merge snippets/AGENTS.md into the personal AGENTS.md once.
11. Parse the installed agent file with a real TOML parser and validate.
12. Parse the final Hook source and run the local protocol test.
13. Read back the installed configuration with credential-like text redacted.
    Report changed paths, validations performed, and that the Hook must be
    reviewed in /hooks before it can execute.
```
