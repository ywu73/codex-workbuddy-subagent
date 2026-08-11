import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

const SYSTEM_ROOTS = ["/Applications", "/System", "/Library", "/private", "/usr", "/bin", "/sbin", "/etc", "/var"];

export function configuredAllowedRoots(env = process.env, currentDirectory = process.cwd()): string[] {
  const configured = env.WORKBUDDY_ALLOWED_ROOTS;
  return configured ? configured.split(path.delimiter).filter(Boolean) : [currentDirectory];
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function validateCwd(input: string, allowedRoots: readonly string[]): Promise<string> {
  if (!path.isAbsolute(input)) throw new BridgeError("INVALID_ARGUMENT", "cwd must be an absolute path.");
  let resolved: string;
  try {
    resolved = await realpath(input);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new BridgeError("DIRECTORY_NOT_FOUND", "cwd does not identify an existing directory.");
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("DIRECTORY_NOT_FOUND", "cwd does not identify an existing directory.");
  }

  const normalizedRoots = await Promise.all(allowedRoots.map(async (root) => {
    if (!path.isAbsolute(root)) throw new BridgeError("INVALID_ARGUMENT", "Every allowed root must be absolute.");
    return await realpath(root);
  }));
  if (!normalizedRoots.some((root) => within(resolved, root))) {
    throw new BridgeError("DIRECTORY_NOT_ALLOWED", "cwd is outside the explicitly allowed roots.", false, { cwd: resolved });
  }
  const home = await realpath(os.homedir());
  const temporaryRoot = await realpath(os.tmpdir());
  const exactTemporaryRoot = normalizedRoots.some((root) => root !== temporaryRoot && within(root, temporaryRoot) && within(resolved, root));
  if (resolved === "/" || resolved === home || (SYSTEM_ROOTS.some((root) => resolved === root || within(resolved, root)) && !exactTemporaryRoot)) {
    throw new BridgeError("DIRECTORY_NOT_ALLOWED", "cwd is too broad or belongs to a protected system location.", false, { cwd: resolved });
  }
  return resolved;
}
