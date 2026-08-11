import { readFile } from "node:fs/promises";
import path from "node:path";

export const BRIDGE_VERSION = "1.0.1";
export const PROTOCOL_VERSION = "1.0";
export const TASK_SPEC_VERSION = "1";

export interface RuntimeVersionInfo {
  plugin_version: string | null;
  server_version: string;
  protocol_version: string;
  skill_expected_version: string | null;
  version_consistent: boolean;
  client_restart_required: boolean;
  diagnostic_code: "OK" | "VERSION_MISMATCH" | "BUNDLE_METADATA_UNAVAILABLE";
}

async function readable(paths: readonly string[]): Promise<{ path: string; contents: string } | null> {
  for (const candidate of paths) {
    try {
      return { path: candidate, contents: await readFile(candidate, "utf8") };
    } catch {}
  }
  return null;
}

export async function inspectRuntimeVersions(runtimeCwd = process.cwd()): Promise<RuntimeVersionInfo> {
  const manifest = await readable([
    path.join(runtimeCwd, ".codex-plugin", "plugin.json"),
    path.resolve(runtimeCwd, "..", ".codex-plugin", "plugin.json"),
  ]);
  const skill = await readable([
    path.join(runtimeCwd, "skills", "workbuddy-delegation", "SKILL.md"),
    path.resolve(runtimeCwd, "..", "skills", "workbuddy-delegation", "SKILL.md"),
  ]);
  let pluginVersion: string | null = null;
  if (manifest !== null) {
    try {
      const parsed = JSON.parse(manifest.contents) as { version?: unknown };
      if (typeof parsed.version === "string") pluginVersion = parsed.version;
    } catch {}
  }
  const skillVersion = skill?.contents.match(/Expected bridge version:\s*`([^`]+)`/i)?.[1] ?? null;
  const pluginBase = pluginVersion?.split("+", 1)[0] ?? null;
  const available = pluginVersion !== null && skillVersion !== null;
  const consistent = available && pluginBase === BRIDGE_VERSION && skillVersion === BRIDGE_VERSION;
  return {
    plugin_version: pluginVersion,
    server_version: BRIDGE_VERSION,
    protocol_version: PROTOCOL_VERSION,
    skill_expected_version: skillVersion,
    version_consistent: consistent,
    client_restart_required: available && !consistent,
    diagnostic_code: !available ? "BUNDLE_METADATA_UNAVAILABLE" : consistent ? "OK" : "VERSION_MISMATCH",
  };
}
