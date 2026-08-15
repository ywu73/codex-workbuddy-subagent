#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const checks = {};

try {
  const agents = [
    ["workbuddy-worker-hy3.toml", "workbuddy_worker_hy3", "hy3"],
    ["workbuddy-worker-glm52.toml", "workbuddy_worker_glm52", "glm-5.2"],
    ["workbuddy-worker-minimax-m3.toml", "workbuddy_worker_minimax_m3", "minimax-m3"],
    ["workbuddy-worker-kimi-k27.toml", "workbuddy_worker_kimi_k27", "kimi-k2.7"],
  ];
  const contents = agents.map(([filename, agentType, model]) => {
    const agent = readFileSync(path.join(codexHome, "agents", filename), "utf8");
    return { agent, agentType, model };
  });
  checks.agents_installed = contents.every(({ agent, agentType, model }) => agent.includes(agentType) && agent.includes(`model = "${model}"`));
  checks.agent_has_provider = contents.every(({ agent }) => agent.includes("model_provider") && agent.includes("[model_providers."));
  checks.agent_native_provider = contents.every(({ agent }) => agent.includes('model_provider = "workbuddy_local"') && agent.includes('base_url = "http://127.0.0.1:17891/v1"'));
  checks.agent_no_plaintext_key = contents.every(({ agent }) => !agent.includes("OPENCODE_API_KEY =") && (!agent.includes("experimental_bearer_token") || agent.includes('experimental_bearer_token = "PROXY_MANAGED"') || agent.includes("experimental_bearer_token = \"PROXY_MANAGED\"")));
} catch (error) {
  checks.agents_installed = false;
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
  const resolver = readFileSync(path.join(hookDir, "resolve-worker.mjs"), "utf8");
  const routing = readFileSync(path.join(hookDir, "workbuddy-worker-routing.json"), "utf8");
  checks.hook_script_installed =
    handoff.includes("workbuddy_worker_hy3") &&
    handoff.includes("workbuddy_worker_kimi_k27");
  checks.worker_routing_installed = resolver.includes("workbuddy-worker-routing.json") && routing.includes("kimi-k2.7");
} catch {
  checks.hook_script_installed = false;
  checks.worker_routing_installed = false;
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
    hooksText.includes("workbuddy_worker_hy3") &&
    hooksText.includes("workbuddy_worker_glm52") &&
    hooksText.includes("workbuddy_worker_minimax_m3") &&
    hooksText.includes("workbuddy_worker_kimi_k27") &&
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

const requiredChecks = Object.entries(checks)
  .filter(([name]) => !name.startsWith("bridge_"))
  .map(([, value]) => value);
const ready = requiredChecks.every(Boolean);
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
