import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";
import { DEFAULT_MAX_CONCURRENCY } from "./limits.js";
import type { InvocationInput, ToolResult } from "./service.js";
import {
  InMemoryTaskStore,
  type PersistedTask,
  type PersistedTaskState,
  type TaskEvent,
  type TaskStore,
} from "./task-store.js";

export type BackgroundTaskState = PersistedTaskState;

export interface BackgroundTaskView {
  task_id: string;
  task_key: string | null;
  batch_id: string | null;
  task_label: string | null;
  operation: "plan" | "execute";
  state: BackgroundTaskState;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancellation_requested: boolean;
  depends_on: string[];
  events: TaskEvent[];
  next_event_id: number;
  result?: ToolResult;
}

export interface BackgroundStartOptions {
  taskKey?: string;
  batchId?: string;
  dependsOn?: string[];
}

export interface BatchTaskStart {
  taskKey: string;
  operation: "plan" | "execute";
  input: InvocationInput;
  dependsOnKeys?: string[];
}

export interface BackgroundBatchView {
  batch_id: string;
  state: "running" | "completed" | "failed";
  tasks: BackgroundTaskView[];
}

export class BackgroundTaskManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly inputs = new Map<string, InvocationInput>();
  private active = 0;

  constructor(
    private readonly invoke: (operation: "plan" | "execute", input: InvocationInput) => Promise<ToolResult>,
    readonly store: TaskStore = new InMemoryTaskStore(),
    private readonly maxRecords = 64,
    private readonly retentionMs = 60 * 60 * 1_000,
    private readonly maxActive = DEFAULT_MAX_CONCURRENCY,
    private readonly now: () => Date = () => new Date(),
  ) {
    const interrupted = this.store.list().filter((task) => task.state === "running" || task.state === "pending");
    this.store.markRunningOrphaned(this.now().toISOString());
    for (const task of interrupted) {
      this.event(task.task_id, "orphaned", { previous_state: task.state, automatic_retry: false });
    }
  }

  start(operation: "plan" | "execute", input: InvocationInput, options: BackgroundStartOptions = {}): BackgroundTaskView {
    const [view] = this.startMany([{ taskKey: options.taskKey ?? `task-${randomUUID()}`, operation, input, dependsOnKeys: [] }], options.batchId);
    if (view === undefined) throw new BridgeError("WORKBUDDY_FAILED", "The background task could not be created.");
    return view;
  }

  startMany(specs: readonly BatchTaskStart[], requestedBatchId?: string): BackgroundTaskView[] {
    this.cleanup();
    if (specs.length === 0 || specs.length > 16) throw new BridgeError("INVALID_ARGUMENT", "A batch must contain between 1 and 16 tasks.");
    if (this.store.list().length + specs.length > this.maxRecords) {
      throw new BridgeError("BRIDGE_BUSY", "The background task registry is full.", true, { max_records: this.maxRecords });
    }
    const keys = new Set<string>();
    for (const spec of specs) {
      if (keys.has(spec.taskKey)) throw new BridgeError("INVALID_ARGUMENT", "Batch task keys must be unique.", false, { task_key: spec.taskKey });
      keys.add(spec.taskKey);
    }
    for (const spec of specs) {
      for (const dependency of spec.dependsOnKeys ?? []) {
        if (!keys.has(dependency)) throw new BridgeError("INVALID_ARGUMENT", "A batch dependency references an unknown task key.", false, { dependency });
        if (dependency === spec.taskKey) throw new BridgeError("INVALID_ARGUMENT", "A task cannot depend on itself.");
      }
    }
    this.assertAcyclic(specs);
    const batchId = requestedBatchId ?? `wbb_${randomUUID()}`;
    const ids = new Map(specs.map((spec) => [spec.taskKey, `wbt_${randomUUID()}`]));
    const created: PersistedTask[] = specs.map((spec) => ({
      task_id: ids.get(spec.taskKey)!,
      task_key: spec.taskKey,
      batch_id: specs.length === 1 && requestedBatchId === undefined ? null : batchId,
      task_label: spec.input.task_label ?? spec.input.task_spec?.task_label ?? null,
      operation: spec.operation,
      state: "pending",
      created_at: this.now().toISOString(),
      started_at: null,
      completed_at: null,
      cancellation_requested: false,
      depends_on: (spec.dependsOnKeys ?? []).map((key) => ids.get(key)!),
    }));
    for (const task of created) {
      const source = specs.find((spec) => spec.taskKey === task.task_key);
      if (source !== undefined) this.inputs.set(task.task_id, this.persistableInput(source.input));
      this.store.create(task);
      this.event(task.task_id, "created", { operation: task.operation, depends_on: task.depends_on, batch_id: task.batch_id });
    }
    this.pump();
    return created.map((task) => this.status(task.task_id));
  }

  status(taskId: string, afterEventId = 0): BackgroundTaskView {
    this.cleanup();
    const record = this.store.get(taskId);
    if (record === undefined) throw new BridgeError("TASK_NOT_FOUND", "The background WorkBuddy task was not found.");
    return this.view(record, afterEventId);
  }

  batchStatus(batchId: string, afterEventId = 0): BackgroundBatchView {
    const tasks = this.store.list().filter((task) => task.batch_id === batchId);
    if (tasks.length === 0) throw new BridgeError("TASK_NOT_FOUND", "The WorkBuddy batch was not found.");
    const views = tasks.map((task) => this.view(task, afterEventId));
    const failed = views.some((task) => ["failed", "cancelled", "orphaned", "blocked"].includes(task.state));
    const terminal = views.every((task) => ["completed", "failed", "cancelled", "orphaned", "blocked"].includes(task.state));
    return { batch_id: batchId, state: failed ? "failed" : terminal ? "completed" : "running", tasks: views };
  }

  cancel(taskId: string): BackgroundTaskView {
    const record = this.store.get(taskId);
    if (record === undefined) throw new BridgeError("TASK_NOT_FOUND", "The background WorkBuddy task was not found.");
    if (record.state === "pending") {
      record.cancellation_requested = true;
      record.state = "cancelled";
      record.completed_at = this.now().toISOString();
      record.result = new BridgeError("TASK_CANCELLED", "The WorkBuddy task was cancelled before it started.").toFailure();
      this.inputs.delete(taskId);
      this.store.put(record);
      this.event(taskId, "cancelled", { before_start: true });
      this.pump();
    } else if (record.state === "running") {
      record.cancellation_requested = true;
      this.store.put(record);
      this.event(taskId, "cancel_requested", {});
      this.controllers.get(taskId)?.abort();
    }
    return this.status(taskId);
  }

  private pump(): void {
    let progressed = true;
    while (progressed && this.active < this.maxActive) {
      progressed = false;
      for (const task of this.store.list().filter((candidate) => candidate.state === "pending")) {
        const dependencies = task.depends_on.map((id) => this.store.get(id)).filter((item): item is PersistedTask => item !== undefined);
        if (dependencies.some((dependency) => ["failed", "cancelled", "orphaned", "blocked"].includes(dependency.state))) {
          task.state = "blocked";
          task.completed_at = this.now().toISOString();
          task.result = new BridgeError("DEPENDENCY_FAILED", "A dependency did not complete successfully.", false, {
            dependencies: dependencies.map(({ task_id, state }) => ({ task_id, state })),
          }).toFailure();
          this.store.put(task);
          this.event(task.task_id, "blocked", { dependencies: task.depends_on });
          progressed = true;
          continue;
        }
        if (!dependencies.every((dependency) => dependency.state === "completed")) continue;
        this.launch(task);
        progressed = true;
        if (this.active >= this.maxActive) break;
      }
    }
  }

  private launch(task: PersistedTask): void {
    const input = this.inputs.get(task.task_id);
    if (input === undefined) {
      task.state = "orphaned";
      task.completed_at = this.now().toISOString();
      task.result = new BridgeError("TASK_ORPHANED", "The task input is unavailable after process restart; automatic retry is disabled.").toFailure();
      this.store.put(task);
      this.event(task.task_id, "orphaned", { automatic_retry: false });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(task.task_id, controller);
    task.state = "running";
    task.started_at = this.now().toISOString();
    this.store.put(task);
    this.event(task.task_id, "started", { operation: task.operation });
    this.active += 1;
    void this.invoke(task.operation, { ...input, background_task_id: task.task_id, signal: controller.signal }).then((result) => {
      const current = this.store.get(task.task_id);
      if (current === undefined) return;
      current.result = result;
      current.completed_at = this.now().toISOString();
      current.state = result.status === "completed"
        ? "completed"
        : result.status === "failed" && result.error.code === "TASK_CANCELLED" ? "cancelled" : "failed";
      this.store.put(current);
      this.event(current.task_id, current.state === "completed" ? "completed" : current.state === "cancelled" ? "cancelled" : "failed", {
        error_code: result.status === "failed" ? result.error.code : null,
      });
    }).catch((error: unknown) => {
      const current = this.store.get(task.task_id);
      if (current === undefined) return;
      current.completed_at = this.now().toISOString();
      current.state = controller.signal.aborted ? "cancelled" : "failed";
      current.result = new BridgeError("WORKBUDDY_FAILED", "The background task failed unexpectedly.", false, {
        cause: error instanceof Error ? error.name : "UnknownError",
      }).toFailure();
      this.store.put(current);
      this.event(current.task_id, current.state === "cancelled" ? "cancelled" : "failed", {});
    }).finally(() => {
      this.controllers.delete(task.task_id);
      this.inputs.delete(task.task_id);
      this.active = Math.max(0, this.active - 1);
      this.pump();
    });
  }

  private view(record: PersistedTask, afterEventId = 0): BackgroundTaskView {
    const events = this.store.eventsAfter(record.task_id, afterEventId);
    const nextEventId = events.at(-1)?.event_id ?? afterEventId;
    return {
      task_id: record.task_id,
      task_key: record.task_key,
      batch_id: record.batch_id,
      task_label: record.task_label,
      operation: record.operation,
      state: record.state,
      created_at: record.created_at,
      started_at: record.started_at,
      completed_at: record.completed_at,
      cancellation_requested: record.cancellation_requested,
      depends_on: [...record.depends_on],
      events,
      next_event_id: nextEventId,
      ...(record.result === undefined ? {} : { result: record.result }),
    };
  }

  private event(taskId: string, type: TaskEvent["type"], data: Record<string, unknown>): void {
    this.store.appendEvent({ task_id: taskId, occurred_at: this.now().toISOString(), type, data });
  }

  private cleanup(): void {
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const task of this.store.list()) {
      if (["pending", "running"].includes(task.state) || task.completed_at === null) continue;
      if (new Date(task.completed_at).getTime() < cutoff) this.store.delete(task.task_id);
    }
  }

  private persistableInput(input: InvocationInput): InvocationInput {
    const { signal: _signal, ...stored } = input;
    return structuredClone(stored);
  }

  private assertAcyclic(specs: readonly BatchTaskStart[]): void {
    const dependencies = new Map(specs.map((spec) => [spec.taskKey, spec.dependsOnKeys ?? []]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw new BridgeError("INVALID_ARGUMENT", "Batch dependencies contain a cycle.", false, { task_key: key });
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dependency of dependencies.get(key) ?? []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of dependencies.keys()) visit(key);
  }
}

/** Backward-compatible adapter for callers that only start read-only plans. */
export class BackgroundPlanManager {
  private readonly manager: BackgroundTaskManager;

  constructor(
    invokePlan: (input: InvocationInput) => Promise<ToolResult>,
    maxRecords = 64,
    retentionMs = 60 * 60 * 1_000,
    now: () => Date = () => new Date(),
  ) {
    this.manager = new BackgroundTaskManager(
      (_operation, input) => invokePlan(input),
      new InMemoryTaskStore(),
      maxRecords,
      retentionMs,
      DEFAULT_MAX_CONCURRENCY,
      now,
    );
  }

  start(input: InvocationInput): BackgroundTaskView {
    return this.manager.start("plan", input);
  }

  status(taskId: string, afterEventId = 0): BackgroundTaskView { return this.manager.status(taskId, afterEventId); }
  cancel(taskId: string): BackgroundTaskView { return this.manager.cancel(taskId); }
}
