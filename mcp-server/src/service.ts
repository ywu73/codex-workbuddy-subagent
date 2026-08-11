import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { FileAuditLog, type AuditLog, type AuditRecord } from "./audit-log.js";
import { probeCli, type CliProbe } from "./capability-probe.js";
import { CapabilityCache } from "./capability-cache.js";
import { resolveCli } from "./cli-resolver.js";
import type { AllowedRootsProvider } from "./client-roots.js";
import { BridgeError, normalizeError, type FailureResult } from "./errors.js";
import { ExecutionGuard, type ChangeEvidence, type ExecutionScope } from "./execution-guard.js";
import { InvocationCoordinator } from "./invocation-coordinator.js";
import { configuredAllowedRoots, validateCwd } from "./policy.js";
import { runProcess } from "./process-runner.js";
import { adaptCliResult, processFailure, type OutputDiagnostics } from "./result-adapter.js";
import { validateResultSchema } from "./schemas.js";
import {
  acceptanceEvidence,
  normalizeTaskContract,
  type ArtifactEvidence,
  type TaskSpec,
} from "./task-contract.js";
import { BRIDGE_VERSION, PROTOCOL_VERSION, TASK_SPEC_VERSION, inspectRuntimeVersions, type RuntimeVersionInfo } from "./version.js";
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "./workspace-identity.js";

export interface InvocationInput {
  prompt?: string | undefined;
  cwd: string;
  max_turns: number;
  timeout_seconds: number;
  result_schema?: Record<string, unknown> | undefined;
  task_label?: string | undefined;
  scope?: ExecutionScope | undefined;
  signal?: AbortSignal | undefined;
  task_spec?: TaskSpec | undefined;
  /** Internal fields set only by the persistent controller, never exposed in MCP input schemas. */
  approved_baseline_sha256?: string | undefined;
  approval_id?: string | undefined;
  background_task_id?: string | undefined;
}

export interface SuccessResult {
  status: "completed";
  operation: "plan" | "execute";
  result: unknown;
  summary: string;
  cwd: string;
  binary_version: string;
  duration_ms: number;
  exit_code: 0;
  warnings: string[];
  truncated: false;
  task_label: string | null;
  invocation_id: string;
  started_at: string;
  output: OutputDiagnostics;
  workspace: {
    kind: WorkspaceIdentity["kind"];
    root: string;
    repository_fingerprint: string | null;
  };
  changes: ChangeEvidence | null;
  protocol_version: typeof PROTOCOL_VERSION;
  task_spec_version: typeof TASK_SPEC_VERSION;
  envelope: {
    invocation_id: string;
    task_id: string | null;
    parent_task_id: string | null;
    approval_id: string | null;
    acceptance: ReturnType<typeof acceptanceEvidence>;
    artifacts: ArtifactEvidence[];
  };
}

export interface HealthResult {
  status: "ready";
  binary_path: string;
  version: string;
  capabilities: CliProbe["capabilities"];
  warnings: string[];
  runtime: RuntimeVersionInfo;
  bridge_version: typeof BRIDGE_VERSION;
  protocol_version: typeof PROTOCOL_VERSION;
  task_spec_version: typeof TASK_SPEC_VERSION;
  limits: {
    max_concurrency: number;
    same_directory_plans_may_overlap: true;
    same_directory_execute_is_exclusive: true;
    working_directory_policy: "client_roots_or_exact_requested_cwd";
    worktree_aware_locking: true;
    background_plan: true;
    background_execute: true;
    persistent_background_tasks: true;
    background_execute_requires_approval: true;
    batch_orchestration: true;
    automatic_write_retry: false;
    default_max_changed_files: number;
    default_max_changed_bytes: number;
    probe_cache_ttl_ms: number;
    audit_enabled: boolean;
  };
}

export type ToolResult = HealthResult | SuccessResult | FailureResult;
type AllowedRootsSource = readonly string[] | AllowedRootsProvider;

export interface WorkBuddyServiceDependencies {
  capabilityCache?: CapabilityCache<CliProbe>;
  executionGuard?: ExecutionGuard;
  auditLog?: AuditLog;
  workspaceResolver?: (cwd: string) => Promise<WorkspaceIdentity>;
  runtimeInspector?: () => Promise<RuntimeVersionInfo>;
}

export interface ExecutionPreparation {
  input: InvocationInput;
  cwd: string;
  workspace: WorkspaceIdentity;
  prompt: string;
  taskSpec: TaskSpec | null;
  scope: ExecutionScope | undefined;
  preview: Awaited<ReturnType<ExecutionGuard["preview"]>>;
}

export interface PreparedTask {
  input: InvocationInput;
  cwd: string;
  workspace: WorkspaceIdentity;
  prompt: string;
  taskSpec: TaskSpec | null;
  scope: ExecutionScope | undefined;
}

