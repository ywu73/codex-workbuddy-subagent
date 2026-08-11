import { spawn } from "node:child_process";
import { BridgeError } from "./errors.js";
import { redactText } from "./redaction.js";

export interface RunOptions {
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number, limit: number): { size: number; overflow: boolean } {
  const remaining = Math.max(0, limit - current);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { size: current + Math.min(chunk.length, remaining), overflow: chunk.length > remaining };
}

export async function runProcess(options: RunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new BridgeError("TASK_CANCELLED", "The WorkBuddy task was cancelled.");
  const started = Date.now();
  const baseEnv = options.env ?? process.env;
  const proxy = baseEnv.WORKBUDDY_CLI_PROXY;
  const childEnv = proxy
    ? {
        ...baseEnv,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NODE_OPTIONS: [baseEnv.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" "),
      }
    : baseEnv;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const maxStdout = options.maxStdoutBytes ?? 1_048_576;
  const maxStderr = options.maxStderrBytes ?? 65_536;
  let stdoutSize = 0;
  let stderrSize = 0;
  let overflow = false;
    let timedOut = false;
    let cancelled = false;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timer.unref();
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (raw: Buffer) => {
      const result = appendBounded(stdoutChunks, raw, stdoutSize, maxStdout);
      stdoutSize = result.size;
      overflow ||= result.overflow;
    });
    child.stderr.on("data", (raw: Buffer) => {
      const result = appendBounded(stderrChunks, raw, stderrSize, maxStderr);
      stderrSize = result.size;
      overflow ||= result.overflow;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new BridgeError("PROCESS_FAILED", "Unable to start the WorkBuddy CLI process.", false, { cause: error.name }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        reject(new BridgeError("TIMEOUT", "The WorkBuddy CLI exceeded its time limit and was terminated.", true, {
          timeout_ms: options.timeoutMs,
        }));
        return;
      }
      if (cancelled) {
        reject(new BridgeError("TASK_CANCELLED", "The WorkBuddy task was cancelled.", false, { cancelled: true }));
        return;
      }
      if (overflow) {
        reject(new BridgeError("OUTPUT_TOO_LARGE", "WorkBuddy output exceeded the configured size limit.", false, {
          stdout_limit_bytes: maxStdout,
          stderr_limit_bytes: maxStderr,
          truncated: true,
          stderr: redactText(stderr, 1024),
        }));
        return;
      }
      resolve({
        stdout,
        stderr: redactText(stderr),
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        truncated: false,
      });
    });
  });
}
