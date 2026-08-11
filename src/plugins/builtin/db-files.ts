import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { DatabasePlugin, PluginContext } from "../../plugin.js";
import { storePath } from "../../workspace.js";
import type { Entry, Manifest } from "../../types.js";

const MANIFEST_FILE = "manifest.json";
const LOCK_DIR = ".lock";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

export function entryFilePath(root: string, name: string): string {
  return path.join(storePath(root), ...name.split("/")) + ".md";
}

// ---------- entry (markdown + YAML front matter) ----------

export function serializeEntry(e: Entry): string {
  const fm: Record<string, unknown> = { kind: e.kind };
  if (e.kind === "file") fm.sources = e.sources;
  fm.author = e.author;
  fm.updated = e.updated;
  fm.summary = e.summary;
  return `---\n${yamlStringify(fm)}---\n\n${e.content.trim()}\n`;
}

export function parseEntry(name: string, text: string): Entry {
  if (!text.startsWith("---\n")) throw new Error("missing front matter");
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new Error("unterminated front matter");
  const meta = (yamlParse(text.slice(4, end)) ?? {}) as Record<string, unknown>;
  const content = text.slice(end + 4).replace(/^(\r?\n)+/, "");
  const kind = meta.kind;
  if (kind !== "file" && kind !== "decision") throw new Error(`bad kind: ${String(meta.kind)}`);
  const sources = Array.isArray(meta.sources) ? meta.sources.map(String) : [];
  if (kind === "file" && sources.length === 0) throw new Error("file entry without sources");
  return {
    name,
    kind,
    sources,
    author: typeof meta.author === "string" ? meta.author : "unknown",
    updated: typeof meta.updated === "string" ? meta.updated : "",
    summary: typeof meta.summary === "string" ? meta.summary : "",
    content,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";

export const plugin: DatabasePlugin = {
  id: "files",
  version: "1.0.0",
  type: "database",

  async init(ctx: PluginContext) {
    root = ctx.root;
  },

  async listEntries() {
    const names: string[] = [];
    await walkStore(storePath(root), "", names);
    const entries: Entry[] = [];
    const invalid: string[] = [];
    for (const name of names.sort()) {
      try {
        entries.push(parseEntry(name, await fs.readFile(entryFilePath(root, name), "utf8")));
      } catch {
        invalid.push(name);
      }
    }
    return { entries, invalid };
  },

  async readEntry(name) {
    try {
      return parseEntry(name, await fs.readFile(entryFilePath(root, name), "utf8"));
    } catch {
      return null;
    }
  },

  async writeEntry(entry) {
    const fp = entryFilePath(root, entry.name);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await writeAtomic(fp, serializeEntry(entry));
  },

  async deleteEntry(name) {
    try {
      await fs.unlink(entryFilePath(root, name));
      return true;
    } catch {
      return false;
    }
  },

  async loadManifest() {
    try {
      const m = JSON.parse(await fs.readFile(path.join(storePath(root), MANIFEST_FILE), "utf8"));
      if (m && typeof m === "object" && m.entries && typeof m.entries === "object") {
        return { version: 1, entries: m.entries };
      }
    } catch {
      // missing or corrupt — start over
    }
    return { version: 1, entries: {} };
  },

  async saveManifest(m: Manifest) {
    const fp = path.join(storePath(root), MANIFEST_FILE);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await writeAtomic(fp,
      JSON.stringify(m, null, 2) + "\n",
    );
  },

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = path.join(storePath(root), LOCK_DIR);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const st = await fs.stat(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Crashed agent left the lock behind; reclaim it.
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between stat attempts
        }
        if (Date.now() > deadline) throw new Error("memoize: timed out waiting for store lock");
        await sleep(100);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  },
};

async function walkStore(dir: string, base: string, out: string[]): Promise<void> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (d.name === LOCK_DIR) continue;
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) await walkStore(path.join(dir, d.name), rel, out);
    else if (d.isFile() && d.name.endsWith(".md")) out.push(rel.slice(0, -3));
  }
}

/** Atomic write: temp file in the same directory, then rename. */
async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

export function emptyManifest(): Manifest {
  return { version: 1, entries: {} };
}
