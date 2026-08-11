import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditLog, NullAuditLog } from "../src/audit-log.js";
import { ApprovalManager } from "../src/approval.js";
import { BackgroundPlanManager, BackgroundTaskManager } from "../src/background-plan-manager.js";
import { DelegationController } from "../src/delegation-controller.js";
import { WorkBuddyService } from "../src/service.js";
import { InMemoryTaskStore } from "../src/task-store.js";

async function snapshot(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const info = await stat(absolute);
      hash.update(`${relative}\0${info.mode}\0${info.size}\0${info.mtimeMs}\0`);
      if (entry.isDirectory()) await walk(absolute);
      else hash.update(await readFile(absolute));
    }
  }
  await walk(root);
  return hash.digest("hex");
}

describe.skipIf(process.env.WORKBUDDY_E2E !== "1")("installed WorkBuddy E2E", () => {
  it("probes health, preserves plan target state, and performs one bounded execute", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workbuddy-bridge-e2e-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "# Sample Project\n");
    await writeFile(path.join(root, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
    await writeFile(path.join(root, "sentinel.txt"), "do not change\n");
    const auditRoot = await mkdtemp(path.join(os.tmpdir(), "workbuddy-bridge-audit-"));
    const auditPath = path.join(auditRoot, "audit.jsonl");
    const service = new WorkBuddyService([root], undefined, { auditLog: new FileAuditLog(auditPath) });

    expect(await service.health()).toMatchObject({ status: "ready" });
    const beforePlan = await snapshot(root);
    const plan = await service.invoke("plan", {
      prompt: "Read src/add.ts and propose a concise test plan. Do not create, modify, rename, or delete any file.",
      cwd: root,
      max_turns: 4,
      timeout_seconds: 180,
    });
    expect(await snapshot(root)).toBe(beforePlan);
    if (plan.status === "failed") throw new Error(`plan failed: ${JSON.stringify(plan)}`);
    expect(plan).toMatchObject({
      status: "completed", operation: "plan", changes: null,
      invocation_id: expect.stringMatching(/^wb_/), output: { format: expect.stringMatching(/^json/) },
    });

    const execute = await service.invoke("execute", {
      prompt: "Create exactly one file at src/add.test.ts containing a small self-contained test for src/add.ts. Do not modify or delete any existing file and do not create any other file.",
      cwd: root,
      max_turns: 6,
      timeout_seconds: 300,
      scope: { allowed_paths: ["src/add.test.ts"], max_changed_files: 1, max_changed_bytes: 20_000 },
    });
    expect(execute).toMatchObject({
      status: "completed", operation: "execute",
      changes: { created: ["src/add.test.ts"], modified: [], deleted: [], changed_files: 1, scope_check: "passed" },
    });
    expect(await readFile(path.join(root, "sentinel.txt"), "utf8")).toBe("do not change\n");
    expect(await readFile(path.join(root, "src", "add.ts"), "utf8")).toBe("export const add = (a: number, b: number) => a + b;\n");
    const files = (await readdir(path.join(root, "src"))).sort();
    expect(files).toEqual(["add.test.ts", "add.ts"]);
    const auditLines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(auditLines).toHaveLength(2);
    expect(auditLines.map((line) => line.outcome)).toEqual(["completed", "completed"]);
    expect(auditLines[1]).toMatchObject({ operation: "execute", changed_files: 1 });
  }, 520_000);

  it("runs parallel plans and isolated executes with task correlation", async () => {
    const roots = await Promise.all(["alpha", "beta", "gamma"].map(async (name) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `workbuddy-bridge-${name}-`));
      await writeFile(path.join(root, "README.md"), `# ${name}\n`);
      await writeFile(path.join(root, "sentinel.txt"), `${name} sentinel\n`);
      return root;
    }));
    const service = new WorkBuddyService(roots, undefined, { auditLog: new NullAuditLog() });
    const beforePlans = await Promise.all(roots.map(snapshot));

    const plans = await Promise.all(roots.map((root, index) => service.invoke("plan", {
      prompt: "Read README.md and briefly describe the project name. Do not create, modify, rename, or delete any file.",
      cwd: root,
      task_label: `plan-${index + 1}`,
      max_turns: 3,
      timeout_seconds: 180,
    })));

    expect(await Promise.all(roots.map(snapshot))).toEqual(beforePlans);
    plans.forEach((plan, index) => {
      if (plan.status === "failed") throw new Error(`parallel plan failed: ${JSON.stringify(plan)}`);
      expect(plan).toMatchObject({
        status: "completed",
        operation: "plan",
        task_label: `plan-${index + 1}`,
      });
    });

    const executes = await Promise.all(roots.slice(0, 2).map((root, index) => service.invoke("execute", {
      prompt: `Create exactly one file named result.txt containing exactly \"task ${index + 1} complete\\n\". Do not modify or delete any existing file and do not create any other file.`,
      cwd: root,
      task_label: `execute-${index + 1}`,
      max_turns: 5,
      timeout_seconds: 300,
      scope: { allowed_paths: ["result.txt"], max_changed_files: 1, max_changed_bytes: 1_024 },
    })));

    executes.forEach((execute, index) => {
      if (execute.status === "failed") throw new Error(`parallel execute failed: ${JSON.stringify(execute)}`);
      expect(execute).toMatchObject({
        status: "completed",
        operation: "execute",
        task_label: `execute-${index + 1}`,
        changes: { created: ["result.txt"], changed_files: 1, scope_check: "passed" },
      });
    });
    for (const [index, root] of roots.entries()) {
      expect(await readFile(path.join(root, "sentinel.txt"), "utf8")).toBe(`${["alpha", "beta", "gamma"][index]} sentinel\n`);
      const files = (await readdir(root)).sort();
      if (index < 2) {
        expect(await readFile(path.join(root, "result.txt"), "utf8")).toBe(`task ${index + 1} complete\n`);
        expect(files).toEqual(["README.md", "result.txt", "sentinel.txt"]);
      } else {
        expect(files).toEqual(["README.md", "sentinel.txt"]);
      }
    }

    const background = new BackgroundPlanManager((input) => service.invoke("plan", input));
    const started = background.start({
      prompt: "Read README.md and state the project name in one sentence. Do not modify any file.",
      cwd: roots[2]!, task_label: "background-plan", max_turns: 3, timeout_seconds: 180,
    });
    let backgroundStatus = background.status(started.task_id);
    const deadline = Date.now() + 190_000;
    while (backgroundStatus.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      backgroundStatus = background.status(started.task_id);
    }
    expect(backgroundStatus).toMatchObject({ state: "completed", task_label: "background-plan", result: { status: "completed" } });
  }, 520_000);

  it("runs an approved background execute and a dependency batch", async () => {
    const roots = await Promise.all(["approved", "batch"].map(async (name) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `workbuddy-bridge-${name}-`));
      await writeFile(path.join(root, "README.md"), `# ${name}\n`);
      return root;
    }));
    const service = new WorkBuddyService(roots, undefined, { auditLog: new NullAuditLog() });
    const store = new InMemoryTaskStore();
    const background = new BackgroundTaskManager((operation, invocation) => service.invoke(operation, invocation), store);
    const controller = new DelegationController(service, background, new ApprovalManager(store, async () => Buffer.alloc(32, 9)));
    const edit = {
      task_spec: {
        version: "1" as const,
        objective: "Create exactly one file named approved.txt containing exactly approved background execution followed by a newline. Do not modify or create any other file.",
        task_label: "approved-background",
        acceptance_criteria: ["approved.txt has the requested content"],
        expected_artifacts: ["approved.txt"],
        constraints: { allowed_paths: ["approved.txt"], max_changed_files: 1, max_changed_bytes: 1_024 },
      },
      cwd: roots[0]!, max_turns: 5, timeout_seconds: 300,
    };
    const approval = await controller.prepareExecute(edit);
    const started = await controller.startExecute({ ...edit, approval_token: approval.approval_token });
    let status = controller.status(started.task_id);
    const executeDeadline = Date.now() + 310_000;
    while (["pending", "running"].includes(status.state) && Date.now() < executeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = controller.status(started.task_id, status.next_event_id);
    }
    expect(status).toMatchObject({
      state: "completed",
      result: {
        status: "completed",
        envelope: {
          task_id: started.task_id,
          approval_id: approval.approval_id,
          acceptance: [{ status: "not_evaluated" }],
          artifacts: [{ path: "approved.txt", exists: true }],
        },
      },
    });
    expect(await readFile(path.join(roots[0]!, "approved.txt"), "utf8")).toBe("approved background execution\n");

    const batch = await controller.startBatch([
      {
        task_key: "read-approved", operation: "plan", depends_on: [], cwd: roots[0]!, max_turns: 3, timeout_seconds: 180,
        prompt: "Read README.md and approved.txt and summarize them in one sentence. Do not modify files.", task_label: "batch-first",
      },
      {
        task_key: "read-batch", operation: "plan", depends_on: ["read-approved"], cwd: roots[1]!, max_turns: 3, timeout_seconds: 180,
        prompt: "Read README.md and state its heading. Do not modify files.", task_label: "batch-second",
      },
    ]);
    let batchStatus = controller.batchStatus(batch.batch_id);
    const batchDeadline = Date.now() + 370_000;
    while (batchStatus.state === "running" && Date.now() < batchDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      batchStatus = controller.batchStatus(batch.batch_id);
    }
    expect(batchStatus).toMatchObject({ state: "completed", tasks: [{ state: "completed" }, { state: "completed" }] });
  }, 700_000);
});
