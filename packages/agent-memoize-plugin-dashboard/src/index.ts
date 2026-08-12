import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DebuggingPlugin, PluginContext } from "@naevic/agent-memoize";

const DEFAULT_PORT = 8888;
const DEFAULT_MAX_LOGS = 1000;

export interface LogRecord {
  /** Globally unique across processes: "<pid>.<seq>". */
  id: string | number;
  ts: string;
  event: "memory.created" | "memory.accessed";
  data: unknown;
}

let server: Server | null = null;
let port = DEFAULT_PORT;
let maxLogs = DEFAULT_MAX_LOGS;
let logFile: string | null = null;
let project = "";
let baseUrl = "";
let seq = 0;
const buffer: LogRecord[] = [];
const seenIds = new Set<string>();
/** Bytes of logFile already incorporated into the buffer. */
let fileSize = 0;
/** In-flight JSONL appends, flushed on shutdown (log-only instances persist only this way). */
let pendingWrites: Promise<void>[] = [];

function numOption(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

// ---------- shared JSONL log (single source of truth across processes) ----------

function merge(rec: LogRecord): void {
  const key = String(rec.id);
  if (seenIds.has(key)) return;
  seenIds.add(key);
  buffer.push(rec);
  if (buffer.length > maxLogs) {
    const dropped = buffer.splice(0, buffer.length - maxLogs);
    for (const d of dropped) seenIds.delete(String(d.id));
  }
}

function record(event: LogRecord["event"], data: unknown): LogRecord {
  const rec: LogRecord = {
    id: `${process.pid}.${++seq}`,
    ts: new Date().toISOString(),
    event,
    data,
  };
  merge(rec);
  if (logFile) {
    const w = fs
      .appendFile(logFile, JSON.stringify(rec) + "\n", "utf8")
      .catch(() => {})
      .finally(() => {
        const i = pendingWrites.indexOf(w);
        if (i >= 0) pendingWrites.splice(i, 1);
      });
    pendingWrites.push(w);
  }
  return rec;
}

/**
 * Tail the JSONL file and merge records written by other processes
 * (sibling agent sessions). Called on every /api/logs request.
 */
async function syncFromFile(): Promise<void> {
  if (!logFile || !server) return;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(logFile);
  } catch {
    return;
  }
  if (st.size === fileSize) return;
  if (st.size < fileSize) fileSize = 0; // file was rewritten — re-read
  const len = st.size - fileSize;
  const chunk = Buffer.alloc(len);
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(logFile, "r");
    const { bytesRead } = await fh.read(chunk, 0, len, fileSize);
    const part = chunk.subarray(0, bytesRead);
    // Only consume complete lines; a partial tail (crash mid-write) is re-read next poll.
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
        ) {
          merge(rec);
        }
      } catch {
        // corrupt line — skip
      }
    }
  } catch {
    // read race (file replaced) — next poll retries
  } finally {
    await fh?.close();
  }
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/logs") {
    await syncFromFile();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ project, logs: buffer }));
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

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

// ---------- test surface ----------

/** Recent in-memory log records (newest last). */
export function logs(): LogRecord[] {
  return [...buffer];
}

/** Base URL of the dashboard served by this process ("" in log-only mode). */
export function url(): string {
  return baseUrl;
}

export const plugin: DebuggingPlugin = {
  id: "dashboard",
  version: "1.0.0",
  type: "debugging",

  async init(ctx: PluginContext) {
    port = numOption(ctx.options.port, DEFAULT_PORT);
    maxLogs = numOption(ctx.options.maxLogs, DEFAULT_MAX_LOGS);
    project = ctx.root;
    const file = ctx.options.logFile;
    if (file !== false) {
      const p =
        typeof file === "string"
          ? path.resolve(ctx.root, file)
          : path.join(ctx.root, ".agent-memoize", "logs", "dashboard.jsonl");
      await fs.mkdir(path.dirname(p), { recursive: true });
      logFile = p;
    }
    // State belongs to the HTTP-owning instance of this process. When another
    // dashboard already runs here (sibling test instance), leave its state alone.
    if (!server) {
      buffer.length = 0;
      seq = 0;
      seenIds.clear();
      fileSize = 0;
      baseUrl = "";
    }
    const srv = createServer(handle);
    try {
      await listen(srv, port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      if (await isSiblingDashboard(port, project)) {
        // Another agent's session already serves this project's dashboard:
        // don't start a second HTTP instance, but keep logging to the
        // shared JSONL file — the running instance tails it.
        ctx.log(
          "info",
          `dashboard already running for this project at http://127.0.0.1:${port} — logging only`,
        );
        return;
      }
      // The port is held by an unrelated service: serve on a random port instead.
      port = 0;
      await listen(srv, 0);
      ctx.log("warn", "configured dashboard port is held by another service; using a random port");
    }
    server = srv;
    const addr = server.address();
    if (addr && typeof addr === "object") port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
    if (logFile) await syncFromFile(); // replay history persisted by previous sessions
    ctx.log("info", `dashboard listening at ${baseUrl}`);
  },

  async shutdown() {
    if (pendingWrites.length > 0) await Promise.allSettled(pendingWrites);
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    baseUrl = "";
  },

  async onMemoryCreated(entry, operation, accessor) {
    record("memory.created", { operation, accessor, entry });
  },

  async onMemoryAccessed(access) {
    record("memory.accessed", access);
  },
};
