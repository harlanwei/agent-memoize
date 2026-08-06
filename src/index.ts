#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeStatus } from "./status.js";
import { invalidate, recall, updateEntry } from "./service.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function usage(): string {
  return `agent-memoize ${VERSION} — shared project-memory MCP server

Usage: agent-memoize [--root <dir>]

Options:
  --root <dir>   Project root containing (or to contain) .agent-memoize/
                 Default: MEMOIZE_ROOT env var, else the current directory.
  -h, --help     Show this help.
  -v, --version  Show version.
`;
}

function parseArgs(argv: string[]): { root: string } {
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      root = argv[++i];
      if (!root) throw new Error("--root requires a value");
    } else if (a === "-h" || a === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (a === "-v" || a === "--version") {
      console.log(VERSION);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}\n${usage()}`);
    }
  }
  return { root: path.resolve(root ?? process.env.MEMOIZE_ROOT ?? process.cwd()) };
}

const { root } = parseArgs(process.argv.slice(2));

const server = new McpServer({ name: "agent-memoize", version: VERSION });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true as const,
});

server.registerTool(
  "memoize_status",
  {
    description:
      "Project-memory staleness check. Call once at session start, before exploring the codebase. " +
      "Returns which files changed externally and which memory entries are stale.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await computeStatus(root));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "memoize_recall",
  {
    description:
      "Read project memories. Without `topic`: returns an index of entries (names, summaries, " +
      "staleness — no content). With `topic`: returns the entry content if fresh; if stale, " +
      "returns the changed source files to re-read instead. Call before analyzing project files.",
    inputSchema: {
      topic: z.string().optional().describe('entry name, e.g. "modules/auth"'),
    },
  },
  async ({ topic }) => {
    try {
      return ok(await recall(root, topic));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "memoize_update",
  {
    description:
      "Create or refresh a memory entry after editing files or learning something durable. " +
      'kind="file" describes code and requires `sources` (project-relative paths/globs it is ' +
      "derived from) — it is invalidated automatically when those files change. " +
      'kind="decision" records user decisions/preferences, takes no sources, and is never ' +
      "invalidated by file changes.",
    inputSchema: {
      name: z.string().describe('lowercase path-like name, e.g. "modules/auth"'),
      content: z.string().describe("markdown body of the memory"),
      kind: z.enum(["file", "decision"]),
      sources: z.array(z.string()).optional(),
      summary: z.string().optional().describe("one-line summary for the recall index"),
      author: z.string().optional().describe("override the recorded author (defaults to your MCP client name)"),
    },
  },
  async (args) => {
    try {
      const author = args.author ?? server.server.getClientVersion()?.name ?? "unknown";
      return ok(await updateEntry(root, { ...args, author }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "memoize_invalidate",
  {
    description:
      "Delete memory entries. With `name`: deletes that entry. Without: wipes the whole shared " +
      "store. Requires confirm=true.",
    inputSchema: {
      name: z.string().optional(),
      confirm: z.boolean().describe("must be true; the store is shared across agents"),
    },
  },
  async ({ name, confirm }) => {
    try {
      return ok(await invalidate(root, name, confirm));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
