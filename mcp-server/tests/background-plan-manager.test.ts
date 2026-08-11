import { describe, expect, it } from "vitest";
import { BackgroundPlanManager, BackgroundTaskManager } from "../src/background-plan-manager.js";
import type { InvocationInput, ToolResult } from "../src/service.js";
import { InMemoryTaskStore, type PersistedTask } from "../src/task-store.js";

const input: InvocationInput = { prompt: "analyze", cwd: "/project", max_turns: 2, timeout_seconds: 10, task_label: "plan" };

function completed(): ToolResult {
  return {
    status: "completed", operation: "plan", result: "done", summary: "done", cwd: "/project",
    binary_version: "2.115.0", duration_ms: 1, exit_code: 0, warnings: [], truncated: false,
    task_label: "plan", invocation_id: "wb_test", started_at: "2026-08-11T00:00:00.000Z",
    output: { format: "json", bytes: 2, lines: 1, sha256: "test" },
    workspace: { kind: "directory", root: "/project", repository_fingerprint: null },
    changes: null,
    protocol_version: "1.0", task_spec_version: "1",
    envelope: { invocation_id: "wb_test", task_id: null, parent_task_id: null, approval_id: null, acceptance: [], artifacts: [] },
  };
}

describe("BackgroundPlanManager", () => {
  it("starts and exposes a completed read-only plan", async () => {
    const manager = new BackgroundPlanManager(async () => completed());
    const started = manager.start(input);
    expect(started).toMatchObject({ state: "running", task_label: "plan" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status(started.task_id)).toMatchObject({ state: "completed", result: { status: "completed" } });
  });

  it("cancels a running plan through AbortSignal", async () => {
    const manager = new BackgroundPlanManager(async (invocation) => await new Promise<ToolResult>((resolve) => {
      invocation.signal?.addEventListener("abort", () => resolve({
        status: "failed", protocol_version: "1.0", task_spec_version: "1",
        error: { code: "TASK_CANCELLED", message: "cancelled", retryable: false, details: {} },
      }), { once: true });
    }));
    const started = manager.start(input);
    expect(manager.cancel(started.task_id)).toMatchObject({ state: "running", cancellation_requested: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status(started.task_id)).toMatchObject({ state: "cancelled" });
  });

  it("returns TASK_NOT_FOUND for unknown handles", () => {
    const manager = new BackgroundPlanManager(async () => completed());
    expect(() => manager.status("wbt_00000000-0000-0000-0000-000000000000")).toThrow(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
  });

  it("runs dependency batches in order and exposes incremental events", async () => {
    const order: string[] = [];
    const manager = new BackgroundTaskManager(async (_operation, invocation) => {
      order.push(invocation.task_label ?? "");
      return completed();
    });
    const tasks = manager.startMany([
      { taskKey: "first", operation: "plan", input: { ...input, task_label: "first" } },
      { taskKey: "second", operation: "plan", input: { ...input, task_label: "second" }, dependsOnKeys: ["first"] },
    ]);
    expect(tasks.map((task) => task.state)).toEqual(["running", "pending"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first", "second"]);
    const final = manager.status(tasks[1]!.task_id);
    expect(final.state).toBe("completed");
    expect(final.events.map((event) => event.type)).toEqual(["created", "started", "completed"]);
    expect(manager.status(final.task_id, final.next_event_id).events).toEqual([]);
  });

  it("marks persisted nonterminal tasks orphaned without retrying them", () => {
    const store = new InMemoryTaskStore();
    const persisted: PersistedTask = {
      task_id: "wbt_00000000-0000-0000-0000-000000000009", task_key: "old", batch_id: null,
      task_label: "old", operation: "execute", state: "running", created_at: "2026-08-11T00:00:00.000Z",
      started_at: "2026-08-11T00:00:01.000Z", completed_at: null, cancellation_requested: false,
      depends_on: [],
    };
    store.create(persisted);
    let invoked = false;
    const manager = new BackgroundTaskManager(async () => { invoked = true; return completed(); }, store);
    expect(manager.status(persisted.task_id)).toMatchObject({ state: "orphaned" });
    expect(invoked).toBe(false);
  });

  it("queues work behind the configured global concurrency budget", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const manager = new BackgroundTaskManager(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return completed();
    }, new InMemoryTaskStore(), 64, 60_000, 2);
    const tasks = manager.startMany(["a", "b", "c"].map((taskKey) => ({ taskKey, operation: "plan" as const, input })));
    expect(tasks.map((task) => task.state)).toEqual(["running", "running", "pending"]);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status(tasks[2]!.task_id).state).toBe("running");
    expect(peak).toBe(2);
    while (releases.length > 0) releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
