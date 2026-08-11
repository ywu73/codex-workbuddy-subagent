export const errorCodes = [
  "CLI_NOT_FOUND",
  "CLI_UNEXECUTABLE",
  "VERSION_UNSUPPORTED",
  "CAPABILITY_MISSING",
  "AUTH_REQUIRED",
  "DIRECTORY_NOT_FOUND",
  "DIRECTORY_NOT_ALLOWED",
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "TIMEOUT",
  "OUTPUT_TOO_LARGE",
  "OUTPUT_INVALID",
  "OUTPUT_FRAMING_INVALID",
  "OUTPUT_RESULT_MISSING",
  "PROCESS_FAILED",
  "WORKBUDDY_FAILED",
  "BRIDGE_BUSY",
  "DIRECTORY_LOCKED",
  "SCOPE_VIOLATION",
  "SNAPSHOT_TOO_LARGE",
  "TASK_NOT_FOUND",
  "TASK_CANCELLED",
  "VERSION_MISMATCH",
  "CLIENT_RESTART_REQUIRED",
  "APPROVAL_INVALID",
  "APPROVAL_EXPIRED",
  "APPROVAL_STALE",
  "APPROVAL_REPLAYED",
  "DEPENDENCY_FAILED",
  "BATCH_CONFLICT",
  "TASK_ORPHANED",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface FailureResult {
  status: "failed";
  protocol_version: typeof PROTOCOL_VERSION;
  task_spec_version: typeof TASK_SPEC_VERSION;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BridgeError";
  }

  toFailure(): FailureResult {
    return {
      status: "failed",
      protocol_version: PROTOCOL_VERSION,
      task_spec_version: TASK_SPEC_VERSION,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }

  withDetails(details: Record<string, unknown>): BridgeError {
    return new BridgeError(this.code, this.message, this.retryable, { ...this.details, ...details });
  }
}

export function normalizeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  return new BridgeError("WORKBUDDY_FAILED", "The WorkBuddy bridge failed unexpectedly.", false, {
    cause: error instanceof Error ? error.name : "UnknownError",
  });
}
import { PROTOCOL_VERSION, TASK_SPEC_VERSION } from "./version.js";
