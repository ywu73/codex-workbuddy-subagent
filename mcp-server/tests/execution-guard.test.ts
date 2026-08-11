import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionGuard } from "../src/execution-guard.js";

describe("ExecutionGuard", () => {
  it("returns bounded change evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    await writeFile(path.join(root, "existing.txt"), "before\n");
    const guarded = await new ExecutionGuard().run(root, {
      allowed_paths: ["existing.txt", "src/**"],
      max_changed_files: 2,
      max_changed_bytes: 1024,
    }, async () => {
      await writeFile(path.join(root, "existing.txt"), "after\n");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "src")));
      await writeFile(path.join(root, "src", "new.txt"), "new\n");
      return "ok";
    });
    expect(guarded.value).toBe("ok");
    expect(guarded.changes).toMatchObject({
      created: ["src/new.txt"], modified: ["existing.txt"], deleted: [], changed_files: 2, scope_check: "passed",
    });
  });

  it("reports scope violations without rolling changes back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    await expect(new ExecutionGuard().run(root, { allowed_paths: ["src/**"] }, async () => {
      await writeFile(path.join(root, "outside.txt"), "changed\n");
    })).rejects.toMatchObject({
      code: "SCOPE_VIOLATION",
      details: expect.objectContaining({ side_effects_may_have_occurred: true, disallowed_paths: ["outside.txt"] }),
    });
    expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("changed\n");
  });

  it("attaches change evidence when delegated work fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    await expect(new ExecutionGuard().run(root, undefined, async () => {
      await writeFile(path.join(root, "partial.txt"), "partial\n");
      throw new Error("boom");
    })).rejects.toMatchObject({
      code: "WORKBUDDY_FAILED",
      details: expect.objectContaining({ side_effects_may_have_occurred: true }),
    });
  });

  it("rejects unsafe relative patterns before execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    let ran = false;
    await expect(new ExecutionGuard().run(root, { allowed_paths: ["../escape"] }, async () => { ran = true; })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ran).toBe(false);
  });

  it("fails closed when post-execution evidence exceeds its bound", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    await expect(new ExecutionGuard({ maxEntries: 1 }).run(root, undefined, async () => {
      await writeFile(path.join(root, "one.txt"), "1");
      await writeFile(path.join(root, "two.txt"), "2");
    })).rejects.toMatchObject({
      code: "SNAPSHOT_TOO_LARGE",
      details: expect.objectContaining({ side_effects_may_have_occurred: true, evidence_unavailable: true }),
    });
  });

  it("binds approvals to an unchanged workspace baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-guard-"));
    const guard = new ExecutionGuard();
    await writeFile(path.join(root, "one.txt"), "1");
    const preview = await guard.preview(root, { allowed_paths: ["one.txt"], max_changed_files: 1 });
    await guard.assertBaseline(root, preview.baseline_sha256);
    await writeFile(path.join(root, "one.txt"), "2");
    await expect(guard.assertBaseline(root, preview.baseline_sha256)).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });
});
