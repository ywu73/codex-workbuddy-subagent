import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { BridgeError, normalizeError } from "./errors.js";

export interface ExecutionScope {
  allowed_paths?: readonly string[] | undefined;
  max_changed_files?: number | undefined;
  max_changed_bytes?: number | undefined;
  require_git_worktree?: boolean | undefined;
}

export interface ChangeEvidence {
  created: string[];
  modified: string[];
  deleted: string[];
  changed_files: number;
  changed_bytes: number;
  scope_check: "passed";
  coverage: {
    content_hashed_files: number;
    metadata_only_files: number;
    max_entries: number;
    max_hash_bytes: number;
  };
}

interface EntryFingerprint {
  fingerprint: string;
  size: number;
  contentHashed: boolean;
}

interface Snapshot {
  entries: Map<string, EntryFingerprint>;
  contentHashedFiles: number;
  metadataOnlyFiles: number;
}

export interface ExecutionPreview {
  baseline_sha256: string;
  entries: number;
  content_hashed_files: number;
  metadata_only_files: number;
  scope: {
    allowed_paths: readonly string[];
    max_changed_files: number;
    max_changed_bytes: number;
    require_git_worktree: boolean;
  };
}

export interface ExecutionGuardOptions {
  maxEntries?: number;
  maxHashBytes?: number;
  maxSingleFileHashBytes?: number;
  defaultMaxChangedFiles?: number;
  defaultMaxChangedBytes?: number;
}

function normalizedPattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new BridgeError("INVALID_ARGUMENT", "scope.allowed_paths must contain non-empty relative patterns without '..'.");
  }
  return normalized;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  return new RegExp(`${source}$`);
}

function allowed(relative: string, patterns: readonly RegExp[]): boolean {
  if (relative === ".git" || relative.startsWith(".git/")) return false;
  return patterns.length === 0 || patterns.some((pattern) => pattern.test(relative));
}

export class ExecutionGuard {
  private readonly maxEntries: number;
  private readonly maxHashBytes: number;
  private readonly maxSingleFileHashBytes: number;
  private readonly defaultMaxChangedFiles: number;
  private readonly defaultMaxChangedBytes: number;

  constructor(options: ExecutionGuardOptions = {}) {
    this.maxEntries = options.maxEntries ?? 50_000;
    this.maxHashBytes = options.maxHashBytes ?? 128 * 1024 * 1024;
    this.maxSingleFileHashBytes = options.maxSingleFileHashBytes ?? 4 * 1024 * 1024;
    this.defaultMaxChangedFiles = options.defaultMaxChangedFiles ?? 100;
    this.defaultMaxChangedBytes = options.defaultMaxChangedBytes ?? 10 * 1024 * 1024;
  }

  async preview(cwd: string, scope: ExecutionScope | undefined): Promise<ExecutionPreview> {
    const snapshot = await this.snapshot(cwd);
    return {
      baseline_sha256: this.snapshotDigest(snapshot),
      entries: snapshot.entries.size,
      content_hashed_files: snapshot.contentHashedFiles,
      metadata_only_files: snapshot.metadataOnlyFiles,
      scope: {
        allowed_paths: [...(scope?.allowed_paths ?? [])],
        max_changed_files: scope?.max_changed_files ?? this.defaultMaxChangedFiles,
        max_changed_bytes: scope?.max_changed_bytes ?? this.defaultMaxChangedBytes,
        require_git_worktree: scope?.require_git_worktree ?? false,
      },
    };
  }

  async assertBaseline(cwd: string, expectedSha256: string): Promise<void> {
    const current = this.snapshotDigest(await this.snapshot(cwd));
    if (current !== expectedSha256) {
      throw new BridgeError("APPROVAL_STALE", "The workspace changed after approval preparation; prepare a new approval.", false, {
        expected_baseline_sha256: expectedSha256,
        current_baseline_sha256: current,
      });
    }
  }

