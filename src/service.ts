import { promises as fs } from "node:fs";
import { dirtyList, head as gitHead, isGitRepo, trackedFiles } from "./git.js";
import { computeStatus, type StatusContext } from "./status.js";
import {
  claimLines,
  fingerprint,
  isValidName,
  matchesAny,
  storePath,
  walkTree,
} from "./workspace.js";
import { getRegistry, type Registry } from "./plugins/registry.js";
import type { DebuggingPlugin, MemoryAccessEvent, PostprocessOperation, UpdateArgs } from "./plugin.js";
import type { ClaimRegion, Entry, EntryStatus, FileFingerprint, Manifest } from "./types.js";

export { entryFilePath } from "./plugins/builtin/db-files.js";
export { storePath };

export interface ServiceContext {
  root: string;
  registry: Registry;
  /** MCP client performing the operation (clientInfo.name); appears in debugging events. */
  accessor?: string;
}

// ---------- plugin hooks ----------

/** Post-processing chain: each plugin sees the previous one's output. */
async function postprocessResults<T>(
  ctx: ServiceContext,
  op: PostprocessOperation,
  result: T,
): Promise<T | (T & Record<string, unknown>)> {
  let out: unknown = result;
  for (const p of ctx.registry.postprocessors) {
    const r = await p.postprocess(op, out);
    if (r !== undefined) out = r;
  }
  return out as T | (T & Record<string, unknown>);
}

/** Debugging hooks are observational: a failing hook never breaks the operation. */
async function notifyDebuggers(
  ctx: ServiceContext,
  fire: (p: DebuggingPlugin) => Promise<void> | void,
): Promise<void> {
  for (const p of ctx.registry.debuggers) {
    try {
      await fire(p);
    } catch (e) {
      console.error(`[memoize] debugging plugin "${p.id}" failed: ${String(e)}`);
    }
  }
}

// ---------- status ----------

export function statusContext(ctx: ServiceContext): StatusContext {
  return {
    root: ctx.root,
    db: ctx.registry.primaryDb,
    staleness: ctx.registry.staleness,
    ignoreComments: ctx.registry.ignoreComments,
  };
}

/** memoize_status: status result passed through the post-processing chain. */
export async function statusCtx(ctx: ServiceContext) {
  const result = await computeStatus(statusContext(ctx));
  return postprocessResults(ctx, "status", result);
}

// ---------- update ----------

function firstLine(content: string): string {
  return content
    .trim()
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .slice(0, 120);
}

