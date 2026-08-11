import { createHash } from "node:crypto";
import { BridgeError } from "./errors.js";
import { redactText, redactUnknown } from "./redaction.js";

export interface AdaptedResult {
  result: unknown;
  summary: string;
  warnings: string[];
  output: OutputDiagnostics;
}

export interface OutputDiagnostics {
  format: "json" | "json-array" | "ndjson";
  bytes: number;
  lines: number;
  sha256: string;
}

function diagnostics(stdout: string, format: OutputDiagnostics["format"]): OutputDiagnostics {
  return {
    format,
    bytes: Buffer.byteLength(stdout),
    lines: stdout === "" ? 0 : stdout.split(/\r?\n/).length,
    sha256: createHash("sha256").update(stdout).digest("hex"),
  };
}

function failureDetails(stdout: string, detected: string): Record<string, unknown> {
  return {
    output_format_detected: detected,
    stdout_bytes: Buffer.byteLength(stdout),
    stdout_lines: stdout === "" ? 0 : stdout.split(/\r?\n/).length,
    stdout_sha256: createHash("sha256").update(stdout).digest("hex"),
  };
}

export function adaptCliResult(stdout: string): AdaptedResult {
  let candidate: unknown;
  let format: OutputDiagnostics["format"] = "json";
  try {
    candidate = JSON.parse(stdout) as unknown;
    if (Array.isArray(candidate)) format = "json-array";
  } catch {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    try {
      if (lines.length < 2) throw new Error("not ndjson");
      candidate = lines.map((line) => JSON.parse(line) as unknown);
      format = "ndjson";
    } catch {
      throw new BridgeError(
        "OUTPUT_FRAMING_INVALID",
        "WorkBuddy CLI output was neither valid JSON nor valid NDJSON.",
        false,
        failureDetails(stdout, "invalid"),
      );
    }
  }

  let parsed: Record<string, unknown>;
  if (Array.isArray(candidate)) {
    const finalResult = [...candidate].reverse().find((item): item is Record<string, unknown> => (
      item !== null && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "result"
    ));
    if (finalResult === undefined) {
      throw new BridgeError(
        "OUTPUT_RESULT_MISSING",
        "WorkBuddy CLI output did not contain a final result event.",
        false,
        failureDetails(stdout, format),
      );
    }
    parsed = finalResult;
  } else {
    if (candidate === null || typeof candidate !== "object") {
      throw new BridgeError(
        "OUTPUT_RESULT_MISSING",
        "WorkBuddy CLI output did not contain a result object.",
        false,
        failureDetails(stdout, format),
      );
    }
    parsed = candidate as Record<string, unknown>;
  }

  if (parsed.is_error === true || parsed.subtype === "error" || parsed.status === "failed") {
    throw new BridgeError("WORKBUDDY_FAILED", "WorkBuddy reported that the delegated task failed.", false, {
      result: redactUnknown(parsed.result ?? parsed.error ?? parsed.message),
    });
  }
  const result = redactUnknown(parsed.structured_output ?? parsed.result ?? parsed);
  const summarySource = typeof parsed.result === "string"
    ? parsed.result
    : typeof parsed.message === "string"
      ? parsed.message
      : "WorkBuddy completed the delegated task.";
  return {
    result,
    summary: redactText(summarySource, 4_096),
    warnings: format === "ndjson" ? ["WorkBuddy returned NDJSON event framing."] : [],
    output: diagnostics(stdout, format),
  };
}

export function processFailure(exitCode: number, stderr: string): BridgeError {
  const lower = stderr.toLowerCase();
  if (/not logged in|login required|authentication required|unauthorized/.test(lower)) {
    return new BridgeError("AUTH_REQUIRED", "WorkBuddy authentication is required.", false, { exit_code: exitCode });
  }
  if (/permission denied|not permitted|approval required/.test(lower)) {
    return new BridgeError("PERMISSION_DENIED", "WorkBuddy could not obtain the required permission.", false, { exit_code: exitCode });
  }
  return new BridgeError("PROCESS_FAILED", "WorkBuddy CLI exited with a non-zero status.", false, {
    exit_code: exitCode,
    stderr: redactText(stderr, 2_048),
  });
}
