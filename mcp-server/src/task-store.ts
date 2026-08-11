import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";
import type { ToolResult } from "./service.js";

export type PersistedTaskState = "pending" | "running" | "completed" | "failed" | "cancelled" | "orphaned" | "blocked";

export interface PersistedTask {
  task_id: string;
  task_key: string | null;
  batch_id: string | null;
  task_label: string | null;
  operation: "plan" | "execute";
  state: PersistedTaskState;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancellation_requested: boolean;
  depends_on: string[];
  result?: ToolResult;
}

export interface TaskEvent {
  event_id: number;
  task_id: string;
  occurred_at: string;
  type: "created" | "started" | "cancel_requested" | "completed" | "failed" | "cancelled" | "orphaned" | "blocked";
  data: Record<string, unknown>;
}

export interface TaskStore {
  readonly path: string | null;
  create(task: PersistedTask): void;
  put(task: PersistedTask): void;
  get(taskId: string): PersistedTask | undefined;
  list(): PersistedTask[];
  appendEvent(event: Omit<TaskEvent, "event_id">): number;
  eventsAfter(taskId: string, afterEventId: number, limit?: number): TaskEvent[];
  markRunningOrphaned(now: string): number;
  delete(taskId: string): void;
  redeemApproval(approvalId: string, expiresAt: string, redeemedAt: string): boolean;
  close(): void;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class InMemoryTaskStore implements TaskStore {
  readonly path = null;
  private readonly tasks = new Map<string, PersistedTask>();
  private readonly events: TaskEvent[] = [];
  private readonly approvals = new Set<string>();
  private nextEventId = 1;

  create(task: PersistedTask): void {
    if (this.tasks.has(task.task_id)) throw new Error("duplicate task id");
    this.tasks.set(task.task_id, clone(task));
  }
  put(task: PersistedTask): void { this.tasks.set(task.task_id, clone(task)); }
  get(taskId: string): PersistedTask | undefined {
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : clone(task);
  }
  list(): PersistedTask[] { return [...this.tasks.values()].map(clone); }
  appendEvent(event: Omit<TaskEvent, "event_id">): number {
    const eventId = this.nextEventId++;
    this.events.push({ ...clone(event), event_id: eventId });
    return eventId;
  }
  eventsAfter(taskId: string, afterEventId: number, limit = 100): TaskEvent[] {
    return this.events.filter((event) => event.task_id === taskId && event.event_id > afterEventId).slice(0, limit).map(clone);
  }
  markRunningOrphaned(now: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "running" || task.state === "pending") {
        task.state = "orphaned";
        task.completed_at = now;
        count += 1;
      }
    }
    return count;
  }
  delete(taskId: string): void { this.tasks.delete(taskId); }
  redeemApproval(approvalId: string, _expiresAt: string, _redeemedAt: string): boolean {
    if (this.approvals.has(approvalId)) return false;
    this.approvals.add(approvalId);
    return true;
  }
  close(): void {}
}

function defaultDbPath(): string {
  return process.env.WORKBUDDY_TASK_DB_PATH ?? path.join(os.homedir(), ".codex", "workbuddy-bridge", "tasks.sqlite3");
}

function literal(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function encodeJson(value: unknown): string { return literal(JSON.stringify(value)); }

function decodeTask(row: Record<string, unknown>): PersistedTask {
  return {
    task_id: String(row.task_id),
    task_key: row.task_key === null ? null : String(row.task_key),
    batch_id: row.batch_id === null ? null : String(row.batch_id),
    task_label: row.task_label === null ? null : String(row.task_label),
    operation: row.operation as "plan" | "execute",
    state: row.state as PersistedTaskState,
    created_at: String(row.created_at),
    started_at: row.started_at === null ? null : String(row.started_at),
    completed_at: row.completed_at === null ? null : String(row.completed_at),
    cancellation_requested: Number(row.cancellation_requested) === 1,
    depends_on: JSON.parse(String(row.depends_on_json)) as string[],
    ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) as ToolResult }),
  };
}

export class SqliteTaskStore implements TaskStore {
  readonly path: string;
  private readonly sqliteExecutable: string;

