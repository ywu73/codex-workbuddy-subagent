import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceIdentity {
  kind: "directory" | "git_repository" | "git_linked_worktree";
  root: string;
  lockKey: string;
  repositoryFingerprint: string | null;
}

async function existsGitMarker(candidate: string): Promise<"directory" | "file" | null> {
  try {
    const info = await lstat(path.join(candidate, ".git"));
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
  } catch {}
  return null;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export async function resolveWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  let current = await realpath(cwd);
  while (true) {
    const marker = await existsGitMarker(current);
    if (marker !== null) {
      const gitMarker = path.join(current, ".git");
      let gitDirectory: string;
      let kind: WorkspaceIdentity["kind"];
      if (marker === "directory") {
        gitDirectory = await realpath(gitMarker);
        kind = "git_repository";
      } else {
        const contents = await readFile(gitMarker, "utf8");
        const match = /^gitdir:\s*(.+)\s*$/im.exec(contents);
        if (match?.[1] === undefined) break;
        gitDirectory = await realpath(path.resolve(current, match[1]));
        kind = "git_linked_worktree";
      }
      let commonDirectory = gitDirectory;
      try {
        const common = (await readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
        commonDirectory = await realpath(path.resolve(gitDirectory, common));
      } catch {}
      return {
        kind,
        root: current,
        lockKey: `worktree:${current}`,
        repositoryFingerprint: fingerprint(commonDirectory),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const root = await realpath(cwd);
  return { kind: "directory", root, lockKey: `directory:${root}`, repositoryFingerprint: null };
}