export class WorkBuddyService {
  private readonly capabilityCache: CapabilityCache<CliProbe>;
  private readonly executionGuard: ExecutionGuard;
  private readonly auditLog: AuditLog;
  private readonly workspaceResolver: (cwd: string) => Promise<WorkspaceIdentity>;
  private readonly runtimeInspector: () => Promise<RuntimeVersionInfo>;

  constructor(
    private readonly allowedRoots: AllowedRootsSource = configuredAllowedRoots(),
    private readonly coordinator = new InvocationCoordinator(),
    dependencies: WorkBuddyServiceDependencies = {},
  ) {
    this.capabilityCache = dependencies.capabilityCache ?? new CapabilityCache<CliProbe>();
    this.executionGuard = dependencies.executionGuard ?? new ExecutionGuard();
    this.auditLog = dependencies.auditLog ?? new FileAuditLog();
    this.workspaceResolver = dependencies.workspaceResolver ?? resolveWorkspaceIdentity;
    this.runtimeInspector = dependencies.runtimeInspector ?? inspectRuntimeVersions;
  }

  private async probe(): Promise<CliProbe> {
    return await this.capabilityCache.get(await resolveCli(), probeCli);
  }

  async health(): Promise<ToolResult> {
    try {
      const probe = await this.probe();
      const runtime = await this.runtimeInspector();
      return {
        status: "ready",
        binary_path: probe.binaryPath,
        version: probe.version,
        capabilities: probe.capabilities,
        warnings: runtime.version_consistent ? [] : [runtime.client_restart_required
          ? "Plugin, Skill, and MCP Server versions do not match; restart the local Codex client after reinstalling."
          : "Bundle version metadata could not be fully inspected."],
        runtime,
        bridge_version: BRIDGE_VERSION,
        protocol_version: PROTOCOL_VERSION,
        task_spec_version: TASK_SPEC_VERSION,
        limits: {
          max_concurrency: this.coordinator.maxConcurrency,
          same_directory_plans_may_overlap: true,
          same_directory_execute_is_exclusive: true,
          working_directory_policy: "client_roots_or_exact_requested_cwd",
          worktree_aware_locking: true,
          background_plan: true,
          background_execute: true,
          persistent_background_tasks: true,
          background_execute_requires_approval: true,
          batch_orchestration: true,
          automatic_write_retry: false,
          default_max_changed_files: 100,
          default_max_changed_bytes: 10 * 1024 * 1024,
          probe_cache_ttl_ms: this.capabilityCache.ttlMs,
          audit_enabled: this.auditLog.path !== null,
        },
      };
    } catch (error) {
      return normalizeError(error).toFailure();
    }
  }

