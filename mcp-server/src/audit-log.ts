import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

export interface AuditRecord {
  invocation_id: string;
  task_label: string | null;
  task_id?: string;
  approval_id?: string;
  operation: "plan" | "execute";
  cwd: string;
  started_at: string;
  completed_at: string;
  outcome: "completed" | "failed";
  error_code?: string;
  changed_files?: number;
  duration_ms?: number;
}

export interface AuditLog {
  readonly path: string | null;
  record(entry: AuditRecord): Promise<void>;
}

export class NullAuditLog implements AuditLog {
  readonly path = null;
  async record(_entry: AuditRecord): Promise<void> {}
}

export class FileAuditLog implements AuditLog {
  constructor(
    readonly path: string = process.env.WORKBUDDY_AUDIT_PATH ?? nodePath.join(os.homedir(), ".codex", "workbuddy-bridge", "audit.jsonl"),
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  async record(entry: AuditRecord): Promise<void> {
    await mkdir(nodePath.dirname(this.path), { recursive: true, mode: 0o700 });
    await this.compactIfNeeded();
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  private async compactIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;
    const contents = await readFile(this.path, "utf8");
    const tail = contents.slice(-Math.floor(this.maxBytes / 2));
    const firstNewline = tail.indexOf("\n");
    await writeFile(this.path, firstNewline >= 0 ? tail.slice(firstNewline + 1) : "", { encoding: "utf8", mode: 0o600 });
  }
}
