import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";
import { configuredAllowedRoots } from "./policy.js";

export interface McpRootsClient {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(): Promise<{ roots: Array<{ uri: string }> }>;
}

export type AllowedRootsProvider = (requestedCwd: string) => Promise<readonly string[]>;

export function createAllowedRootsProvider(
  client: McpRootsClient,
  env: NodeJS.ProcessEnv = process.env,
): AllowedRootsProvider {
  return async (requestedCwd) => {
    if (env.WORKBUDDY_ALLOWED_ROOTS) return configuredAllowedRoots(env);
    if (client.getClientCapabilities()?.roots === undefined) {
      return [requestedCwd];
    }

    let response: { roots: Array<{ uri: string }> };
    try {
      response = await client.listRoots();
    } catch (error) {
      throw new BridgeError(
        "CAPABILITY_MISSING",
        "The MCP client workspace roots could not be read.",
        false,
        { cause: error instanceof Error ? error.name : "UnknownError" },
      );
    }

    const roots = response.roots.flatMap(({ uri }) => {
      try {
        const parsed = new URL(uri);
        return parsed.protocol === "file:" ? [fileURLToPath(parsed)] : [];
      } catch {
        return [];
      }
    });
    if (roots.length === 0) {
      throw new BridgeError(
        "CAPABILITY_MISSING",
        "The MCP client did not expose any local file workspace root.",
      );
    }
    return roots;
  };
}
