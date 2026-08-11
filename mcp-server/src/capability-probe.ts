import { BridgeError } from "./errors.js";
import { runProcess, type ProcessResult } from "./process-runner.js";

export interface Capabilities {
  print: boolean;
  json_output: boolean;
  json_schema: boolean;
  permission_mode: boolean;
  tool_restriction: boolean;
  max_turns: boolean;
  no_session_persistence: boolean;
  strict_mcp_config: boolean;
}

export interface CliProbe {
  binaryPath: string;
  version: string;
  capabilities: Capabilities;
}

type Runner = (options: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>;

function parseVersion(output: string): string {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) throw new BridgeError("OUTPUT_INVALID", "WorkBuddy CLI returned an invalid version string.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 2 || minor < 100) {
    throw new BridgeError("VERSION_UNSUPPORTED", `WorkBuddy CLI ${match[0]} is outside the supported 2.100.x–2.x range.`);
  }
  return match[0];
}

export async function probeCli(binaryPath: string, runner: Runner = runProcess): Promise<CliProbe> {
  const versionResult = await runner({ executable: binaryPath, args: ["--version"], timeoutMs: 5_000, maxStdoutBytes: 8_192 });
  if (versionResult.exitCode !== 0) {
    throw new BridgeError("PROCESS_FAILED", "WorkBuddy CLI version probing failed.", false, { exit_code: versionResult.exitCode });
  }
  const version = parseVersion(versionResult.stdout);
  const helpResult = await runner({ executable: binaryPath, args: ["--help"], timeoutMs: 5_000, maxStdoutBytes: 131_072 });
  if (helpResult.exitCode !== 0) {
    throw new BridgeError("PROCESS_FAILED", "WorkBuddy CLI capability probing failed.", false, { exit_code: helpResult.exitCode });
  }
  const help = helpResult.stdout;
  const capabilities: Capabilities = {
    print: help.includes("--print"),
    json_output: help.includes("--output-format"),
    json_schema: help.includes("--json-schema"),
    permission_mode: help.includes("--permission-mode"),
    tool_restriction: help.includes("--tools"),
    max_turns: help.includes("--max-turns"),
    no_session_persistence: help.includes("--no-session-persistence"),
    strict_mcp_config: help.includes("--strict-mcp-config"),
  };
  const missing = Object.entries(capabilities).filter(([, available]) => !available).map(([name]) => name);
  if (missing.length > 0) {
    throw new BridgeError("CAPABILITY_MISSING", "WorkBuddy CLI is missing capabilities required by the safe bridge.", false, { missing });
  }
  return { binaryPath, version, capabilities };
}
