import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildResponsePayload,
  buildStreamingEvents,
  createNativeProviderServer,
  inputToPrompt,
  inputToPromptBlocks,
} from "../src/native-provider.js";
import { DEFAULT_WORKBUDDY_MODEL, resolveWorkBuddyModel, workBuddyModelList } from "../src/model-policy.js";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fake-acp-cli.mjs", import.meta.url));

async function withNativeServer<T>(options: Parameters<typeof createNativeProviderServer>[0], callback: (port: number) => Promise<T>): Promise<T> {
  const server = createNativeProviderServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  try {
    return await callback(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postPrompt(port: number): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "hy3", input: "Return READY." }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("native WorkBuddy provider adapter", () => {
  it("maps Responses input messages into one WorkBuddy prompt", () => {
    expect(inputToPrompt([
      { role: "system", content: "You are a read-only worker." },
      { role: "user", content: [{ type: "input_text", text: "Return the marker." }] },
    ])).toBe("[system]\nYou are a read-only worker.\n\n[user]\nReturn the marker.");
  });

  it("preserves a string prompt", () => {
    expect(inputToPrompt("Return READY.")).toBe("Return READY.");
  });

  it("rejects input without text", () => {
    expect(() => inputToPrompt([{ role: "user", content: [] }])).toThrow(/text content/);
  });

  it("preserves a base64 image as an ACP image block", () => {
    expect(inputToPromptBlocks([{
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
    }])).toEqual([
      { type: "text", text: "[user]" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
  });

  it("rejects remote image URLs instead of fetching them", () => {
    expect(() => inputToPromptBlocks([{
      role: "user",
      content: [{ type: "input_image", image_url: "https://example.com/image.png" }],
    }])).toThrow(/data URL/);
  });

  it("keeps the native model allowlist explicit", () => {
    expect(resolveWorkBuddyModel(undefined)).toBe(DEFAULT_WORKBUDDY_MODEL);
    expect(resolveWorkBuddyModel("kimi-k2.7")).toBe("kimi-k2.7");
    expect(workBuddyModelList().map((model) => model.id)).toEqual([
      "hy3",
      "glm-5.2",
      "minimax-m3",
      "kimi-k2.7",
    ]);
    expect(() => resolveWorkBuddyModel("kimi-k2.7-code")).toThrow(/Unsupported WorkBuddy model/);
  });

  it("builds a completed Responses payload", () => {
    const response = buildResponsePayload("hy3", "READY", "resp_test");
    expect(response).toMatchObject({
      id: "resp_test",
      object: "response",
      model: "hy3",
      status: "completed",
      output_text: "READY",
    });
    expect(response.output).toEqual([expect.objectContaining({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "READY", annotations: [] }],
    })]);
  });

  it("builds a Codex-compatible streaming lifecycle", () => {
    const events = buildStreamingEvents(buildResponsePayload("hy3", "READY", "resp_test"));
    const parsed = events.slice(0, -1).map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data!.slice("data: ".length)) as Record<string, unknown>;
    });

    expect(parsed.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.at(-1)).toBe("data: [DONE]\n\n");
    const delta = parsed[4]!;
    const itemDone = parsed[7]!;
    const completed = parsed[8]!;
    expect(delta).toMatchObject({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "READY",
    });
    expect(delta.item_id).toEqual(expect.stringMatching(/^msg_/));
    expect(itemDone).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "READY", annotations: [] }],
      },
    });
    expect((itemDone.item as Record<string, unknown>).id).toBe(delta.item_id);
    expect(completed).toMatchObject({
      type: "response.completed",
      response: { id: "resp_test", status: "completed" },
    });
  });

  it("returns the ACP phase when the upstream prompt stalls", async () => {
    const previousMode = process.env.FAKE_ACP_MODE;
    process.env.FAKE_ACP_MODE = "stall-prompt";
    try {
      const result = await withNativeServer({ cliPath: fakeCliPath, timeoutMs: 1_000 }, postPrompt);
      expect(result.status).toBe(502);
      expect(result.body.error.message).toMatch(/phase=session\/prompt/);
    } finally {
      if (previousMode === undefined) delete process.env.FAKE_ACP_MODE;
      else process.env.FAKE_ACP_MODE = previousMode;
    }
  });

  it("rejects a session that reports a different model than requested", async () => {
    const previousMode = process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_MODE;
    try {
      const result = await withNativeServer({ cliPath: fakeCliPath, model: "minimax-m3", timeoutMs: 500 }, async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "minimax-m3", input: "Return READY." }),
        });
        return { status: response.status, body: await response.json() as Record<string, any> };
      });
      expect(result.status).toBe(502);
      expect(result.body.error.message).toContain("selected model hy3 instead of requested minimax-m3");
    } finally {
      if (previousMode === undefined) delete process.env.FAKE_ACP_MODE;
      else process.env.FAKE_ACP_MODE = previousMode;
    }
  });
});