  constructor(dbPath = defaultDbPath(), sqliteExecutable = process.env.WORKBUDDY_SQLITE_PATH ?? "/usr/bin/sqlite3") {
    this.path = path.resolve(dbPath);
    this.sqliteExecutable = sqliteExecutable;
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    this.run(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, task_key TEXT, batch_id TEXT, task_label TEXT,
        operation TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, cancellation_requested INTEGER NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}', depends_on_json TEXT NOT NULL, result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
      CREATE TABLE IF NOT EXISTS task_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL, type TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, event_id);
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, redeemed_at TEXT NOT NULL
      );
      UPDATE tasks SET input_json='{}' WHERE input_json <> '{}';
    `);
    chmodSync(this.path, 0o600);
  }

  create(task: PersistedTask): void {
    this.run(`INSERT INTO tasks(task_id,task_key,batch_id,task_label,operation,state,created_at,started_at,completed_at,
      cancellation_requested,input_json,depends_on_json,result_json) VALUES (
      ${literal(task.task_id)},${literal(task.task_key)},${literal(task.batch_id)},${literal(task.task_label)},
      ${literal(task.operation)},${literal(task.state)},${literal(task.created_at)},${literal(task.started_at)},${literal(task.completed_at)},
      ${task.cancellation_requested ? 1 : 0},'{}',${encodeJson(task.depends_on)},${task.result === undefined ? "NULL" : encodeJson(task.result)}
    );`);
  }

  put(task: PersistedTask): void {
    this.run(`UPDATE tasks SET task_key=${literal(task.task_key)},batch_id=${literal(task.batch_id)},task_label=${literal(task.task_label)},
      operation=${literal(task.operation)},state=${literal(task.state)},created_at=${literal(task.created_at)},started_at=${literal(task.started_at)},
      completed_at=${literal(task.completed_at)},cancellation_requested=${task.cancellation_requested ? 1 : 0},input_json='{}',
      depends_on_json=${encodeJson(task.depends_on)},result_json=${task.result === undefined ? "NULL" : encodeJson(task.result)}
      WHERE task_id=${literal(task.task_id)};`);
  }

  get(taskId: string): PersistedTask | undefined {
    const row = this.query("SELECT * FROM tasks WHERE task_id=" + literal(taskId) + " LIMIT 1;")[0];
    return row === undefined ? undefined : decodeTask(row);
  }
  list(): PersistedTask[] { return this.query("SELECT * FROM tasks ORDER BY created_at, task_id;").map(decodeTask); }

  appendEvent(event: Omit<TaskEvent, "event_id">): number {
    const rows = this.query(`INSERT INTO task_events(task_id,occurred_at,type,data_json) VALUES (
      ${literal(event.task_id)},${literal(event.occurred_at)},${literal(event.type)},${encodeJson(event.data)}
    ); SELECT last_insert_rowid() AS event_id;`);
    return Number(rows.at(-1)?.event_id ?? 0);
  }

  eventsAfter(taskId: string, afterEventId: number, limit = 100): TaskEvent[] {
    return this.query(`SELECT * FROM task_events WHERE task_id=${literal(taskId)} AND event_id>${Math.max(0, afterEventId)}
      ORDER BY event_id LIMIT ${Math.max(1, Math.min(100, limit))};`).map((row) => ({
      event_id: Number(row.event_id), task_id: String(row.task_id), occurred_at: String(row.occurred_at),
      type: row.type as TaskEvent["type"], data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    }));
  }

  markRunningOrphaned(now: string): number {
    const rows = this.query(`UPDATE tasks SET state='orphaned',completed_at=${literal(now)} WHERE state IN ('running','pending');
      SELECT changes() AS changed;`);
    return Number(rows.at(-1)?.changed ?? 0);
  }

  delete(taskId: string): void {
    this.run(`BEGIN IMMEDIATE; DELETE FROM task_events WHERE task_id=${literal(taskId)};
      DELETE FROM tasks WHERE task_id=${literal(taskId)}; COMMIT;`);
  }

  redeemApproval(approvalId: string, expiresAt: string, redeemedAt: string): boolean {
    const rows = this.query(`INSERT OR IGNORE INTO approvals(approval_id,expires_at,redeemed_at) VALUES (
      ${literal(approvalId)},${literal(expiresAt)},${literal(redeemedAt)}
    ); SELECT changes() AS changed;`);
    return Number(rows.at(-1)?.changed ?? 0) === 1;
  }

  close(): void {}

  private run(sql: string): void { this.execute(sql, false); }
  private query(sql: string): Record<string, unknown>[] {
    const output = this.execute(sql, true).trim();
    return output === "" ? [] : JSON.parse(output) as Record<string, unknown>[];
  }
  private execute(sql: string, json: boolean): string {
    try {
      return execFileSync(this.sqliteExecutable, [...(json ? ["-json"] : []), this.path], {
        input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new BridgeError("WORKBUDDY_FAILED", "The persistent WorkBuddy task store failed.", false, {
        cause: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
