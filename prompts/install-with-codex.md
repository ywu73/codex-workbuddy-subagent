# Install with Codex

Copy the prompt below into a Codex task whose workspace is this repository.
It installs the native WorkBuddy Responses-to-ACP adapter and four native
model-labelled WorkBuddy custom subagents, their lazy-loaded handoff skill, and their
one-shot plaintext task Hook while preserving the current main-agent model and
provider. The WorkBuddy Bridge MCP plugin remains optional for parent-side
direct delegation.

```text
Install the native model-labelled WorkBuddy custom subagents from this repository into
my personal Codex configuration. If parent-side direct WorkBuddy delegation is
also wanted, install the optional WorkBuddy Bridge MCP plugin from the local
marketplace. Use the repository checkout as the source.

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
- Use Codex native SubagentStart Hook mechanism for task delivery. The local
  Responses-to-ACP adapter is the explicitly required provider process for
  four WorkBuddy agent types; do not substitute OpenCode, CC Switch, 15721, or another
  provider.

Before the custom subagent:

1. Build the local adapter package once:
   cd mcp-server
   npm install
   npm run build
   If the build fails, stop and report it.
2. Optionally verify the native adapter directly:
   WORKBUDDY_NATIVE_CWD="<target cwd>" npm run native-adapter
   Check `http://127.0.0.1:17891/healthz`; the trusted Hook can also start it on demand.
3. If parent-side delegation is also wanted, install the WorkBuddy Bridge MCP
   plugin once:
   codex plugin add workbuddy-bridge@wuyi-personal
   If the plugin is already installed and enabled, skip this step.
4. If installed, ensure [mcp_servers.workbuddy-bridge] points to this repository's
   mcp-server/dist/src/server.js and that the bridge env includes
   WORKBUDDY_CLI_PROXY and WORKBUDDY_CLI_MODEL when needed.

Then install the native subagent:

5. Detect the active Codex home without changing it.
6. Inspect the target agents directory, any existing WorkBuddy worker files,
   the use-workbuddy-worker skill directory, the personal AGENTS.md, user
   hooks.json, inline Hook configuration, and hooks directory.
   If the legacy `workbuddy-worker.toml` declares the generic
   `workbuddy_worker` identity from this repository, treat it as the file being
   migrated; preserve any unrelated agent with the same path instead of
   deleting it.
7. Install these four agent files from the repository checkout, preserving the
   model binding in each standalone TOML:
   - `<codex-home>/agents/workbuddy-worker-hy3.toml` (`workbuddy_worker_hy3` / `hy3`)
   - `<codex-home>/agents/workbuddy-worker-glm52.toml` (`workbuddy_worker_glm52` / `glm-5.2`)
   - `<codex-home>/agents/workbuddy-worker-minimax-m3.toml` (`workbuddy_worker_minimax_m3` / `minimax-m3`)
   - `<codex-home>/agents/workbuddy-worker-kimi-k27.toml` (`workbuddy_worker_kimi_k27` / `kimi-k2.7`)
   Remove the matching legacy `workbuddy-worker.toml` only after confirming it
   declares `name = "workbuddy_worker"`; the generic type must not remain
   registered alongside the model-labelled types.
8. Install skills/use-workbuddy-worker including its SKILL.md and
   references/bridge-v1.md.
9. Install the platform handoff script under
   <codex-home>/hooks/codex-workbuddy-subagent:
   - Requires Python 3, install hooks/plaintext_handoff.py.
   - On Windows, install hooks/plaintext-handoff.ps1 when present.
   - Install scripts/resolve-worker.mjs and config/workbuddy-worker-routing.json
     in the same directory for parent-side model/profile resolution.
10. Install one SubagentStart command Hook whose matcher is
   ^(workbuddy_worker_hy3|workbuddy_worker_glm52|workbuddy_worker_minimax_m3|workbuddy_worker_kimi_k27)$,
   timeout 10 seconds, additionalContextLimit 0,
   command invokes the script in hook mode.
11. Merge snippets/AGENTS.md into the personal AGENTS.md once.
12. Parse the installed agent file with a real TOML parser and validate.
13. Parse the final Hook source and run the local protocol test.
14. Read back the installed configuration with credential-like text redacted.
    Report changed paths, validations performed, and that the Hook must be
    reviewed in /hooks before it can execute. Do not make a paid model call.
```
