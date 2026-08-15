import http from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { APP_CLI_PATH } from "./cli-resolver.js";
import {
  DEFAULT_WORKBUDDY_MODEL,
  MULTIMODAL_WORKBUDDY_MODELS,
  resolveWorkBuddyModel,
  workBuddyModelList,
  type WorkBuddyModel,
} from "./model-policy.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17_891;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: JsonObject;
}

interface NativeProviderOptions {
  cwd: string;
  model: WorkBuddyModel;
  timeoutMs: number;
  cliPath?: string;
  permissionMode: "plan" | "acceptEdits";
  tools: string;
}

interface PromptResult {
  text: string;
  stopReason: string;
}

type AcpPhase = "starting" | "initialize" | "session/new" | "session/prompt" | "completed" | "closing";

interface PendingRequest {
  method: string;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
}

export type NativePromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (value !== null && typeof value === "object") {
    const record = value as JsonObject;
    return stringValue(record.text) ?? stringValue(record.content) ?? "";
  }
  return "";
}

function dataUrlToImage(value: unknown): NativePromptBlock {
  const url = stringValue(value);
  if (!url) throw new Error("Responses image content must use a data URL.");
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) throw new Error("Responses image content must use a base64 data URL; remote image URLs are not supported.");
  const data = match[2]!;
  const byteLength = Buffer.from(data, "base64").byteLength;
  if (byteLength === 0) throw new Error("Responses image content contained no image bytes.");
  if (byteLength > MAX_IMAGE_BYTES) throw new Error(`Responses image content exceeds the ${MAX_IMAGE_BYTES} byte limit.`);
  return { type: "image", mimeType: match[1]!.toLowerCase(), data };
}

function inputContentBlocks(value: unknown): NativePromptBlock[] {
  if (typeof value === "string") return value.trim() ? [{ type: "text", text: value }] : [];
  if (Array.isArray(value)) return value.flatMap(inputContentBlocks);
  if (value === null || typeof value !== "object") return [];
  const record = value as JsonObject;
  const type = stringValue(record.type);
  if (type === "input_image" || type === "image") {
    const imageValue = record.image_url ?? record.url ?? record.source;
    if (imageValue !== undefined && typeof imageValue === "object" && imageValue !== null) {
      const imageRecord = imageValue as JsonObject;
      if (imageRecord.url !== undefined) return [dataUrlToImage(imageRecord.url)];
      if (imageRecord.data !== undefined) {
        const mimeType = stringValue(imageRecord.media_type) ?? stringValue(imageRecord.mimeType);
        const data = stringValue(imageRecord.data);
        if (!mimeType || !data) throw new Error("Responses image source must include media type and base64 data.");
        return [dataUrlToImage(`data:${mimeType};base64,${data}`)];
      }
    }
    if (imageValue !== undefined) return [dataUrlToImage(imageValue)];
    if (record.data !== undefined) {
      const mimeType = stringValue(record.mime_type) ?? stringValue(record.mimeType);
      if (!mimeType) throw new Error("Responses image content must include a MIME type.");
      return [dataUrlToImage(`data:${mimeType};base64,${String(record.data)}`)];
    }
    throw new Error("Responses image content did not contain image data.");
  }
  if (type === "input_text" || type === "text" || type === "output_text") {
    const text = stringValue(record.text);
    return text?.trim() ? [{ type: "text", text }] : [];
  }
  if (record.content !== undefined) return inputContentBlocks(record.content);
  if (record.text !== undefined) return inputContentBlocks(record.text);
  if (record.input !== undefined) return inputContentBlocks(record.input);
  if (type) throw new Error(`Unsupported Responses input content type: ${type}.`);
  return [];
}

export function inputToPromptBlocks(input: unknown): NativePromptBlock[] {
  if (typeof input === "string") {
    if (!input.trim()) throw new Error("Responses input did not contain text content or image content.");
    return [{ type: "text", text: input }];
  }
  if (!Array.isArray(input)) throw new Error("Responses input must be a string or an array.");
  const blocks: NativePromptBlock[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      blocks.push(...inputContentBlocks(item));
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const record = item as JsonObject;
    const role = stringValue(record.role) ?? "user";
    const content = inputContentBlocks(record.content ?? record.text ?? record.input);
    if (content.length > 0) blocks.push({ type: "text", text: `[${role}]` }, ...content);
  }
  if (blocks.length === 0) throw new Error("Responses input did not contain text content or image content.");
  return blocks;
}

