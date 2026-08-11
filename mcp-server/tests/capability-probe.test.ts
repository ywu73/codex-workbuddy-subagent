import { describe, expect, it } from "vitest";
import { probeCli } from "../src/capability-probe.js";
import type { ProcessResult, RunOptions } from "../src/process-runner.js";

const completeHelp = ["--print", "--output-format", "--json-schema", "--permission-mode", "--tools", "--max-turns", "--no-session-persistence", "--strict-mcp-config"].join("\n");

function runner(version: string, help = completeHelp) {
  return async (options: RunOptions): Promise<ProcessResult> => ({
    stdout: options.args[0] === "--version" ? version : help,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    truncated: false,
  });
}

describe("probeCli", () => {
  it("accepts the supported capability set", async () => {
    const result = await probeCli("/tmp/codebuddy", runner("2.115.0"));
    expect(result.version).toBe("2.115.0");
    expect(Object.values(result.capabilities).every(Boolean)).toBe(true);
  });

  it("fails closed on unsupported versions", async () => {
    await expect(probeCli("/tmp/codebuddy", runner("3.0.0"))).rejects.toMatchObject({ code: "VERSION_UNSUPPORTED" });
  });

  it("fails closed when a required option is missing", async () => {
    await expect(probeCli("/tmp/codebuddy", runner("2.115.0", "--print"))).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });
});
