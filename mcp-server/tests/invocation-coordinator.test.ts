import { describe, expect, it } from "vitest";
import { InvocationCoordinator } from "../src/invocation-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("InvocationCoordinator", () => {
  it("defaults to four concurrent operations", () => {
    expect(new InvocationCoordinator().maxConcurrency).toBe(4);
  });

  it("allows overlapping plans for one directory but rejects an execute conflict", async () => {
    const coordinator = new InvocationCoordinator(3);
    const first = deferred<string>();
    const second = deferred<string>();
    const planA = coordinator.run("plan", "/project", "a", () => first.promise);
    const planB = coordinator.run("plan", "/project", "b", () => second.promise);

    await expect(coordinator.run("execute", "/project", "write", async () => "no")).rejects.toMatchObject({
      code: "DIRECTORY_LOCKED",
      retryable: true,
    });
    first.resolve("a");
    second.resolve("b");
    await expect(Promise.all([planA, planB])).resolves.toEqual(["a", "b"]);
  });

  it("makes execute exclusive and releases the directory after completion", async () => {
    const coordinator = new InvocationCoordinator(3);
    const gate = deferred<string>();
    const running = coordinator.run("execute", "/project", "writer-a", () => gate.promise);
    await expect(coordinator.run("plan", "/project", "reader", async () => "no")).rejects.toMatchObject({ code: "DIRECTORY_LOCKED" });
    await expect(coordinator.run("execute", "/project", "writer-b", async () => "no")).rejects.toMatchObject({ code: "DIRECTORY_LOCKED" });
    gate.resolve("done");
    await expect(running).resolves.toBe("done");
    await expect(coordinator.run("execute", "/project", "writer-c", async () => "next")).resolves.toBe("next");
  });

  it("allows executes in different directories up to the global limit", async () => {
    const coordinator = new InvocationCoordinator(2);
    const first = deferred<string>();
    const second = deferred<string>();
    const a = coordinator.run("execute", "/a", "a", () => first.promise);
    const b = coordinator.run("execute", "/b", "b", () => second.promise);
    await expect(coordinator.run("plan", "/c", "c", async () => "no")).rejects.toMatchObject({
      code: "BRIDGE_BUSY",
      retryable: true,
      details: { max_concurrency: 2, active: 2, task_label: "c" },
    });
    first.resolve("a");
    second.resolve("b");
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
  });

  it("releases capacity and directory state after a failed task", async () => {
    const coordinator = new InvocationCoordinator(1);
    await expect(coordinator.run("execute", "/project", "failing", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(coordinator.run("plan", "/project", "recovery", async () => "ok")).resolves.toBe("ok");
  });

  it("rejects invalid concurrency configuration", () => {
    expect(() => new InvocationCoordinator(0)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => new InvocationCoordinator(9)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("locks different subdirectories that share one worktree identity", async () => {
    const coordinator = new InvocationCoordinator(3);
    const gate = deferred<string>();
    const running = coordinator.run("execute", "/repo/src", "writer", () => gate.promise, "worktree:/repo");
    await expect(coordinator.run("execute", "/repo/tests", "other", async () => "no", "worktree:/repo")).rejects.toMatchObject({
      code: "DIRECTORY_LOCKED",
    });
    gate.resolve("done");
    await running;
  });
});
