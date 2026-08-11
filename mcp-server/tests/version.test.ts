import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRuntimeVersions } from "../src/version.js";

describe("runtime version handshake", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function bundle(pluginVersion: string, skillVersion: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-version-"));
    roots.push(root);
    await mkdir(path.join(root, ".codex-plugin"));
    await mkdir(path.join(root, "skills", "workbuddy-delegation"), { recursive: true });
    await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ version: pluginVersion }));
    await writeFile(path.join(root, "skills", "workbuddy-delegation", "SKILL.md"), `Expected bridge version: \`${skillVersion}\``);
    return root;
  }

  it("reports a consistent 1.0 bundle even with a cachebuster", async () => {
    expect(await inspectRuntimeVersions(await bundle("1.0.1+codex.test", "1.0.1"))).toMatchObject({
      version_consistent: true, client_restart_required: false, diagnostic_code: "OK",
    });
  });

  it("reports a restart-required version mismatch", async () => {
    expect(await inspectRuntimeVersions(await bundle("0.5.0+codex.old", "1.0.1"))).toMatchObject({
      version_consistent: false, client_restart_required: true, diagnostic_code: "VERSION_MISMATCH",
    });
  });
});
