#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeStatus } from "./status.js";
import { invalidateCtx, recallCtx, statusContext, updateEntryCtx, type ServiceContext } from "./service.js";
import { Registry } from "./plugins/registry.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function usage(): string {
  return `agent-memoize ${VERSION} — shared project-memory MCP server

Usage: agent-memoize [--root <dir>] [--plugins <json>]

Options:
  --root <dir>       Project root containing (or to contain) .agent-memoize/
                     Default: MEMOIZE_ROOT env var, else the current directory.
  --plugins <json>   Override .agent-memoize/config.json plugins, e.g.
                     [{ "id": "files", "priority": 100 }, ...]
  -h, --help         Show this help.
  -v, --version      Show version.

Env:
  MEMOIZE_PLUGINS      JSON array of plugins (same shape as --plugins).
  MEMOIZE_STALENESS    strict | claims | cosmetic-only.
`;
}

function parseArgs(argv: string[]): { root: string; plugins?: string } {
  let root: string | undefined;
  let plugins: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      root = argv[++i];
      if (!root) throw new Error("--root requires a value");
    } else if (a === "--plugins") {
      plugins = argv[++i];
      if (!plugins) throw new Error("--plugins requires a value");
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
  return { root: path.resolve(root ?? process.env.MEMOIZE_ROOT ?? process.cwd()), plugins };
}

const { root, plugins: cliPlugins } = parseArgs(process.argv.slice(2));

let registry: Registry;
try {
  registry = await Registry.create({ root, cliPlugins });
} catch (e) {
  console.error(
    `agent-memoize: failed to load plugins: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}

const ctx: ServiceContext = { root, registry };
const server = new McpServer({ name: "agent-memoize", version: VERSION });

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true as const,
});

const primaryFormat = registry.formats[0];
const promptSections: string[] = [];
if (primaryFormat?.prompt) {
  promptSections.push(`## Memory format (${primaryFormat.id})\n${primaryFormat.prompt}`);
}
for (const f of registry.formats.slice(1)) {
  if (f.prompt) promptSections.push(`## Format annotation (${f.id})\n${f.prompt}`);
}
for (const ds of registry.datasources) {
  const t = ds.describeUpdate?.();
  if (t) promptSections.push(`## Data source (${ds.id})\n${t}`);
}
const updateExtras = promptSections.length > 0 ? `\n\n${promptSections.join("\n\n")}` : "";

server.registerTool(
  "memoize_status",
  {
    description:
      "Project-memory staleness check. Call once at session start, before exploring the codebase. " +
      "Returns which files changed externally and which memory entries are stale, verified " +
      "(auto re-baselined), or suspended (sources unresolved).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await computeStatus(statusContext(ctx)));
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
      "staleness — no content). With `topic`: returns the entry content if fresh or verified; " +
      "if stale, returns the changed source files to re-read instead. Call before analyzing " +
      "project files.",
    inputSchema: {
      topic: z.string().optional().describe("entry name, e.g. \"modules/auth\""),
    },
  },
  async ({ topic }) => {
    try {
      return ok(await recallCtx(ctx, topic));
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
      "kind=\"file\" describes code and requires `sources` (project-relative paths/globs it is " +
      "derived from) — it is invalidated automatically when those files change. " +
      "kind=\"decision\" records user decisions/preferences, takes no sources, and is never " +
      "invalidated by file changes." +
      updateExtras,
    inputSchema: {
      name: z.string().describe("lowercase path-like name, e.g. \"modules/auth\""),
      content: z.string().describe("memory body in the configured format"),
      kind: z.enum(["file", "decision"]),
      sources: z.array(z.string()).optional(),
      summary: z.string().optional().describe("one-line summary for the recall index"),
      author: z
        .string()
        .optional()
        .describe("override the recorded author (defaults to your MCP client name)"),
    },
  },
  async (args) => {
    try {
      const author = args.author ?? server.server.getClientVersion()?.name ?? "unknown";
      return ok(await updateEntryCtx(ctx, { ...args, author }));
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
      return ok(await invalidateCtx(ctx, name, confirm));
    } catch (e) {
      return fail(e);
    }
  },
);

for (const t of registry.tools) {
  server.registerTool(
    t.name,
    {
      description: t.description ?? "Provided by a memoize plugin.",
      inputSchema: t.schema,
    },
    async (args) => {
      try {
        return ok(await t.handler((args as Record<string, unknown>) ?? {}));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

const shutdown = async (signal: string) => {
  console.error(`[memoize] ${signal}: shutting down`);
  try {
    await registry.shutdown();
  } finally {
    process.exit(0);
  }
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await server.connect(new StdioServerTransport());
