import { describe, expect, it } from "vitest";
import { adaptCliResult, processFailure } from "../src/result-adapter.js";
import { redactText } from "../src/redaction.js";

describe("result adaptation and redaction", () => {
  it("adapts successful JSON output", () => {
    expect(adaptCliResult(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toMatchObject({ result: "done", summary: "done", output: { format: "json" } });
    expect(adaptCliResult(JSON.stringify([
      { type: "message", role: "assistant", content: [] },
      { type: "result", subtype: "success", is_error: false, result: "array result" },
    ]))).toMatchObject({ result: "array result", summary: "array result", output: { format: "json-array" } });
    expect(adaptCliResult([
      JSON.stringify({ type: "message", content: [] }),
      JSON.stringify({ type: "result", subtype: "success", result: "ndjson result" }),
    ].join("\n"))).toMatchObject({
      result: "ndjson result",
      output: { format: "ndjson", lines: 2 },
      warnings: ["WorkBuddy returned NDJSON event framing."],
    });
  });

  it("rejects invalid JSON and WorkBuddy failures", () => {
    expect(() => adaptCliResult("not-json")).toThrow(expect.objectContaining({
      code: "OUTPUT_FRAMING_INVALID",
      details: expect.objectContaining({ output_format_detected: "invalid", stdout_bytes: 8 }),
    }));
    expect(() => adaptCliResult(JSON.stringify([{ type: "message" }]))).toThrow(expect.objectContaining({ code: "OUTPUT_RESULT_MISSING" }));
    expect(() => adaptCliResult(JSON.stringify({ is_error: true, result: "failed" }))).toThrow(expect.objectContaining({ code: "WORKBUDDY_FAILED" }));
  });

  it("redacts common secret forms", () => {
    const value = redactText("Authorization: Bearer abcdefghijklmnop api_key=supersecret password=hunter2");
    expect(value).not.toContain("abcdefghijklmnop");
    expect(value).not.toContain("supersecret");
    expect(value).not.toContain("hunter2");
  });

  it("normalizes auth, permission, and process failures", () => {
    expect(processFailure(1, "login required").code).toBe("AUTH_REQUIRED");
    expect(processFailure(1, "permission denied").code).toBe("PERMISSION_DENIED");
    expect(processFailure(2, "api_key=supersecret").details.stderr).not.toContain("supersecret");
  });
});
