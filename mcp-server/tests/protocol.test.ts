import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ControllerLike, type ServiceLike } from "../src/server.js";
import type { ToolResult } from "../src/service.js";

const health: ToolResult = {
  status: "ready",
  binary_path: "/tmp/codebuddy",
  version: "2.115.0",
  capabilities: {
    print: true, json_output: true, json_schema: true, permission_mode: true,
    tool_restriction: true, max_turns: true, no_session_persistence: true, strict_mcp_config: true,
  },
  warnings: [],
  bridge_version: "1.0.1",
  protocol_version: "1.0",
  task_spec_version: "1",
  runtime: {
    plugin_version: "1.0.1+codex.test", server_version: "1.0.1", protocol_version: "1.0",
    skill_expected_version: "1.0.1", version_consistent: true, client_restart_required: false, diagnostic_code: "OK",
  },
  limits: {
    max_concurrency: 4,
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
    probe_cache_ttl_ms: 60_000,
    audit_enabled: true,
  },
};

const service: ServiceLike = {
  async health() { return health; },
  async invoke(operation, input) {
    return {
      status: "completed", operation, result: { prompt: input.prompt }, summary: "ok", cwd: input.cwd,
      binary_version: "2.115.0", duration_ms: 1, exit_code: 0, warnings: [], truncated: false,
      task_label: input.task_label ?? null,
      invocation_id: "wb_test",
      started_at: "2026-08-11T00:00:00.000Z",
      output: { format: "json", bytes: 2, lines: 1, sha256: "test" },
      workspace: { kind: "directory", root: input.cwd, repository_fingerprint: null },
      changes: operation === "execute" ? {
        created: [], modified: [], deleted: [], changed_files: 0, changed_bytes: 0, scope_check: "passed",
        coverage: { content_hashed_files: 0, metadata_only_files: 0, max_entries: 50_000, max_hash_bytes: 128 * 1024 * 1024 },
      } : null,
      protocol_version: "1.0", task_spec_version: "1",
      envelope: { invocation_id: "wb_test", task_id: null, parent_task_id: null, approval_id: null, acceptance: [], artifacts: [] },
    };
  },
};

const taskView = {
  task_id: "wbt_00000000-0000-0000-0000-000000000001", task_key: null, batch_id: null,
  task_label: "background", operation: "plan" as const, state: "running" as const,
  created_at: "2026-08-11T00:00:00.000Z", started_at: "2026-08-11T00:00:00.000Z", completed_at: null,
  cancellation_requested: false, depends_on: [], events: [], next_event_id: 0,
};

const controller: ControllerLike = {
  startPlan() { return taskView; },
  async prepareExecute() {
    return { approval_id: "wba_test", approval_token: "token", confirmation_required: true, reusable: false };
  },
  async startExecute() { return { ...taskView, operation: "execute" as const }; },
  async startBatch() {
    return { batch_id: "wbb_00000000-0000-0000-0000-000000000001", state: "running", tasks: [taskView], global_concurrency_budget: 4, conflict_check: "passed" };
  },
  status() { return { ...taskView, state: "completed", completed_at: "2026-08-11T00:00:01.000Z" }; },
  batchStatus() { return { batch_id: "wbb_00000000-0000-0000-0000-000000000001", state: "running", tasks: [taskView] }; },
  cancel() { return { ...taskView, cancellation_requested: true }; },
};

describe("MCP protocol", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closers.length) await closers.pop()?.(); });

  async function connectedClient(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(service, controller);
    const client = new Client({ name: "protocol-test", version: "1.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => client.close(), async () => server.close());
    return client;
  }

  it("initializes and lists the stable 1.0 tool surface with annotations", async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "workbuddy_health", "workbuddy_plan", "workbuddy_execute",
      "workbuddy_plan_start", "workbuddy_execute_prepare", "workbuddy_execute_start",
      "workbuddy_batch_start", "workbuddy_task_status", "workbuddy_batch_status", "workbuddy_task_cancel",
    ]);
    expect(listed.tools.find((tool) => tool.name === "workbuddy_plan")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(listed.tools.find((tool) => tool.name === "workbuddy_execute")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed.tools.find((tool) => tool.name === "workbuddy_execute")?.inputSchema).not.toHaveProperty("properties.flags");
    expect(listed.tools.find((tool) => tool.name === "workbuddy_plan_start")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(listed.tools.find((tool) => tool.name === "workbuddy_execute_start")?.annotations).toMatchObject({ destructiveHint: true });
    expect(listed.tools.find((tool) => tool.name === "workbuddy_batch_start")?.inputSchema).toHaveProperty("properties.tasks");
  });

  it("calls health and plan through MCP", async () => {
    const client = await connectedClient();
    const healthCall = await client.callTool({ name: "workbuddy_health", arguments: {} });
    expect(healthCall.structuredContent).toMatchObject({ status: "ready", version: "2.115.0" });
    const planCall = await client.callTool({
      name: "workbuddy_plan",
      arguments: { prompt: "Analyze only", cwd: "/tmp/project", max_turns: 2, timeout_seconds: 10, task_label: "security" },
    });
    expect(planCall.structuredContent).toMatchObject({ status: "completed", operation: "plan", task_label: "security" });
  });

  it("starts and reads a background plan through MCP", async () => {
    const client = await connectedClient();
    const started = await client.callTool({
      name: "workbuddy_plan_start",
      arguments: { prompt: "Analyze only", cwd: "/tmp/project", max_turns: 2, timeout_seconds: 10, task_label: "background" },
    });
    const taskId = (started.structuredContent as { task_id: string }).task_id;
    expect(started.structuredContent).toMatchObject({ state: "running", task_label: "background" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await client.callTool({ name: "workbuddy_task_status", arguments: { task_id: taskId } });
    expect(status.structuredContent).toMatchObject({ state: "completed" });
  });
});
