import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/approval.js";
import { InMemoryTaskStore } from "../src/task-store.js";

const preview = {
  baseline_sha256: "baseline", entries: 1, content_hashed_files: 1, metadata_only_files: 0,
  scope: { allowed_paths: ["work/**"], max_changed_files: 1, max_changed_bytes: 100, require_git_worktree: false },
};
const binding = {
  cwd: "/tmp/project", workspaceLockKey: "directory:/tmp/project", prompt: "edit", taskSpec: null,
  scope: { allowed_paths: ["work/**"], max_changed_files: 1, max_changed_bytes: 100 }, preview,
};

describe("approval tokens", () => {
  it("binds, signs, expires, and prevents replay", async () => {
    let now = new Date("2026-08-11T00:00:00.000Z");
    const manager = new ApprovalManager(new InMemoryTaskStore(), async () => Buffer.alloc(32, 7), 60_000, () => now);
    const prepared = await manager.prepare(binding);
    const payload = await manager.verify(prepared.approval_token, binding);
    manager.redeem(payload);
    expect(() => manager.redeem(payload)).toThrow(expect.objectContaining({ code: "APPROVAL_REPLAYED" }));
    now = new Date("2026-08-11T00:02:00.000Z");
    await expect(manager.verify(prepared.approval_token, binding)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });

  it("rejects any task or scope mutation", async () => {
    const manager = new ApprovalManager(new InMemoryTaskStore(), async () => Buffer.alloc(32, 8));
    const prepared = await manager.prepare(binding);
    await expect(manager.verify(prepared.approval_token, { ...binding, prompt: "different" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });
});