  async invoke(operation: "plan" | "execute", input: InvocationInput): Promise<ToolResult> {
    const invocationId = `wb_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    let auditCwd = input.cwd;
    try {
      const contract = normalizeTaskContract(input);
      const roots = typeof this.allowedRoots === "function" ? await this.allowedRoots(input.cwd) : this.allowedRoots;
      const cwd = await validateCwd(input.cwd, roots);
      auditCwd = cwd;
      if (operation === "execute" && input.approved_baseline_sha256 !== undefined) {
        await this.executionGuard.assertBaseline(cwd, input.approved_baseline_sha256);
      }
      const workspace = await this.workspaceResolver(cwd);
      if (operation === "execute" && contract.scope?.require_git_worktree === true && workspace.kind === "directory") {
        throw new BridgeError("INVALID_ARGUMENT", "This execution requires a Git repository or linked worktree.", false, { cwd });
      }
      const result = await this.coordinator.run(operation, cwd, contract.taskLabel, async () => {
        const probe = await this.probe();
        const invokeCli = async () => {
          const args = [
            "--print",
            "--output-format", "json",
            "--permission-mode", operation === "plan" ? "plan" : "acceptEdits",
            "--tools", operation === "plan" ? "Read" : "Read,Write,Edit",
            "--max-turns", String(input.max_turns),
            "--no-session-persistence",
            "--strict-mcp-config",
          ];
          if (operation === "execute") {
            const schema = validateResultSchema(input.result_schema);
            if (schema !== undefined) args.push("--json-schema", schema);
          }
          const cliModel = process.env.WORKBUDDY_CLI_MODEL || "hy3";
          args.push("--model", cliModel);
          args.push(contract.prompt);
          const processResult = await runProcess({
            executable: probe.binaryPath,
            args,
            cwd,
            timeoutMs: input.timeout_seconds * 1_000,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (processResult.exitCode !== 0) throw processFailure(processResult.exitCode, processResult.stderr);
          return { processResult, adapted: adaptCliResult(processResult.stdout) };
        };
        const guarded = operation === "execute"
          ? await this.executionGuard.run(cwd, contract.scope, invokeCli)
          : { value: await invokeCli(), changes: null };
        const { processResult, adapted } = guarded.value;
        return {
          status: "completed" as const,
          operation,
          result: adapted.result,
          summary: adapted.summary,
          cwd,
          binary_version: probe.version,
          duration_ms: processResult.durationMs,
          exit_code: 0 as const,
          warnings: [...adapted.warnings],
          truncated: false as const,
          task_label: contract.taskLabel ?? null,
          invocation_id: invocationId,
          started_at: startedAt,
          output: adapted.output,
          workspace: {
            kind: workspace.kind,
            root: workspace.root,
            repository_fingerprint: workspace.repositoryFingerprint,
          },
          changes: guarded.changes,
          protocol_version: PROTOCOL_VERSION as typeof PROTOCOL_VERSION,
          task_spec_version: TASK_SPEC_VERSION as typeof TASK_SPEC_VERSION,
          envelope: {
            invocation_id: invocationId,
            task_id: input.background_task_id ?? null,
            parent_task_id: contract.parentTaskId,
            approval_id: input.approval_id ?? null,
            acceptance: acceptanceEvidence(contract.taskSpec),
            artifacts: await this.artifactEvidence(cwd, contract.taskSpec),
          },
        };
      }, workspace.lockKey);
      const auditOk = await this.tryAudit({
        invocation_id: invocationId,
        ...(input.background_task_id === undefined ? {} : { task_id: input.background_task_id }),
        ...(input.approval_id === undefined ? {} : { approval_id: input.approval_id }),
        task_label: contract.taskLabel ?? null,
        operation,
        cwd,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outcome: "completed",
        ...(result.changes === null ? {} : { changed_files: result.changes.changed_files }),
        duration_ms: result.duration_ms,
      });
      if (!auditOk) result.warnings.push("The local audit record could not be written.");
      return result;
    } catch (error) {
      let normalized = normalizeError(error).withDetails({ invocation_id: invocationId, task_label: input.task_label ?? null });
      const auditOk = await this.tryAudit({
        invocation_id: invocationId,
        ...(input.background_task_id === undefined ? {} : { task_id: input.background_task_id }),
        ...(input.approval_id === undefined ? {} : { approval_id: input.approval_id }),
        task_label: input.task_label ?? null,
        operation,
        cwd: auditCwd,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        outcome: "failed",
        error_code: normalized.code,
      });
      if (!auditOk) normalized = normalized.withDetails({ audit_write_failed: true });
      return normalized.toFailure();
    }
  }

  async prepareExecution(input: InvocationInput): Promise<ExecutionPreparation> {
    const prepared = await this.prepareTask(input);
    if (prepared.scope?.require_git_worktree === true && prepared.workspace.kind === "directory") {
      throw new BridgeError("INVALID_ARGUMENT", "This execution requires a Git repository or linked worktree.", false, { cwd: prepared.cwd });
    }
    return {
      ...prepared,
      preview: await this.executionGuard.preview(prepared.cwd, prepared.scope),
    };
  }

  async prepareTask(input: InvocationInput): Promise<PreparedTask> {
    const contract = normalizeTaskContract(input);
    const roots = typeof this.allowedRoots === "function" ? await this.allowedRoots(input.cwd) : this.allowedRoots;
    const cwd = await validateCwd(input.cwd, roots);
    const workspace = await this.workspaceResolver(cwd);
    return {
      input: {
        ...input,
        prompt: contract.prompt,
        ...(contract.taskLabel === undefined ? {} : { task_label: contract.taskLabel }),
        ...(contract.scope === undefined ? {} : { scope: contract.scope }),
      },
      cwd,
      workspace,
      prompt: contract.prompt,
      taskSpec: contract.taskSpec,
      scope: contract.scope,
    };
  }

  async assertExecutionBaseline(cwd: string, baselineSha256: string): Promise<void> {
    await this.executionGuard.assertBaseline(cwd, baselineSha256);
  }

  private async tryAudit(record: AuditRecord): Promise<boolean> {
    try {
      await this.auditLog.record(record);
      return true;
    } catch {
      return false;
    }
  }

  private async artifactEvidence(cwd: string, taskSpec: TaskSpec | null): Promise<ArtifactEvidence[]> {
    return await Promise.all((taskSpec?.expected_artifacts ?? []).map(async (relative) => {
      try {
        await access(path.resolve(cwd, relative));
        return { path: relative, exists: true };
      } catch {
        return { path: relative, exists: false };
      }
    }));
  }
}

export function assertFailure(result: ToolResult): FailureResult {
  if (result.status !== "failed") throw new BridgeError("WORKBUDDY_FAILED", "Expected a failure result.");
  return result;
}