export async function updateEntryCtx(ctx: ServiceContext, args: UpdateArgs) {
  const { root, registry } = ctx;

  let current: UpdateArgs = { ...args };
  for (const ds of registry.datasources) {
    if (!ds.processUpdate) continue;
    const r = await ds.processUpdate(current);
    if (r === null) {
      throw new Error(`update rejected by data source "${ds.id}"`);
    }
    current = r;
  }

  const { name, kind, author } = current;
  const content = current.content ?? "";
  if (!isValidName(name)) {
    throw new Error(`invalid entry name "${name}": use lowercase segments like "modules/auth"`);
  }
  if (!content.trim()) throw new Error("content must not be empty");
  if (kind === "file" && (!current.sources || current.sources.length === 0)) {
    throw new Error("sources (project-relative paths/globs) are required for kind=file");
  }
  if (kind === "decision" && current.sources?.length) {
    throw new Error("kind=decision entries take no sources");
  }

  const repo = await isGitRepo(root);
  // Capture state BEFORE writing, so the store files can never affect the baseline.
  const gitNow = repo ? { head: await gitHead(root), dirty: await dirtyList(root) } : null;
  const tree = repo
    ? [...new Set([...(await trackedFiles(root)), ...gitNow!.dirty])]
    : await walkTree(root);
  const sources = kind === "file" ? current.sources! : [];
  const matched = tree.filter((p) => matchesAny(sources, p));

  const strict = registry.staleness === "strict";
  const norm = strict ? null : { ignoreComments: registry.ignoreComments };
  const files: Record<string, FileFingerprint> = {};
  const claims: Record<string, ClaimRegion[]> = {};
  for (const p of matched) {
    const fp = await fingerprint(root, p, norm);
    if (fp) {
      files[p] = fp;
      if (norm) claims[p] = await claimLines(root, p, content + "\n" + (current.summary ?? ""));
    }
  }

  const entry: Entry = {
    name,
    kind,
    sources,
    author,
    updated: new Date().toISOString(),
    summary: current.summary?.trim() || firstLine(content),
    content,
  };

  const warnings: string[] = [];
  for (const ds of registry.datasources) {
    if (!ds.lintSources) continue;
    const w = await ds.lintSources(root, sources, matched);
    warnings.push(...w);
  }

  await fs.mkdir(storePath(root), { recursive: true });
  let updatedManifest: Manifest = { version: 1, entries: {} };
  const existed = (await registry.primaryDb.readEntry(name)) !== null;
  await registry.primaryDb.withLock(async () => {
    await registry.primaryDb.writeEntry(entry);
    const m = await registry.primaryDb.loadManifest();
    m.entries[name] = {
      git: gitNow,
      files,
      hashMode: strict ? "raw" : "normalized",
      claims: norm ? claims : undefined,
    };
    // Drop baselines whose entry files disappeared (manual deletion, failed wipe).
    const { entries } = await registry.primaryDb.listEntries();
    const onDisk = new Set(entries.map((e) => e.name));
    for (const key of Object.keys(m.entries)) {
      if (!onDisk.has(key)) delete m.entries[key];
    }
    await registry.primaryDb.saveManifest(m);
    updatedManifest = m;
  });

  // Mirror databases: best-effort fan-out; failures become warnings, not errors.
  for (const mirror of registry.databases.slice(1)) {
    try {
      await mirror.writeEntry(entry);
      await mirror.saveManifest(updatedManifest);
    } catch (e) {
      warnings.push(`mirror "${mirror.id}" failed: ${String(e)}`);
    }
  }

  const result = {
    ok: true as const,
    name,
    matchedFiles: matched.length,
    ...(kind === "file" && matched.length === 0
      ? { warning: "sources matched no files; entry will be suspended until sources match" }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  await notifyDebuggers(
    ctx,
    (p) => p.onMemoryCreated?.(entry, existed ? "refresh" : "create", ctx.accessor ?? "unknown"),
  );
  return postprocessResults(ctx, "update", result);
}

// ---------- recall ----------

export async function recallCtx(ctx: ServiceContext, topic?: string) {
  const { registry } = ctx;
  const status = await computeStatus(statusContext(ctx));
  if (status.state === "empty") return { state: "empty" as const, entries: [] };

  const { entries } = await registry.primaryDb.listEntries();
  const staleMap = new Map(status.staleEntries.map((s) => [s.name, s.changedSources]));
  const verifiedSet = new Set(status.verifiedEntries);
  const suspendedSet = new Set(status.suspendedEntries);

  let candidates = entries.map((e) => ({
    entry: e,
    status: (staleMap.has(e.name)
      ? "stale"
      : suspendedSet.has(e.name)
        ? "suspended"
        : verifiedSet.has(e.name)
          ? "verified"
          : "fresh") as EntryStatus,
    changedSources: staleMap.get(e.name) ?? [],
    annotations: {} as Record<string, unknown>,
  }));

  for (const f of registry.filters) {
    candidates = (await f.filter({ topic }, candidates)) ?? candidates;
  }

  let result: unknown;
  let access: { topic?: string; entries: { name: string; status: EntryStatus | "missing" }[] };

  if (!topic) {
    access = { entries: candidates.map((c) => ({ name: c.entry.name, status: c.status })) };
    result = {
      state: status.state,
      entries: candidates.map((c) => ({
        name: c.entry.name,
        kind: c.entry.kind,
        summary: c.entry.summary,
        author: c.entry.author,
        updated: c.entry.updated,
        stale: c.status !== "fresh" && c.status !== "verified",
        status: c.status,
        ...c.annotations,
      })),
    };
  } else {
    const c = candidates.find((c) => c.entry.name === topic);
    if (!c) {
      access = { topic, entries: [{ name: topic, status: "missing" }] };
      result = { error: `no entry "${topic}"`, available: candidates.map((c) => c.entry.name) };
    } else if (c.status === "stale") {
      access = { topic, entries: [{ name: topic, status: c.status }] };
      result = {
        name: topic,
        stale: true as const,
        status: "stale" as const,
        changedSources: c.changedSources,
        hint: "Memory is stale: re-read the changed source files, then call memoize_update to refresh this entry.",
        ...c.annotations,
      };
    } else if (c.status === "suspended") {
      access = { topic, entries: [{ name: topic, status: c.status }] };
      result = {
        name: topic,
        stale: true as const,
        status: "suspended" as const,
        changedSources: c.changedSources,
        hint: "Memory sources are gone or unmatched: re-check the files it describes, then call memoize_update to refresh this entry.",
        ...c.annotations,
      };
    } else {
      access = { topic, entries: [{ name: topic, status: c.status }] };
      const formatAnnotations: Record<string, unknown> = {};
      let rendered: unknown;
      for (const f of registry.formats) {
        const r = f.render?.(c.entry);
        if (r === undefined || r === null) continue;
        if (f === registry.formats[0]) rendered = r;
        else formatAnnotations[f.id] = r;
      }
      const content = typeof rendered === "string" ? rendered : c.entry.content;
      result = {
        name: c.entry.name,
        kind: c.entry.kind,
        author: c.entry.author,
        updated: c.entry.updated,
        summary: c.entry.summary,
        stale: false as const,
        status: c.status,
        content,
        ...(Object.keys(formatAnnotations).length > 0 ? { format: formatAnnotations } : {}),
        ...c.annotations,
      };
    }
  }

  const event: MemoryAccessEvent = { accessor: ctx.accessor ?? "unknown", ...access };
  await notifyDebuggers(ctx, (p) => p.onMemoryAccessed?.(event));
  return postprocessResults(ctx, "recall", result);
}

// ---------- invalidate ----------

export async function invalidateCtx(
  ctx: ServiceContext,
  name: string | undefined,
  confirm: boolean,
) {
  const { registry } = ctx;
  const { entries } = await registry.primaryDb.listEntries();
  if (name !== undefined && !isValidName(name)) {
    throw new Error(`invalid entry name "${name}"`);
  }
  const targets = name ? entries.filter((e) => e.name === name) : entries;

  if (confirm !== true) {
    return {
      ok: false as const,
      error: "destructive: call again with confirm=true",
      wouldRemove: name ? [name] : targets.map((e) => e.name),
    };
  }
  if (name && targets.length === 0 && !(await registry.primaryDb.readEntry(name))) {
    return { ok: false as const, error: `no entry "${name}"` };
  }

  const removed: string[] = [];
  const warnings: string[] = [];
  await registry.primaryDb.withLock(async () => {
    if (name) {
      if (await registry.primaryDb.deleteEntry(name)) removed.push(name);
      const manifest = await registry.primaryDb.loadManifest();
      delete manifest.entries[name];
      await registry.primaryDb.saveManifest(manifest);
    } else {
      for (const e of entries) {
        if (await registry.primaryDb.deleteEntry(e.name)) removed.push(e.name);
      }
      await registry.primaryDb.saveManifest({ version: 1, entries: {} });
    }
  });
  for (const mirror of registry.databases.slice(1)) {
    try {
      if (name) {
        await mirror.deleteEntry(name);
        const m = await mirror.loadManifest();
        delete m.entries[name];
        await mirror.saveManifest(m);
      } else {
        for (const e of entries) await mirror.deleteEntry(e.name);
        await mirror.saveManifest({ version: 1, entries: {} });
      }
    } catch (e) {
      warnings.push(`mirror "${mirror.id}" failed: ${String(e)}`);
    }
  }
  const result = {
    ok: true as const,
    removed,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return postprocessResults(ctx, "invalidate", result);
}

// ---------- root-based entry points (default registry, for tests/tools) ----------

export async function updateEntry(root: string, args: UpdateArgs) {
  const registry = await getRegistry(root);
  return updateEntryCtx({ root, registry }, args);
}

export async function recall(root: string, topic?: string) {
  const registry = await getRegistry(root);
  return recallCtx({ root, registry }, topic);
}

export async function invalidate(root: string, name: string | undefined, confirm: boolean) {
  const registry = await getRegistry(root);
  return invalidateCtx({ root, registry }, name, confirm);
}

export async function statusForRoot(root: string) {
  const registry = await getRegistry(root);
  return statusCtx({ root, registry });
}
