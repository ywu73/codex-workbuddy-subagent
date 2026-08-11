import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTaskStore, type PersistedTask } from "../src/task-store.js";

function task(state: PersistedTask["state"] = "pending"): PersistedTask {
  return {
    task_id: "wbt_00000000-0000-0000-0000-000000000001", task_key: "a", batch_id: null,
    task_label: "a", operation: "plan", state, created_at: "2026-08-11T00:00:00.000Z",
    started_at: state === "running" ? "2026-08-11T00:00:01.000Z" : null, completed_at: null,
    cancellation_requested: false, depends_on: [],
  };
}

describe("SQLite task store", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("persists tasks, events, approvals, and orphan recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-store-"));
    roots.push(root);
    const dbPath = path.join(root, "tasks.sqlite3");
    const first = new SqliteTaskStore(dbPath);
    first.create(task("running"));
    const eventId = first.appendEvent({ task_id: task().task_id, occurred_at: "2026-08-11T00:00:02.000Z", type: "started", data: {} });
    expect(first.redeemApproval("wba_1", "2026-08-11T01:00:00.000Z", "2026-08-11T00:00:03.000Z")).toBe(true);
    first.close();

    const second = new SqliteTaskStore(dbPath);
    expect(second.get(task().task_id)?.state).toBe("running");
    expect(second.eventsAfter(task().task_id, 0)[0]?.event_id).toBe(eventId);
    expect(second.redeemApproval("wba_1", "x", "y")).toBe(false);
    expect(second.markRunningOrphaned("2026-08-11T00:05:00.000Z")).toBe(1);
    expect(second.get(task().task_id)).toMatchObject({ state: "orphaned", completed_at: "2026-08-11T00:05:00.000Z" });
    second.close();
  });
});
