#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalManager } from "./approval.js";
import { BackgroundTaskManager, type BackgroundBatchView, type BackgroundTaskView } from "./background-plan-manager.js";
import { createAllowedRootsProvider } from "./client-roots.js";
import { DelegationController, type ApprovedExecutionInput, type BatchDelegationInput, type BatchStartResult } from "./delegation-controller.js";
import { normalizeError } from "./errors.js";
import {
  backgroundExecuteStartInputShape,
  batchIdSchema,
  batchStartInputShape,
  eventCursorSchema,
  executeInputShape,
  planInputShape,
  taskIdSchema,
} from "./schemas.js";
import { WorkBuddyService, type InvocationInput, type ToolResult } from "./service.js";
import { SqliteTaskStore } from "./task-store.js";
import { BRIDGE_VERSION } from "./version.js";

export interface ServiceLike {
  health(): Promise<ToolResult>;
  invoke(operation: "plan" | "execute", input: InvocationInput): Promise<ToolResult>;
}

export interface ControllerLike {
  startPlan(input: InvocationInput): BackgroundTaskView;
  prepareExecute(input: InvocationInput): Promise<object>;
  startExecute(input: ApprovedExecutionInput): Promise<BackgroundTaskView>;
  startBatch(inputs: readonly BatchDelegationInput[]): Promise<BatchStartResult>;
  status(taskId: string, afterEventId?: number): BackgroundTaskView;
  batchStatus(batchId: string, afterEventId?: number): BackgroundBatchView;
  cancel(taskId: string): BackgroundTaskView;
}

function response(result: object, isError = "status" in result && result.status === "failed") {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
    isError,
  };
}

function guarded(action: () => object) {
  try { return response(action()); }
  catch (error) { return response(normalizeError(error).toFailure(), true); }
}

async function guardedAsync(action: () => Promise<object>) {
  try { return response(await action()); }
  catch (error) { return response(normalizeError(error).toFailure(), true); }
}

export function createServer(service?: ServiceLike, controller?: ControllerLike): McpServer {
  const server = new McpServer({ name: "workbuddy-bridge", version: BRIDGE_VERSION });
  const activeService = service ?? new WorkBuddyService(createAllowedRootsProvider(server.server));
  let activeController = controller;
  if (activeController === undefined) {
    const concreteService = activeService as WorkBuddyService;
    const store = new SqliteTaskStore();
    const background = new BackgroundTaskManager((operation, input) => activeService.invoke(operation, input), store);
    activeController = new DelegationController(concreteService, background, new ApprovalManager(store));
  }

  server.registerTool("workbuddy_health", {
    title: "Check WorkBuddy bridge health",
    description: "Inspect WorkBuddy availability, bridge/Skill/protocol version consistency, persistence, approvals, concurrency, and orchestration limits.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => response(await activeService.health()));

  server.registerTool("workbuddy_plan", {
    title: "Ask WorkBuddy for a foreground plan",
    description: "Delegate bounded foreground analysis with only WorkBuddy's Read tool. Accepts the stable TaskSpec v1 contract or legacy prompt fields.",
    inputSchema: planInputShape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (input) => response(await activeService.invoke("plan", input)));

  server.registerTool("workbuddy_execute", {
    title: "Ask WorkBuddy to execute a confirmed foreground edit",
    description: "Run an explicitly confirmed foreground edit with bounded evidence and scope enforcement. It never commits, pushes, retries writes, or rolls changes back.",
    inputSchema: executeInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => response(await activeService.invoke("execute", input)));

  server.registerTool("workbuddy_plan_start", {
    title: "Start a persistent background WorkBuddy plan",
    description: "Queue bounded read-only analysis in the persistent local task registry and return an event-cursor task handle.",
    inputSchema: planInputShape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (input) => guarded(() => activeController!.startPlan(input)));

  server.registerTool("workbuddy_execute_prepare", {
    title: "Prepare approval for a background WorkBuddy edit",
    description: "Snapshot the exact workspace, task, and scope and return a short-lived single-use approval token. This does not execute WorkBuddy or modify the target workspace.",
    inputSchema: executeInputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input) => await guardedAsync(() => activeController!.prepareExecute(input)));

  server.registerTool("workbuddy_execute_start", {
    title: "Start an approved background WorkBuddy edit",
    description: "Queue a background edit only when a valid single-use approval token matches the exact unchanged task, worktree, scope, and baseline.",
    inputSchema: backgroundExecuteStartInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input) => await guardedAsync(() => activeController!.startExecute(input)));

  server.registerTool("workbuddy_batch_start", {
    title: "Start an isolated WorkBuddy task batch",
    description: "Queue 1-16 dependent plan or approved execute tasks under the global concurrency budget. Rejects overlapping writes in the same worktree before launch.",
    inputSchema: batchStartInputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async ({ tasks }) => await guardedAsync(() => activeController!.startBatch(tasks)));

  server.registerTool("workbuddy_task_status", {
    title: "Read a persistent WorkBuddy task",
    description: "Read one background task and events after an optional cursor. Interrupted tasks become orphaned and are never automatically retried.",
    inputSchema: { task_id: taskIdSchema, after_event_id: eventCursorSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ task_id, after_event_id }) => guarded(() => activeController!.status(task_id, after_event_id)));

  server.registerTool("workbuddy_batch_status", {
    title: "Read a WorkBuddy task batch",
    description: "Read aggregate and per-task state for a persistent batch, including dependency failures and event cursors.",
    inputSchema: { batch_id: batchIdSchema, after_event_id: eventCursorSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ batch_id, after_event_id }) => guarded(() => activeController!.batchStatus(batch_id, after_event_id)));

  server.registerTool("workbuddy_task_cancel", {
    title: "Cancel a background WorkBuddy task",
    description: "Cancel a pending or running background task. Completed tasks are unchanged; no write task is retried.",
    inputSchema: { task_id: taskIdSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ task_id }) => guarded(() => activeController!.cancel(task_id)));

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`workbuddy-bridge failed: ${error instanceof Error ? error.name : "UnknownError"}\n`);
    process.exitCode = 1;
  });
}
