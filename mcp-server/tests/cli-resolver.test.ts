import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveCli } from "../src/cli-resolver.js";
import { BridgeError } from "../src/errors.js";

describe("resolveCli", () => {
  it("prefers codebuddy on PATH and returns its real path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-resolver-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const real = path.join(root, "real-cli");
    await writeFile(real, "#!/bin/sh\nexit 0\n");
    await chmod(real, 0o755);
    await symlink(real, path.join(bin, "codebuddy"));
    expect(await resolveCli({ pathValue: bin, fixedCandidates: [] })).toBe(await realpath(real));
  });

  it("returns CLI_NOT_FOUND when no candidate exists", async () => {
    await expect(resolveCli({ pathValue: "", fixedCandidates: [] })).rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
  });

  it("returns CLI_UNEXECUTABLE for a non-executable candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-resolver-"));
    const candidate = path.join(root, "codebuddy");
    await writeFile(candidate, "not executable");
    await expect(resolveCli({ pathValue: root, fixedCandidates: [] })).rejects.toEqual(expect.any(BridgeError));
    await expect(resolveCli({ pathValue: root, fixedCandidates: [] })).rejects.toMatchObject({ code: "CLI_UNEXECUTABLE" });
  });
});