  async run<T>(cwd: string, scope: ExecutionScope | undefined, work: () => Promise<T>): Promise<{ value: T; changes: ChangeEvidence }> {
    const patterns = (scope?.allowed_paths ?? []).map(normalizedPattern).map(globRegex);
    const before = await this.snapshot(cwd);
    let value: T;
    try {
      value = await work();
    } catch (error) {
      const changes = await this.safeChangesAfterFailure(cwd, before);
      throw normalizeError(error).withDetails({
        side_effects_may_have_occurred: "unavailable" in changes || changes.changed_files > 0,
        changes,
      });
    }
    let after: Snapshot;
    try {
      after = await this.snapshot(cwd);
    } catch (error) {
      throw normalizeError(error).withDetails({
        side_effects_may_have_occurred: true,
        evidence_unavailable: true,
      });
    }
    const changes = this.diff(before, after);
    const disallowed = [...changes.created, ...changes.modified, ...changes.deleted].filter((relative) => !allowed(relative, patterns));
    const maxFiles = scope?.max_changed_files ?? this.defaultMaxChangedFiles;
    const maxBytes = scope?.max_changed_bytes ?? this.defaultMaxChangedBytes;
    if (disallowed.length > 0 || changes.changed_files > maxFiles || changes.changed_bytes > maxBytes) {
      throw new BridgeError(
        "SCOPE_VIOLATION",
        "WorkBuddy changed files outside the confirmed execution scope or exceeded its limits.",
        false,
        {
          side_effects_may_have_occurred: changes.changed_files > 0,
          disallowed_paths: disallowed.slice(0, 100),
          max_changed_files: maxFiles,
          max_changed_bytes: maxBytes,
          changes,
        },
      );
    }
    return { value, changes: { ...changes, scope_check: "passed" } };
  }

  private async safeChangesAfterFailure(cwd: string, before: Snapshot): Promise<Omit<ChangeEvidence, "scope_check"> | { unavailable: true; changed_files: 0 }> {
    try {
      return this.diff(before, await this.snapshot(cwd));
    } catch {
      return { unavailable: true, changed_files: 0 };
    }
  }

  private async snapshot(root: string): Promise<Snapshot> {
    const entries = new Map<string, EntryFingerprint>();
    let visited = 0;
    let hashedBytes = 0;
    let contentHashedFiles = 0;
    let metadataOnlyFiles = 0;

    const walk = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        visited += 1;
        if (visited > this.maxEntries) {
          throw new BridgeError("SNAPSHOT_TOO_LARGE", "The target contains too many entries for bounded execution evidence.", false, {
            max_entries: this.maxEntries,
          });
        }
        const absolute = path.join(directory, child.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const info = await lstat(absolute);
        if (child.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (child.isSymbolicLink()) {
          const target = await readlink(absolute);
          entries.set(relative, { fingerprint: `link:${target}`, size: Buffer.byteLength(target), contentHashed: true });
          contentHashedFiles += 1;
          continue;
        }
        if (!child.isFile()) {
          entries.set(relative, { fingerprint: `other:${info.mode}:${info.size}:${info.mtimeMs}`, size: info.size, contentHashed: false });
          metadataOnlyFiles += 1;
          continue;
        }
        const canHash = info.size <= this.maxSingleFileHashBytes && hashedBytes + info.size <= this.maxHashBytes;
        if (canHash) {
          const data = await readFile(absolute);
          entries.set(relative, { fingerprint: `sha256:${createHash("sha256").update(data).digest("hex")}`, size: info.size, contentHashed: true });
          hashedBytes += info.size;
          contentHashedFiles += 1;
        } else {
          entries.set(relative, { fingerprint: `meta:${info.mode}:${info.size}:${info.mtimeMs}`, size: info.size, contentHashed: false });
          metadataOnlyFiles += 1;
        }
      }
    };
    await walk(root);
    return { entries, contentHashedFiles, metadataOnlyFiles };
  }

  private diff(before: Snapshot, after: Snapshot): Omit<ChangeEvidence, "scope_check"> {
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    let changedBytes = 0;
    for (const [relative, current] of after.entries) {
      const previous = before.entries.get(relative);
      if (previous === undefined) {
        created.push(relative);
        changedBytes += current.size;
      } else if (previous.fingerprint !== current.fingerprint) {
        modified.push(relative);
        changedBytes += Math.max(previous.size, current.size);
      }
    }
    for (const [relative, previous] of before.entries) {
      if (!after.entries.has(relative)) {
        deleted.push(relative);
        changedBytes += previous.size;
      }
    }
    return {
      created,
      modified,
      deleted,
      changed_files: created.length + modified.length + deleted.length,
      changed_bytes: changedBytes,
      coverage: {
        content_hashed_files: after.contentHashedFiles,
        metadata_only_files: after.metadataOnlyFiles,
        max_entries: this.maxEntries,
        max_hash_bytes: this.maxHashBytes,
      },
    };
  }

  private snapshotDigest(snapshot: Snapshot): string {
    const hash = createHash("sha256");
    for (const [relative, entry] of snapshot.entries) {
      hash.update(relative).update("\0").update(entry.fingerprint).update("\0").update(String(entry.size)).update("\n");
    }
    return hash.digest("hex");
  }
}
