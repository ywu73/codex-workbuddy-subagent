import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const APP_CLI_PATH = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

export interface ResolveOptions {
  pathValue?: string;
  fixedCandidates?: readonly string[];
}

function pathCandidates(name: string, pathValue: string): string[] {
  return pathValue.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, name));
}

export async function resolveCli(options: ResolveOptions = {}): Promise<string> {
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const candidates = [
    ...pathCandidates("codebuddy", pathValue),
    ...pathCandidates("cbc", pathValue),
    ...(options.fixedCandidates ?? [APP_CLI_PATH]),
  ];
  let sawUnexecutable = false;

  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES") sawUnexecutable = true;
    }
  }

  if (sawUnexecutable) {
    throw new BridgeError("CLI_UNEXECUTABLE", "A WorkBuddy CLI candidate exists but is not executable.");
  }
  throw new BridgeError("CLI_NOT_FOUND", "WorkBuddy CLI was not found in any supported location.");
}
