import { describe, expect, it } from "vitest";
import { acceptanceEvidence, normalizeTaskContract } from "../src/task-contract.js";

describe("TaskSpec v1", () => {
  it("keeps legacy prompts compatible", () => {
    expect(normalizeTaskContract({ prompt: "analyze" })).toMatchObject({ prompt: "analyze", taskSpec: null, parentTaskId: null });
  });

  it("normalizes objective, label, constraints, and evidence without claiming acceptance", () => {
    const normalized = normalizeTaskContract({ task_spec: {
      version: "1", objective: "edit one file", task_label: "parser", parent_task_id: "parent-1",
      acceptance_criteria: ["tests pass"], expected_artifacts: ["work/result.txt"],
      constraints: { allowed_paths: ["work/**"], max_changed_files: 1 },
    } });
    expect(normalized).toMatchObject({ prompt: "edit one file", taskLabel: "parser", parentTaskId: "parent-1", scope: { max_changed_files: 1 } });
    expect(acceptanceEvidence(normalized.taskSpec)).toEqual([{
      criterion: "tests pass", status: "not_evaluated", reason: "requires_caller_verification",
    }]);
  });

  it("rejects conflicting legacy and v1 objectives", () => {
    expect(() => normalizeTaskContract({ prompt: "a", task_spec: { version: "1", objective: "b", acceptance_criteria: [], expected_artifacts: [] } }))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
