import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateCwd } from "../src/policy.js";

describe("validateCwd", () => {
  it("accepts an existing directory within an exact allowed root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-policy-"));
    const child = path.join(root, "project");
    await mkdir(child);
    expect(await validateCwd(child, [root])).toBe(await realpath(child));
  });

  it("rejects relative, root, home, and outside paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-policy-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "wb-outside-"));
    await expect(validateCwd("relative", [root])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(validateCwd("/", [root])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    await expect(validateCwd(os.homedir(), [root])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    await expect(validateCwd("/Applications", ["/Applications"])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    await expect(validateCwd("/private", ["/private"])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    await expect(validateCwd(outside, [root])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-policy-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "wb-outside-"));
    const link = path.join(root, "escape");
    await symlink(outside, link);
    await expect(validateCwd(link, [root])).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
  });
});
