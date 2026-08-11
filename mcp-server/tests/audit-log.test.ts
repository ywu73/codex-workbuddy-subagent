import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditLog } from "../src/audit-log.js";

describe("FileAuditLog", () => {
  it("writes only bounded invocation metadata as JSONL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-audit-"));
    const auditPath = path.join(root, "audit.jsonl");
    const log = new FileAuditLog(auditPath, 1024);
    await log.record({
      invocation_id: "wb_test", task_label: "security", operation: "plan", cwd: "/project",
      started_at: "2026-08-11T00:00:00.000Z", completed_at: "2026-08-11T00:00:01.000Z",
      outcome: "completed", duration_ms: 1000,
    });
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ invocation_id: "wb_test", outcome: "completed", operation: "plan" });
    expect(parsed).not.toHaveProperty("prompt");
    expect(parsed).not.toHaveProperty("result");
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
  });
});
