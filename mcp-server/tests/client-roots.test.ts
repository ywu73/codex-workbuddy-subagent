import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createAllowedRootsProvider, type McpRootsClient } from "../src/client-roots.js";

function client(capabilities: { roots?: unknown } | undefined, uris: string[]): McpRootsClient {
  return {
    getClientCapabilities: () => capabilities,
    listRoots: async () => ({ roots: uris.map((uri) => ({ uri })) }),
  };
}

describe("MCP client workspace roots", () => {
  it("uses exact local file roots advertised by the client", async () => {
    const provider = createAllowedRootsProvider(client({ roots: {} }, [
      pathToFileURL("/project/a").href,
      "https://example.com/not-local",
      pathToFileURL("/project/b").href,
    ]), {});
    await expect(provider("/requested")).resolves.toEqual(["/project/a", "/project/b"]);
  });

  it("prefers explicitly configured roots", async () => {
    const provider = createAllowedRootsProvider(client(undefined, []), {
      WORKBUDDY_ALLOWED_ROOTS: "/project/a:/project/b",
    });
    await expect(provider("/requested")).resolves.toEqual(["/project/a", "/project/b"]);
  });

  it("uses the exact requested directory when the client does not advertise roots", async () => {
    await expect(createAllowedRootsProvider(client(undefined, []), {})("/requested/project")).resolves.toEqual([
      "/requested/project",
    ]);
  });

  it("fails closed when no local file root is available", async () => {
    await expect(createAllowedRootsProvider(client({ roots: {} }, ["https://example.com"]), {})("/requested")).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
    });
  });
});
