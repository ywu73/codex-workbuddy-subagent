import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process-runner.js";

describe("runProcess", () => {
  it("passes shell metacharacters as a literal argument", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-runner-"));
    const output = path.join(root, "argument.txt");
    const injected = path.join(root, "injected.txt");
    const prompt = `literal; touch ${injected}; $(touch ${injected}); \`touch ${injected}\``;
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", output, prompt],
      cwd: root,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(output, "utf8")).toBe(prompt);
    await expect(access(injected)).rejects.toBeTruthy();
  });

  it("terminates a timed out child", async () => {
    await expect(runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("returns an output limit error with truncation evidence", async () => {
    await expect(runProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      timeoutMs: 5_000,
      maxStdoutBytes: 64,
    })).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE", details: { truncated: true } });
  });

  it("terminates a child when its abort signal is cancelled", async () => {
    const controller = new AbortController();
    const running = runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toMatchObject({ code: "TASK_CANCELLED", details: { cancelled: true } });
  });
});
