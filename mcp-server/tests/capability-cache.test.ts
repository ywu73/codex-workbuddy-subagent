import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityCache } from "../src/capability-cache.js";

describe("CapabilityCache", () => {
  it("collapses concurrent probes and expires by TTL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-cache-"));
    const executable = path.join(root, "codebuddy");
    await writeFile(executable, "binary");
    let now = 0;
    let calls = 0;
    const cache = new CapabilityCache<string>(100, () => now);
    const load = async () => { calls += 1; return "ready"; };
    await expect(Promise.all([cache.get(executable, load), cache.get(executable, load)])).resolves.toEqual(["ready", "ready"]);
    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, populated: true });
    now = 101;
    await cache.get(executable, load);
    expect(calls).toBe(2);
  });

  it("does not cache failed probes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-cache-"));
    const executable = path.join(root, "codebuddy");
    await writeFile(executable, "binary");
    const cache = new CapabilityCache<string>();
    let calls = 0;
    const load = async () => { calls += 1; throw new Error("failed"); };
    await expect(cache.get(executable, load)).rejects.toThrow("failed");
    await expect(cache.get(executable, load)).rejects.toThrow("failed");
    expect(calls).toBe(2);
  });
});
