import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { commitAll, gitRepo, write } from "./helpers.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function makeClient(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--root", root],
    stderr: "inherit",
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  return JSON.parse(text);
}

describe("MCP server over stdio", () => {
  it(
    "lifecycle: empty → update → recall → external edit → stale",
    async () => {
      const dir = await gitRepo();
      await write(dir, "src/auth/login.ts", "login v1");
      await commitAll(dir);

      const client = await makeClient(dir);
      try {
        expect(await callJson(client, "memoize_status")).toMatchObject({ state: "empty" });

        const upd = await callJson(client, "memoize_update", {
          name: "modules/auth",
          kind: "file",
          sources: ["src/auth/**"],
          content: "Auth is handled by JWT middleware.",
          summary: "auth notes",
        });
        expect(upd).toMatchObject({ ok: true, matchedFiles: 1 });

        expect(await callJson(client, "memoize_status")).toMatchObject({ state: "fresh" });

        const rec = await callJson(client, "memoize_recall", { topic: "modules/auth" });
        expect(rec).toMatchObject({ stale: false, author: "test-client" });
        expect(rec.content).toContain("JWT");

        // The user edits the project without the agent knowing.
        await write(dir, "src/auth/login.ts", "login v2");

        const s2 = await callJson(client, "memoize_status");
        expect(s2).toMatchObject({ state: "stale" });
        expect(s2.staleEntries[0]).toMatchObject({
          name: "modules/auth",
          changedSources: ["src/auth/login.ts"],
        });

        const rec2 = await callJson(client, "memoize_recall", { topic: "modules/auth" });
        expect(rec2).toMatchObject({
          stale: true,
          changedSources: ["src/auth/login.ts"],
        });
        expect(rec2.content).toBeUndefined();
      } finally {
        await client.close();
      }
    },
    30_000,
  );
});
