import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("built STDIO MCP server", () => {
  it("initializes, lists the 1.0 tools, and calls real health", async () => {
    const serverRoot = process.env.WORKBUDDY_STDIO_SERVER_ROOT
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(serverRoot, "dist", "src", "server.js")],
      cwd: serverRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "workbuddy_health", "workbuddy_plan", "workbuddy_execute",
        "workbuddy_plan_start", "workbuddy_execute_prepare", "workbuddy_execute_start",
        "workbuddy_batch_start", "workbuddy_task_status", "workbuddy_batch_status", "workbuddy_task_cancel",
      ]);
      expect((await client.callTool({ name: "workbuddy_health", arguments: {} })).structuredContent).toMatchObject({
        status: "ready",
        version: "2.115.0",
        bridge_version: "1.0.1",
        protocol_version: "1.0",
        limits: { max_concurrency: 4, persistent_background_tasks: true, background_execute_requires_approval: true },
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});
