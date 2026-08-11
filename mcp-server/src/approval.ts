import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";
import type { ExecutionPreview, ExecutionScope } from "./execution-guard.js";
import type { TaskStore } from "./task-store.js";

export interface ApprovalPayload {
  version: "1";
  approval_id: string;
  expires_at: string;
  cwd: string;
  workspace_lock_key: string;
  task_sha256: string;
  scope_sha256: string;
  baseline_sha256: string;
}

export interface ApprovalBinding {
  cwd: string;
  workspaceLockKey: string;
  prompt: string;
  taskSpec: unknown;
  scope: ExecutionScope | undefined;
  preview: ExecutionPreview;
}

export interface PreparedApproval {
  approval_id: string;
  approval_token: string;
  expires_at: string;
  binding: {
    cwd: string;
    workspace_lock_key: string;
    task_sha256: string;
    scope_sha256: string;
    baseline_sha256: string;
  };
  preview: ExecutionPreview;
  confirmation_required: true;
  reusable: false;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

async function defaultSecret(): Promise<Buffer> {
  const keyPath = process.env.WORKBUDDY_APPROVAL_KEY_PATH ?? path.join(os.homedir(), ".codex", "workbuddy-bridge", "approval.key");
  await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(keyPath);
    await chmod(keyPath, 0o600);
    if (existing.length < 32) throw new BridgeError("APPROVAL_INVALID", "The approval signing key is invalid.");
    return existing;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    const secret = randomBytes(32);
    try {
      await writeFile(keyPath, secret, { flag: "wx", mode: 0o600 });
      return secret;
    } catch {
      const raced = await readFile(keyPath);
      await chmod(keyPath, 0o600);
      return raced;
    }
  }
}

export class ApprovalManager {
  constructor(
    private readonly store: TaskStore,
    private readonly secretProvider: () => Promise<Buffer> = defaultSecret,
    private readonly ttlMs = 10 * 60 * 1_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepare(binding: ApprovalBinding): Promise<PreparedApproval> {
    const payload: ApprovalPayload = {
      version: "1",
      approval_id: `wba_${randomUUID()}`,
      expires_at: new Date(this.now().getTime() + this.ttlMs).toISOString(),
      cwd: binding.cwd,
      workspace_lock_key: binding.workspaceLockKey,
      task_sha256: sha256({ prompt: binding.prompt, task_spec: binding.taskSpec }),
      scope_sha256: sha256(binding.scope ?? {}),
      baseline_sha256: binding.preview.baseline_sha256,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", await this.secretProvider()).update(encoded).digest("base64url");
    return {
      approval_id: payload.approval_id,
      approval_token: `${encoded}.${signature}`,
      expires_at: payload.expires_at,
      binding: {
        cwd: payload.cwd,
        workspace_lock_key: payload.workspace_lock_key,
        task_sha256: payload.task_sha256,
        scope_sha256: payload.scope_sha256,
        baseline_sha256: payload.baseline_sha256,
      },
      preview: binding.preview,
      confirmation_required: true,
      reusable: false,
    };
  }

  async verify(token: string, binding: Omit<ApprovalBinding, "preview">): Promise<ApprovalPayload> {
    const [encoded, suppliedSignature, extra] = token.split(".");
    if (!encoded || !suppliedSignature || extra !== undefined) throw new BridgeError("APPROVAL_INVALID", "The approval token is malformed.");
    const expectedSignature = createHmac("sha256", await this.secretProvider()).update(encoded).digest();
    let actualSignature: Buffer;
    try { actualSignature = Buffer.from(suppliedSignature, "base64url"); } catch { throw new BridgeError("APPROVAL_INVALID", "The approval signature is malformed."); }
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new BridgeError("APPROVAL_INVALID", "The approval signature is invalid.");
    }
    let payload: ApprovalPayload;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ApprovalPayload; }
    catch { throw new BridgeError("APPROVAL_INVALID", "The approval payload is invalid."); }
    if (payload.version !== "1" || !payload.approval_id?.startsWith("wba_")) throw new BridgeError("APPROVAL_INVALID", "The approval payload version is unsupported.");
    if (new Date(payload.expires_at).getTime() <= this.now().getTime()) throw new BridgeError("APPROVAL_EXPIRED", "The approval token has expired.");
    const matches = payload.cwd === binding.cwd
      && payload.workspace_lock_key === binding.workspaceLockKey
      && payload.task_sha256 === sha256({ prompt: binding.prompt, task_spec: binding.taskSpec })
      && payload.scope_sha256 === sha256(binding.scope ?? {});
    if (!matches) throw new BridgeError("APPROVAL_INVALID", "The approval token does not match this exact task, workspace, and scope.");
    return payload;
  }

  redeem(payload: ApprovalPayload): void {
    if (!this.store.redeemApproval(payload.approval_id, payload.expires_at, this.now().toISOString())) {
      throw new BridgeError("APPROVAL_REPLAYED", "The approval token has already been used.");
    }
  }
}
