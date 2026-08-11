import path from "node:path";
import { z } from "zod";
import { BridgeError } from "./errors.js";
import type { ExecutionScope } from "./execution-guard.js";
import { TASK_SPEC_VERSION } from "./version.js";

const relativeArtifact = z.string().trim().min(1).max(512).refine((value) => (
  !path.posix.isAbsolute(value.replaceAll("\\", "/")) && !value.replaceAll("\\", "/").split("/").includes("..")
), "artifact paths must be relative and may not contain '..'");

export const taskSpecSchema = z.object({
  version: z.literal(TASK_SPEC_VERSION).default(TASK_SPEC_VERSION),
  objective: z.string().trim().min(1).max(16_000),
  task_label: z.string().trim().min(1).max(128).optional(),
  parent_task_id: z.string().trim().min(1).max(128).optional(),
  acceptance_criteria: z.array(z.string().trim().min(1).max(512)).max(32).default([]),
  expected_artifacts: z.array(relativeArtifact).max(64).default([]),
  constraints: z.object({
    allowed_paths: z.array(z.string().trim().min(1).max(512)).max(64).optional(),
    max_changed_files: z.number().int().min(1).max(1_000).optional(),
    max_changed_bytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(),
    require_git_worktree: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export interface AcceptanceEvidence {
  criterion: string;
  status: "not_evaluated";
  reason: "requires_caller_verification";
}

export interface ArtifactEvidence {
  path: string;
  exists: boolean;
}

export interface NormalizedTaskContract {
  prompt: string;
  taskLabel?: string;
  parentTaskId: string | null;
  taskSpec: TaskSpec | null;
  scope?: ExecutionScope;
}

export function normalizeTaskContract(input: {
  prompt?: string | undefined;
  task_label?: string | undefined;
  task_spec?: TaskSpec | undefined;
  scope?: ExecutionScope | undefined;
}): NormalizedTaskContract {
  const taskSpec = input.task_spec === undefined ? null : taskSpecSchema.parse(input.task_spec);
  const prompt = input.prompt?.trim() || taskSpec?.objective;
  if (prompt === undefined || prompt === "") {
    throw new BridgeError("INVALID_ARGUMENT", "Provide either prompt or task_spec.objective.");
  }
  if (input.prompt?.trim() && taskSpec !== null && input.prompt.trim() !== taskSpec.objective) {
    throw new BridgeError("INVALID_ARGUMENT", "prompt and task_spec.objective must match when both are provided.");
  }
  const explicitScope = input.scope;
  const contractScope = taskSpec?.constraints;
  if (explicitScope !== undefined && contractScope !== undefined && JSON.stringify(explicitScope) !== JSON.stringify(contractScope)) {
    throw new BridgeError("INVALID_ARGUMENT", "scope and task_spec.constraints must match when both are provided.");
  }
  const taskLabel = input.task_label ?? taskSpec?.task_label;
  if (input.task_label !== undefined && taskSpec?.task_label !== undefined && input.task_label !== taskSpec.task_label) {
    throw new BridgeError("INVALID_ARGUMENT", "task_label and task_spec.task_label must match when both are provided.");
  }
  const scope = explicitScope ?? contractScope;
  return {
    prompt,
    ...(taskLabel === undefined ? {} : { taskLabel }),
    parentTaskId: taskSpec?.parent_task_id ?? null,
    taskSpec,
    ...(scope === undefined ? {} : { scope }),
  };
}

export function acceptanceEvidence(taskSpec: TaskSpec | null): AcceptanceEvidence[] {
  return (taskSpec?.acceptance_criteria ?? []).map((criterion) => ({
    criterion,
    status: "not_evaluated",
    reason: "requires_caller_verification",
  }));
}
