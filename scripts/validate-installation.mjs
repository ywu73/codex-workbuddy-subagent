#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const checks = {};

try {
  const agentPath = path.join(codexHome, "agents", "workbuddy-worker.toml");
  const agent = readFileSync(agentPath, "utf8");
  checks.agent_installed = agent.includes("workbuddy_worker");
  checks.agent_has_provider = agent.includes("model_provider") && agent.includes("[model_providers.");
  checks.agent_no_plaintext_key = !agent.includes("OPENCODE_API_KEY =") && (!agent.includes("experimental_bearer_token") || agent.includes('experimental_bearer_token = "PROXY_MANAGED"') || agent.includes("experimental_bearer_token = \"PROXY_MANAGED\""));
} catch (error) {
  checks.agent_installed = false;
  checks.install_checks_failed = error.message;
}

try {
  const skillPath = path.join(codexHome, "skills", "use-workbuddy-worker", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  checks.skill_installed = skill.includes("use-workbuddy-worker");
} catch {
  checks.skill_installed = false;
}

try {
  const hookDir = path.join(codexHome, "hooks", "codex-workbuddy-subagent");
  const handoff = readFileSync(path.join(hookDir, "plaintext_handoff.py"), "utf8");
  checks.hook_script_installed = handoff.includes("workbuddy_worker");
} catch {
  checks.hook_script_installed = false;
}

try {
  let hooksText = "";
  for (const candidate of [
    path.join(codexHome, "hooks.json"),
    path.join(codexHome, "config.toml"),
  ]) {
    try {
      hooksText += readFileSync(candidate, "utf8");
    } catch {
      // The Hook may live in only one of the supported files.
    }
  }
  checks.hook_registered =
    hooksText.includes("^workbuddy_worker$") &&
    hooksText.includes("plaintext_handoff.py");
} catch {
  checks.hook_registered = false;
}

try {
  const configText = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  checks.bridge_mcp_configured = configText.includes("[mcp_servers.workbuddy-bridge]");
  checks.bridge_env_configured = configText.includes("WORKBUDDY_CLI_PROXY") && configText.includes("WORKBUDDY_CLI_MODEL");
} catch {
  checks.bridge_mcp_configured = false;
  checks.bridge_env_configured = false;
}

const ready = Object.values(checks).every(Boolean);
process.stdout.write(
  `${JSON.stringify(
    {
      status: ready ? "ready" : "failed",
      codex_home: codexHome,
      checks,
      new_thread_required: ready,
    },
    null,
    2,
  )}\n`,
);
if (!ready) process.exitCode = 1;
