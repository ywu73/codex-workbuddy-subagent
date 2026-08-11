import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceIdentity } from "../src/workspace-identity.js";

describe("workspace identity", () => {
  it("maps repository subdirectories to one worktree lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-workspace-"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "src"));
    const resolvedRoot = await realpath(root);
    await expect(resolveWorkspaceIdentity(path.join(root, "src"))).resolves.toMatchObject({
      kind: "git_repository", root: resolvedRoot, lockKey: `worktree:${resolvedRoot}`,
    });
  });

  it("recognizes a linked worktree marker without exposing the git directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "wb-workspace-"));
    const common = path.join(base, "common.git");
    const gitDirectory = path.join(common, "worktrees", "task");
    const worktree = path.join(base, "task");
    await mkdir(gitDirectory, { recursive: true });
    await mkdir(worktree);
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
    await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
    const identity = await resolveWorkspaceIdentity(worktree);
    const resolvedWorktree = await realpath(worktree);
    expect(identity).toMatchObject({ kind: "git_linked_worktree", root: resolvedWorktree, lockKey: `worktree:${resolvedWorktree}` });
    expect(identity.repositoryFingerprint).toMatch(/^[a-f0-9]{24}$/);
  });

  it("uses the exact directory outside Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wb-workspace-"));
    const resolvedRoot = await realpath(root);
    await expect(resolveWorkspaceIdentity(root)).resolves.toEqual({
      kind: "directory", root: resolvedRoot, lockKey: `directory:${resolvedRoot}`, repositoryFingerprint: null,
    });
  });
});
