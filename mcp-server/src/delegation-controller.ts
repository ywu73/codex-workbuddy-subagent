import { randomUUID } from "node:crypto";
import { ApprovalManager, type PreparedApproval, type ApprovalPayload } from "./approval.js";
import {
  BackgroundTaskManager,
  type BackgroundBatchView,
  type BackgroundTaskView,
  type BatchTaskStart,
} from "./background-plan-manager.js";
import { BridgeError } from "./errors.js";
import { DEFAULT_MAX_CONCURRENCY } from "./limits.js";
import type { InvocationInput, PreparedTask, ExecutionPreparation, WorkBuddyService } from "./service.js";

export interface ApprovedExecutionInput extends InvocationInput {
  approval_token: string;
}

export interface BatchDelegationInput extends InvocationInput {
  task_key: string;
  operation: "plan" | "execute";
  depends_on: string[];
  approval_token?: string | undefined;
}

export interface BatchStartResult extends BackgroundBatchView {
  global_concurrency_budget: number;
  conflict_check: "passed";
}

interface VerifiedExecution {
  prepared: ExecutionPreparation;
  payload: ApprovalPayload;
}

export class DelegationController {
  constructor(
    private readonly service: WorkBuddyService,
    private readonly background: BackgroundTaskManager,
    private readonly approvals: ApprovalManager,
    private readonly maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  ) {}

  startPlan(input: InvocationInput): BackgroundTaskView {
    return this.background.start("plan", input);
  }

  async prepareExecute(input: InvocationInput): Promise<PreparedApproval> {
    const prepared = await this.service.prepareExecution(input);
    return await this.approvals.prepare({
      cwd: prepared.cwd,
      workspaceLockKey: prepared.workspace.lockKey,
      prompt: prepared.prompt,
      taskSpec: prepared.taskSpec,
      scope: prepared.scope,
      preview: prepared.preview,
    });
  }

  async startExecute(input: ApprovedExecutionInput): Promise<BackgroundTaskView> {
    const verified = await this.verifyExecution(input);
    await this.service.assertExecutionBaseline(verified.prepared.cwd, verified.payload.baseline_sha256);
    this.approvals.redeem(verified.payload);
    return this.background.start("execute", {
      ...verified.prepared.input,
      approved_baseline_sha256: verified.payload.baseline_sha256,
      approval_id: verified.payload.approval_id,
    });
  }

  async startBatch(inputs: readonly BatchDelegationInput[]): Promise<BatchStartResult> {
    const prepared = await Promise.all(inputs.map(async (input) => ({
      input,
      prepared: input.operation === "execute" ? await this.verifyExecution(input) : await this.service.prepareTask(input),
    })));
    this.assertNoBatchConflicts(prepared.map(({ input, prepared: item }) => ({
      operation: input.operation,
      taskKey: input.task_key,
      task: "prepared" in item ? item.prepared : item,
    })));
    for (const item of prepared) {
      if (item.input.operation !== "execute" || !("payload" in item.prepared)) continue;
      await this.service.assertExecutionBaseline(item.prepared.prepared.cwd, item.prepared.payload.baseline_sha256);
    }
    for (const item of prepared) {
      if (item.input.operation === "execute" && "payload" in item.prepared) this.approvals.redeem(item.prepared.payload);
    }
    const specs: BatchTaskStart[] = prepared.map(({ input, prepared: item }) => {
      const task = "prepared" in item ? item.prepared : item;
      return {
        taskKey: input.task_key,
        operation: input.operation,
        input: input.operation === "execute" && "payload" in item ? {
          ...task.input,
          approved_baseline_sha256: item.payload.baseline_sha256,
          approval_id: item.payload.approval_id,
        } : task.input,
        dependsOnKeys: input.depends_on,
      };
    });
    const tasks = this.background.startMany(specs, `wbb_${randomUUID()}`);
    const batchId = tasks[0]?.batch_id;
    if (batchId === null || batchId === undefined) throw new BridgeError("WORKBUDDY_FAILED", "The background batch did not receive an identifier.");
    return {
      ...this.background.batchStatus(batchId),
      global_concurrency_budget: this.maxConcurrency,
      conflict_check: "passed",
    };
  }

  status(taskId: string, afterEventId = 0): BackgroundTaskView {
    return this.background.status(taskId, afterEventId);
  }
  batchStatus(batchId: string, afterEventId = 0): BackgroundBatchView {
    return this.background.batchStatus(batchId, afterEventId);
  }
  cancel(taskId: string): BackgroundTaskView { return this.background.cancel(taskId); }

  private async verifyExecution(input: ApprovedExecutionInput | BatchDelegationInput): Promise<VerifiedExecution> {
    if (input.approval_token === undefined) throw new BridgeError("APPROVAL_INVALID", "Background execute requires an approval token.");
    const { approval_token: _approvalToken, task_key: _taskKey, operation: _operation, depends_on: _dependsOn, ...invocation } = input as BatchDelegationInput & { approval_token: string };
    const prepared = await this.service.prepareExecution(invocation);
    const payload = await this.approvals.verify(input.approval_token, {
      cwd: prepared.cwd,
      workspaceLockKey: prepared.workspace.lockKey,
      prompt: prepared.prompt,
      taskSpec: prepared.taskSpec,
      scope: prepared.scope,
    });
    return { prepared, payload };
  }

  private assertNoBatchConflicts(items: readonly { operation: "plan" | "execute"; taskKey: string; task: PreparedTask }[]): void {
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        const a = items[left];
        const b = items[right];
        if (a === undefined || b === undefined) continue;
        if (a.task.workspace.lockKey === b.task.workspace.lockKey && (a.operation === "execute" || b.operation === "execute")) {
          throw new BridgeError("BATCH_CONFLICT", "A batch cannot contain overlapping tasks when either task writes to the same worktree.", false, {
            task_keys: [a.taskKey, b.taskKey],
            workspace_root: a.task.workspace.root,
          });
        }
      }
    }
  }
}
