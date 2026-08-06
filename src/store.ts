import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { Entry, FileFingerprint, Manifest } from "./types.js";

export const STORE_DIR = ".agent-memoize";

const MANIFEST_FILE = "manifest.json";
const LOCK_DIR = ".lock";
const SKIP_DIRS = new Set([".git", "node_modules", STORE_DIR]);
const NAME_RE = /^[a-z0-9][a-z0-9/_-]*$/;

export function storePath(root: string): string {
  return path.join(root, STORE_DIR);
}

export async function storeExists(root: string): Promise<boolean> {
  try {
    return (await fs.stat(storePath(root))).isDirectory();
  } catch {
    return false;
  }
}

/** Entry names: lowercase segments, no dots — also makes traversal impossible. */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.split("/").includes("..");
}

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

// ---------- store IO ----------

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

/** All entries on disk. Unparseable files are reported by name, not thrown. */
export async function listEntries(
  root: string,
): Promise<{ entries: Entry[]; invalid: string[] }> {
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
}

export async function readEntry(root: string, name: string): Promise<Entry | null> {
  try {
    return parseEntry(name, await fs.readFile(entryFilePath(root, name), "utf8"));
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

export async function writeEntry(root: string, entry: Entry): Promise<void> {
  const fp = entryFilePath(root, entry.name);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await writeAtomic(fp, serializeEntry(entry));
}

export async function deleteEntry(root: string, name: string): Promise<boolean> {
  try {
    await fs.unlink(entryFilePath(root, name));
    return true;
  } catch {
    return false;
  }
}

// ---------- manifest ----------

export function emptyManifest(): Manifest {
  return { version: 1, entries: {} };
}

export async function loadManifest(root: string): Promise<Manifest> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(storePath(root), MANIFEST_FILE), "utf8"));
    if (m && typeof m === "object" && m.entries && typeof m.entries === "object") {
      return { version: 1, entries: m.entries };
    }
  } catch {
    // missing or corrupt — start over
  }
  return emptyManifest();
}

export async function saveManifest(root: string, m: Manifest): Promise<void> {
  await writeAtomic(path.join(storePath(root), MANIFEST_FILE), JSON.stringify(m, null, 2) + "\n");
}

// ---------- lock (mkdir-based, shared store may have concurrent agents) ----------

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
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
}

// ---------- hashing & trees ----------

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export async function fingerprint(root: string, rel: string): Promise<FileFingerprint> {
  const fp = path.join(root, rel);
  const st = await fs.stat(fp);
  return { sha256: await hashFile(fp), mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * True when the file's content differs from the baseline fingerprint.
 * mtime+size are checked first; sha256 is only recomputed on mismatch,
 * so verification stays cheap and never touches the agent's context.
 */
export async function fileChangedSince(
  root: string,
  rel: string,
  fp: FileFingerprint | undefined,
): Promise<boolean> {
  if (!fp) return true;
  let st;
  try {
    st = await fs.stat(path.join(root, rel));
  } catch {
    return true; // vanished
  }
  if (st.mtimeMs === fp.mtimeMs && st.size === fp.size) return false;
  return (await hashFile(path.join(root, rel))) !== fp.sha256;
}

/** Non-git fallback: recursive file list, sorted, posix-relative, symlinks skipped. */
export async function walkTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, base: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        await walk(path.join(dir, d.name), base ? `${base}/${d.name}` : d.name);
      } else if (d.isFile()) {
        out.push(base ? `${base}/${d.name}` : d.name);
      }
    }
  };
  await walk(root, "");
  return out.sort();
}

/** Glob-match a project-relative path against entry source patterns. */
export function matchesAny(sources: string[], rel: string): boolean {
  return picomatch(sources, { dot: true })(rel);
}
