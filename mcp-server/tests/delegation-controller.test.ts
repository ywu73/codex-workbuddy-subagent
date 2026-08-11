import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/approval.js";
import { BackgroundTaskManager } from "../src/background-plan-manager.js";
import { DelegationController } from "../src/delegation-controller.js";
import type { ExecutionPreparation, InvocationInput, PreparedTask, ToolResult, WorkBuddyService } from "../src/service.js";
import { InMemoryTaskStore } from "../src/task-store.js";

const workspace = { kind: "git_linked_worktree" as const, root: "/repo", lockKey: "worktree:/repo", repositoryFingerprint: "repo" };
const preview = {
  baseline_sha256: "baseline", entries: 0, content_hashed_files: 0, metadata_only_files: 0,
  scope: { allowed_paths: ["work/**"], max_changed_files: 1, max_changed_bytes: 100, require_git_worktree: true },
};
const input: InvocationInput = {
  prompt: "edit", cwd: "/repo", max_turns: 2, timeout_seconds: 10,
  scope: { allowed_paths: ["work/**"], max_changed_files: 1, max_changed_bytes: 100, require_git_worktree: true },
};

function completed(operation: "plan" | "execute"): ToolResult {
  return {
    status: "completed", operation, result: {}, summary: "done", cwd: "/repo", binary_version: "2.115.0",
    duration_ms: 1, exit_code: 0, warnings: [], truncated: false, task_label: null, invocation_id: "wb_test",
    started_at: "2026-08-11T00:00:00.000Z", output: { format: "json", bytes: 2, lines: 1, sha256: "x" },
    workspace: { kind: "git_linked_worktree", root: "/repo", repository_fingerprint: "repo" }, changes: null,
    protocol_version: "1.0", task_spec_version: "1", envelope: { invocation_id: "wb_test", task_id: null, parent_task_id: null, approval_id: null, acceptance: [], artifacts: [] },
  };
}

function fakeService() {
  let baselineChecks = 0;
  const prepared: PreparedTask = { input, cwd: "/repo", workspace, prompt: "edit", taskSpec: null, scope: input.scope };
  const service = {
    async prepareTask(_input: InvocationInput): Promise<PreparedTask> { return prepared; },
    async prepareExecution(_input: InvocationInput): Promise<ExecutionPreparation> { return { ...prepared, preview }; },
    async assertExecutionBaseline(_cwd: string, sha: string) { expect(sha).toBe("baseline"); baselineChecks += 1; },
  } as unknown as WorkBuddyService;
  return { service, baselineChecks: () => baselineChecks };
}

describe("DelegationController", () => {
  it("reports the default global concurrency budget of four", async () => {
    const store = new InMemoryTaskStore();
    const fake = fakeService();
    const controller = new DelegationController(
      fake.service,
      new BackgroundTaskManager(async (operation) => completed(operation), store),
      new ApprovalManager(store, async () => Buffer.alloc(32, 3)),
    );
    await expect(controller.startBatch([
      { ...input, task_key: "reader", operation: "plan", depends_on: [] },
    ])).resolves.toMatchObject({ global_concurrency_budget: 4 });
  });

  it("requires a matching single-use approval for background execute", async () => {
    const store = new InMemoryTaskStore();
    const fake = fakeService();
    const controller = new DelegationController(
      fake.service,
      new BackgroundTaskManager(async (operation) => completed(operation), store),
      new ApprovalManager(store, async () => Buffer.alloc(32, 4)),
    );
    const approval = await controller.prepareExecute(input);
    const started = await controller.startExecute({ ...input, approval_token: approval.approval_token });
    expect(started.operation).toBe("execute");
    expect(fake.baselineChecks()).toBe(1);
    await expect(controller.startExecute({ ...input, approval_token: approval.approval_token })).rejects.toMatchObject({ code: "APPROVAL_REPLAYED" });
  });

  it("rejects a batch write conflict before consuming approval", async () => {
    const store = new InMemoryTaskStore();
    const fake = fakeService();
    const approvals = new ApprovalManager(store, async () => Buffer.alloc(32, 5));
    const controller = new DelegationController(fake.service, new BackgroundTaskManager(async (operation) => completed(operation), store), approvals);
    const approval = await controller.prepareExecute(input);
    await expect(controller.startBatch([
      { ...input, task_key: "reader", operation: "plan", depends_on: [] },
      { ...input, task_key: "writer", operation: "execute", depends_on: ["reader"], approval_token: approval.approval_token },
    ])).rejects.toMatchObject({ code: "BATCH_CONFLICT" });
    expect(fake.baselineChecks()).toBe(0);
  });
});