export function inputToPrompt(input: unknown): string {
  const blocks = inputToPromptBlocks(input);
  if (blocks.some((block) => block.type === "image")) {
    throw new Error("Responses input contains image content; use the ACP prompt path for multimodal requests.");
  }
  const textBlocks = blocks.filter((block): block is { type: "text"; text: string } => block.type === "text");
  const sections: string[] = [];
  let current: string[] = [];
  for (const block of textBlocks) {
    if (/^\[[^\]]+\]$/.test(block.text) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(block.text);
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.join("\n\n").trim();
}

function responseId(): string {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

export function buildResponsePayload(model: string, text: string, id = responseId()): JsonObject {
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    model,
    status: "completed",
    output: [{
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    output_text: text,
  };
}

function jsonRpcRequest(id: number, method: string, params: JsonObject): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function proxyEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxy = base.WORKBUDDY_CLI_PROXY;
  if (!proxy) return base;
  return {
    ...base,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NODE_OPTIONS: [base.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" "),
  };
}

function traceAcpEvent(event: string, fields: JsonObject = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

class AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: readline.Interface;
  private readonly traceId = randomUUID();
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly assistantChunks: string[] = [];
  private readonly stderrChunks: string[] = [];
  private phase: AcpPhase = "starting";
  private sessionId: string | undefined;
  private closed = false;
  private closeError: Error | undefined;

  constructor(private readonly options: NativeProviderOptions) {
    const cliPath = options.cliPath ?? APP_CLI_PATH;
    const args = [
      "--acp",
      "--acp-transport", "stdio",
      "--no-session-persistence",
      "--setting-sources", "user",
      "--permission-mode", options.permissionMode,
      "--tools", options.tools,
      "--model", options.model,
    ];
    traceAcpEvent("acp_spawn", { model: options.model, argv: [cliPath, ...args] });
    this.child = spawn(cliPath, args, {
      cwd: options.cwd,
      env: proxyEnvironment(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.trace("acp_spawned", { pid: this.child.pid ?? null, argv: [cliPath, ...args] });
    this.output = readline.createInterface({ input: this.child.stdout });
    this.output.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.fail(new Error(`Unable to start WorkBuddy ACP: ${error.message}`)));
    this.child.once("close", (code) => {
      this.trace("acp_exit", { code, signal: this.child.signalCode ?? null });
      if (this.closed) return;
      if (code !== 0) this.fail(new Error(`WorkBuddy ACP exited with code ${code ?? -1}.`));
      else this.fail(new Error("WorkBuddy ACP exited before completing the request."));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderrChunks.join("").length < 8_192) this.stderrChunks.push(chunk.toString("utf8"));
    });
  }

  private trace(event: string, fields: JsonObject = {}): void {
    traceAcpEvent(event, {
      trace_id: this.traceId,
      model: this.options.model,
      pid: this.child.pid ?? null,
      phase: this.phase,
      ...fields,
    });
  }

  private stderrTail(): string {
    return this.stderrChunks.join("").replace(/\s+/g, " ").trim().slice(-2_048);
  }

  private diagnosticError(error: Error): Error {
    return new Error(`${error.message} (phase=${this.phase}, pid=${this.child.pid ?? "unknown"})`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.fail(new Error("WorkBuddy ACP emitted invalid JSON."));
      return;
    }
    if (message.method === "session/update") {
      const update = message.params?.update;
      const updateRecord = update !== null && typeof update === "object" ? update as JsonObject : undefined;
      const updateContent = updateRecord?.content;
      const contentRecord = updateContent !== null && typeof updateContent === "object" ? updateContent as JsonObject : undefined;
      this.trace("acp_update", {
        update: stringValue(updateRecord?.sessionUpdate) ?? "unknown",
        text_length: typeof contentRecord?.text === "string" ? contentRecord.text.length : 0,
      });
      this.collectUpdate(message.params);
      return;
    }
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    this.trace("acp_response", {
      id: message.id,
      method: waiter.method,
      ok: !message.error,
      error: message.error ? stringValue(message.error.message) ?? "unknown" : undefined,
    });
    if (message.error) {
      waiter.reject(new Error(stringValue(message.error.message) ?? "WorkBuddy ACP request failed."));
    } else {
      waiter.resolve(message);
    }
  }

  private collectUpdate(params: JsonObject | undefined): void {
    const update = params?.update;
    if (update === null || typeof update !== "object") return;
    const record = update as JsonObject;
    if (record.sessionUpdate !== "agent_message_chunk") return;
    const text = contentText(record.content);
    if (text) this.assistantChunks.push(text);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    const diagnostic = this.diagnosticError(error);
    this.closeError = diagnostic;
    this.trace("acp_failure", { error: error.message, stderr: this.stderrTail() || undefined });
    for (const waiter of this.pending.values()) waiter.reject(diagnostic);
    this.pending.clear();
  }

  private request(method: string, params: JsonObject): Promise<JsonRpcMessage> {
    if (this.closeError) return Promise.reject(this.closeError);
    if (method === "initialize" || method === "session/new" || method === "session/prompt") {
      this.phase = method;
    }
    const id = this.nextId++;
    this.trace("acp_request", {
      id,
      method,
      prompt_blocks: method === "session/prompt" && Array.isArray(params.prompt)
        ? (params.prompt as unknown[]).map((block) => {
          if (block === null || typeof block !== "object") return "unknown";
          const record = block as JsonObject;
          return record.type === "image" ? "image" : "text";
        })
        : undefined,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.child.stdin.write(jsonRpcRequest(id, method, params));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Unable to write to WorkBuddy ACP."));
      }
    });
  }

  async prompt(prompt: NativePromptBlock[]): Promise<PromptResult> {
    const initialize = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "codex-workbuddy-native-adapter", version: "1.0.0" },
    });
    if (prompt.some((block) => block.type === "image")) {
      const capabilities = initialize.result?.agentCapabilities;
      const promptCapabilities = capabilities && typeof capabilities === "object"
        ? (capabilities as JsonObject).promptCapabilities
        : undefined;
      const supportsImage = promptCapabilities !== null && typeof promptCapabilities === "object"
        && (promptCapabilities as JsonObject).image === true;
      if (!supportsImage) throw new Error("The selected WorkBuddy ACP session did not advertise image prompt capability.");
      if (!MULTIMODAL_WORKBUDDY_MODELS.has(this.options.model)) {
        throw new Error(`WorkBuddy model ${this.options.model} is not configured for image input.`);
      }
    }
    const session = await this.request("session/new", { cwd: this.options.cwd, mcpServers: [] });
    const sessionId = stringValue(session.result?.sessionId);
    if (!sessionId) throw new Error("WorkBuddy ACP did not return a session id.");
    this.sessionId = sessionId;
    const models = session.result?.models;
    const currentModelId = models !== null && typeof models === "object"
      ? stringValue((models as JsonObject).currentModelId)
      : undefined;
    if (currentModelId && currentModelId !== this.options.model) {
      throw new Error(`WorkBuddy ACP selected model ${currentModelId} instead of requested ${this.options.model}.`);
    }
    const result = await this.request("session/prompt", {
      sessionId,
      prompt,
    });
    this.phase = "completed";
    return {
      text: this.assistantChunks.join(""),
      stopReason: stringValue(result.result?.stopReason) ?? "unknown",
    };
  }

  close(error = new Error("WorkBuddy ACP session closed.")): void {
    if (this.closed) return;
    const diagnostic = this.diagnosticError(error);
    this.phase = "closing";
    this.closed = true;
    this.closeError = diagnostic;
    this.trace("acp_close", { error: error.message, stderr: this.stderrTail() || undefined });
    for (const waiter of this.pending.values()) waiter.reject(diagnostic);
    this.pending.clear();
    this.output.close();
    if (this.sessionId && error.message.includes("timed out")) {
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } })}\n`);
        this.trace("acp_cancel_sent", { session_id: this.sessionId });
      } catch {
        this.trace("acp_cancel_failed", { session_id: this.sessionId });
      }
    }
    this.child.kill("SIGTERM");
    setTimeout(() => {
      const killed = this.child.kill("SIGKILL");
      this.trace("acp_sigkill", { killed });
    }, 2_000).unref();
  }
}

async function runPrompt(options: NativeProviderOptions, prompt: NativePromptBlock[]): Promise<PromptResult> {
  const process = new AcpProcess(options);
  const timer = setTimeout(() => process.close(new Error("WorkBuddy ACP request timed out.")), options.timeoutMs);
  try {
    const result = await process.prompt(prompt);
    traceAcpEvent("acp_completed", { model: options.model, stop_reason: result.stopReason });
    return result;
  } finally {
    clearTimeout(timer);
    process.close();
  }
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: http.ServerResponse, status: number, value: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function outputItemFromPayload(payload: JsonObject): JsonObject {
  const output = payload.output;
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error("Responses payload did not contain an assistant output item.");
  }
  const item = output[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Responses payload contained an invalid assistant output item.");
  }
  return item as JsonObject;
}

function sseFrame(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function buildStreamingEvents(payload: JsonObject): string[] {
  const responseIdValue = stringValue(payload.id) ?? responseId();
  const rawItem = outputItemFromPayload(payload);
  const itemId = stringValue(rawItem.id) ?? `msg_${randomUUID().replaceAll("-", "")}`;
  const text = stringValue(payload.output_text) ?? "";
  const inProgressItem: JsonObject = {
    ...rawItem,
    id: itemId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  const completedItem: JsonObject = {
    ...rawItem,
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const inProgressResponse: JsonObject = {
    ...payload,
    id: responseIdValue,
    status: "in_progress",
    output: [],
  };
  const completedResponse: JsonObject = {
    ...payload,
    id: responseIdValue,
    status: "completed",
    output: [completedItem],
    output_text: text,
  };

  return [
    sseFrame("response.created", {
      type: "response.created",
      response: inProgressResponse,
      sequence_number: 0,
    }),
    sseFrame("response.in_progress", {
      type: "response.in_progress",
      response: inProgressResponse,
      sequence_number: 1,
    }),
    sseFrame("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: inProgressItem,
      sequence_number: 2,
    }),
    sseFrame("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
      sequence_number: 3,
    }),
    sseFrame("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
      sequence_number: 4,
    }),
    sseFrame("response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: null,
      sequence_number: 5,
    }),
    sseFrame("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
      sequence_number: 6,
    }),
    sseFrame("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
      sequence_number: 7,
    }),
    sseFrame("response.completed", {
      type: "response.completed",
      response: completedResponse,
      sequence_number: 8,
    }),
    "data: [DONE]\n\n",
  ];
}

function sendStream(response: http.ServerResponse, payload: JsonObject): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "content-type": "text/event-stream",
  });
  for (const event of buildStreamingEvents(payload)) response.write(event);
  response.end();
}

function modelList(): JsonObject {
  return { object: "list", data: workBuddyModelList() };
}

export function createNativeProviderServer(options: {
  host?: string;
  port?: number;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  cliPath?: string;
  permissionMode?: "plan" | "acceptEdits";
  tools?: string;
  maxBodyBytes?: number;
} = {}): http.Server {
  const model = resolveWorkBuddyModel(
    options.model ?? process.env.WORKBUDDY_NATIVE_MODEL ?? process.env.WORKBUDDY_CLI_MODEL,
    DEFAULT_WORKBUDDY_MODEL,
  );
  const providerOptions = {
    cwd: options.cwd ?? process.env.WORKBUDDY_NATIVE_CWD ?? process.cwd(),
    model,
    timeoutMs: options.timeoutMs ?? Number(process.env.WORKBUDDY_NATIVE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    permissionMode: options.permissionMode ?? "plan",
    tools: options.tools ?? "Read",
  } satisfies NativeProviderOptions;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, {
          status: "ready",
          model,
          models: workBuddyModelList().map((entry) => entry.id),
          cwd: providerOptions.cwd,
          cli_path: providerOptions.cliPath ?? APP_CLI_PATH,
        });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        sendJson(response, 200, modelList());
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        sendJson(response, 404, { error: { message: "Not found", type: "not_found" } });
        return;
      }
      const body = JSON.parse(await readBody(request, maxBodyBytes)) as JsonObject;
      const requestModel = resolveWorkBuddyModel(body.model, model);
      const prompt = inputToPromptBlocks(body.input);
      const result = await runPrompt({ ...providerOptions, model: requestModel }, prompt);
      if (!result.text.trim()) throw new Error("WorkBuddy ACP returned no assistant text.");
      const payload = buildResponsePayload(requestModel, result.text);
      if (body.stream === true) sendStream(response, payload);
      else sendJson(response, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "WorkBuddy native adapter failed.";
      const status = message.startsWith("Unsupported WorkBuddy model:") ? 400 : 502;
      sendJson(response, status, { error: { message, type: status === 400 ? "invalid_request_error" : "workbuddy_adapter_error" } });
    }
  });
}

export async function main(): Promise<void> {
  const host = process.env.WORKBUDDY_NATIVE_ADAPTER_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.WORKBUDDY_NATIVE_ADAPTER_PORT ?? DEFAULT_PORT);
  const server = createNativeProviderServer({ host, port });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      process.stderr.write(`workbuddy native adapter listening on http://${host}:${port}\n`);
      resolve();
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`workbuddy native adapter failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
