import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ObserverPlugin, PluginContext } from "@naevic/agent-memoize";

const DEFAULT_PORT = 8888;
const DEFAULT_MAX_LOGS = 1000;

export interface LogRecord {
  /** Globally unique across processes: "<pid>.<seq>". */
  id: string | number;
  ts: string;
  event: "memory.created" | "memory.accessed";
  data: unknown;
}

function numOption(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

// ---------- HTTP dashboard ----------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agent-memoize dashboard</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; color: #1f2328; }
  h1 { font-size: 1.2rem; }
  #stats { color: #57606a; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #d0d7de; vertical-align: top; }
  td.event, td.agent { white-space: nowrap; font-family: monospace; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: .8rem; }
</style>
</head>
<body>
<h1>agent-memoize activity</h1>
<div id="stats"></div>
<table>
  <thead><tr><th>time</th><th>event</th><th>agent</th><th>details</th></tr></thead>
  <tbody id="logs"></tbody>
</table>
<script>
async function refresh() {
  try {
    const res = await fetch("/api/logs");
    const data = await res.json();
    const el = document.getElementById("logs");
    const created = data.logs.filter(l => l.event === "memory.created").length;
    const accessed = data.logs.filter(l => l.event === "memory.accessed").length;
    document.getElementById("stats").textContent =
      data.logs.length + " log entries · " + created + " created · " + accessed + " accessed";
    el.innerHTML = data.logs.slice().reverse().map(l => {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(l.data, null, 2);
      const local = new Date(l.ts).toLocaleString();
      return '<tr><td>' + local + '</td><td class="event">' + l.event +
        '</td><td class="agent">' + (l.data.accessor ?? (l.data.entry && l.data.entry.author) ?? "—") +
        '</td><td>' + pre.outerHTML + '</td></tr>';
    }).join("");
  } catch (e) {
    document.getElementById("stats").textContent = "dashboard unreachable: " + e;
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;

function listen(srv: Server, p: number): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(p, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });
}

/** True when the port is held by a dashboard serving the same project. */
async function isSiblingDashboard(p: number, root: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/logs`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { project?: unknown };
    return body?.project === root;
  } catch {
    return false;
  }
}

export interface DashboardPlugin extends ObserverPlugin {
  logs(): LogRecord[];
  url(): string;
}

/** Fresh state per registry/root; sibling processes coordinate only through JSONL + HTTP. */
export function createPlugin(): DashboardPlugin {
  let server: Server | null = null;
  let port = DEFAULT_PORT;
  let maxLogs = DEFAULT_MAX_LOGS;
  let logFile: string | null = null;
  let project = "";
  let baseUrl = "";
  let seq = 0;
  let fileSize = 0;
  const buffer: LogRecord[] = [];
  const seenIds = new Set<string>();
  const pendingWrites = new Set<Promise<void>>();

  const merge = (rec: LogRecord): void => {
    const key = String(rec.id);
    if (seenIds.has(key)) return;
    seenIds.add(key);
    buffer.push(rec);
    if (buffer.length > maxLogs) {
      for (const dropped of buffer.splice(0, buffer.length - maxLogs)) {
        seenIds.delete(String(dropped.id));
      }
    }
  };

  const record = (event: LogRecord["event"], data: unknown): void => {
    const rec: LogRecord = {
      id: `${process.pid}.${++seq}`,
      ts: new Date().toISOString(),
      event,
      data,
    };
    merge(rec);
    if (!logFile) return;
    const write = fs.appendFile(logFile, JSON.stringify(rec) + "\n", "utf8").catch(() => {});
    pendingWrites.add(write);
    void write.then(() => pendingWrites.delete(write));
  };

  const syncFromFile = async (): Promise<void> => {
    if (!logFile || !server) return;
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(logFile);
    } catch {
      return;
    }
    if (st.size === fileSize) return;
    if (st.size < fileSize) fileSize = 0;
    const len = st.size - fileSize;
    const chunk = Buffer.alloc(len);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(logFile, "r");
      const { bytesRead } = await handle.read(chunk, 0, len, fileSize);
      const part = chunk.subarray(0, bytesRead);
      const lastNl = part.lastIndexOf(0x0a);
      if (lastNl < 0) return;
      fileSize += lastNl + 1;
      for (const line of part.toString("utf8", 0, lastNl).split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as LogRecord;
          if (
            rec &&
            (typeof rec.id === "string" || typeof rec.id === "number") &&
            typeof rec.event === "string"
          ) merge(rec);
        } catch {
          // corrupt line — skip
        }
      }
    } catch {
      // read race (file replaced) — next poll retries
    } finally {
      await handle?.close();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/logs") {
      await syncFromFile();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ project, logs: buffer }));
    } else if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  };

  return {
    id: "dashboard",
    version: "1.0.0",
    type: "observer",
    logs: () => [...buffer],
    url: () => baseUrl,

    async init(ctx: PluginContext) {
      port = numOption(ctx.options.port, DEFAULT_PORT);
      maxLogs = numOption(ctx.options.maxLogs, DEFAULT_MAX_LOGS);
      project = ctx.root;
      const file = ctx.options.logFile;
      logFile = file === false
        ? null
        : typeof file === "string"
          ? path.resolve(ctx.root, file)
          : path.join(ctx.root, ".agent-memoize", "logs", "dashboard.jsonl");
      if (logFile) await fs.mkdir(path.dirname(logFile), { recursive: true });

      const candidate = createServer(handle);
      try {
        await listen(candidate, port);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
        if (await isSiblingDashboard(port, project)) {
          ctx.log(
            "info",
            `dashboard already running for this project at http://127.0.0.1:${port} — logging only`,
          );
          return;
        }
        port = 0;
        await listen(candidate, 0);
        ctx.log("warn", "configured dashboard port is held by another service; using a random port");
      }
      server = candidate;
      const address = server.address();
      if (address && typeof address === "object") port = address.port;
      baseUrl = `http://127.0.0.1:${port}`;
      if (logFile) await syncFromFile();
      ctx.log("info", `dashboard listening at ${baseUrl}`);
    },

    async shutdown() {
      if (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      baseUrl = "";
    },

    onMemoryCreated(entry, operation, accessor) {
      record("memory.created", { operation, accessor, entry });
    },

    onMemoryAccessed(access) {
      record("memory.accessed", access);
    },
  };
}

/**
 * Backward-compatible singleton surface that is also callable by the registry
 * loader, which receives a fresh instance on every call.
 */
const defaultPlugin = createPlugin();
export const plugin = Object.assign(
  () => createPlugin(),
  defaultPlugin,
) as (() => DashboardPlugin) & DashboardPlugin;
export const logs = (): LogRecord[] => defaultPlugin.logs();
export const url = (): string => defaultPlugin.url();
export default createPlugin;
