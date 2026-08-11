import { z } from "zod";
import { BridgeError } from "./errors.js";
import { taskSpecSchema } from "./task-contract.js";

export const promptSchema = z.string().trim().min(1).max(16_000);
export const cwdSchema = z.string().min(1).max(4_096);
export const maxTurnsSchema = z.number().int().min(1).max(20).default(8);
export const taskLabelSchema = z.string().trim().min(1).max(128).optional();
export const taskIdSchema = z.string().trim().regex(/^wbt_[0-9a-f-]{36}$/);
export const batchIdSchema = z.string().trim().regex(/^wbb_[0-9a-f-]{36}$/);
export const eventCursorSchema = z.number().int().min(0).default(0);
export const approvalTokenSchema = z.string().trim().min(32).max(8_192);
const relativeScopePattern = z.string().trim().min(1).max(512).refine((value) => (
  !value.startsWith("/") && !value.replaceAll("\\", "/").split("/").includes("..")
), "scope paths must be relative and may not contain '..'");

export const executionScopeSchema = z.object({
  allowed_paths: z.array(relativeScopePattern).max(64).optional(),
  max_changed_files: z.number().int().min(1).max(1_000).optional(),
  max_changed_bytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(),
  require_git_worktree: z.boolean().optional(),
}).strict().optional();

export const planInputShape = {
  prompt: promptSchema.optional().describe("Legacy objective. Provide this or task_spec; if both are provided they must match."),
  cwd: cwdSchema.describe("An existing absolute directory inside the configured allowed roots."),
  max_turns: maxTurnsSchema,
  timeout_seconds: z.number().int().min(10).max(180).default(180),
  task_label: taskLabelSchema.describe("Optional short label used to correlate independent delegated tasks."),
  task_spec: taskSpecSchema.optional().describe("TaskSpec v1 with objective, acceptance criteria, artifacts, and constraints."),
};

export const executeInputShape = {
  prompt: promptSchema.describe("The explicit, confirmed file-editing task for WorkBuddy."),
  cwd: cwdSchema.describe("An existing absolute directory inside the configured allowed roots."),
  max_turns: maxTurnsSchema,
  timeout_seconds: z.number().int().min(10).max(300).default(300),
  result_schema: z.record(z.unknown()).optional().describe("Optional JSON Schema for WorkBuddy's structured result; not CLI flags."),
  task_label: taskLabelSchema.describe("Optional short label used to correlate independent delegated tasks."),
  scope: executionScopeSchema.describe("Optional confirmed file-change scope and evidence limits."),
};

export const backgroundExecuteStartInputShape = {
  ...executeInputShape,
  approval_token: approvalTokenSchema.describe("Single-use approval token returned by workbuddy_execute_prepare after explicit confirmation."),
};

export const batchTaskSchema = z.object({
  task_key: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  operation: z.enum(["plan", "execute"]),
  prompt: promptSchema.optional(),
  cwd: cwdSchema,
  max_turns: maxTurnsSchema,
  timeout_seconds: z.number().int().min(10).max(300).default(180),
  result_schema: z.record(z.unknown()).optional(),
  task_label: taskLabelSchema,
  task_spec: taskSpecSchema.optional(),
  scope: executionScopeSchema,
  approval_token: approvalTokenSchema.optional(),
  depends_on: z.array(z.string().trim().min(1).max(64)).max(16).default([]),
}).strict();

export const batchStartInputShape = {
  tasks: z.array(batchTaskSchema).min(1).max(16),
};

export function validateResultSchema(schema: Record<string, unknown> | undefined): string | undefined {
  if (schema === undefined) return undefined;
  const serialized = JSON.stringify(schema);
  if (serialized.length > 8_192) throw new BridgeError("INVALID_ARGUMENT", "result_schema exceeds the 8192-byte limit.");
  return serialized;
}
