import { promises as fs } from "node:fs";
import { captureBaseline } from "./baseline.js";
import { computeStatus, type StatusContext } from "./status.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./snapshot.js";
import { isValidName, storePath } from "./workspace.js";
import { getRegistry, type Registry } from "./plugins/registry.js";
import type { LedgerPlugin, MemoryAccessEvent, ObserverPlugin, OrganizerOperation, RecallCandidate, UpdateArgs } from "./plugin.js";
import type { Entry, EntryStatus, StaleEntry, StatusResult } from "./types.js";

export { entryFilePath } from "./plugins/builtin/file-ledger.js";
export { storePath };

export interface ServiceContext {
  root: string;
  registry: Registry;
  /** MCP client performing the operation (clientInfo.name); appears in observer events. */
  accessor?: string;
}

// ---------- plugin hooks ----------

/** Organizer chain: each plugin sees the previous one's output. */
async function organizeResults<T>(
  ctx: ServiceContext,
  op: OrganizerOperation,
  result: T,
): Promise<T | (T & Record<string, unknown>)> {
  let out: unknown = result;
  for (const p of ctx.registry.organizers) {
    const r = await p.organize(op, out);
    if (r !== undefined) out = r;
  }
  return out as T | (T & Record<string, unknown>);
}

/** Observer hooks are observational: a failing hook never breaks the operation. */
async function notifyObservers(
  ctx: ServiceContext,
  fire: (p: ObserverPlugin) => Promise<void> | void,
): Promise<void> {
  for (const p of ctx.registry.observers) {
    try {
      await fire(p);
    } catch (e) {
      console.error(`[memoize] observer plugin "${p.id}" failed: ${String(e)}`);
    }
  }
}

// ---------- status ----------

/** Cap for merged lists, matching the per-ledger cap in status.ts. */
const STATUS_CAP = 50;

function statusContextFor(ctx: ServiceContext, db: LedgerPlugin): StatusContext {
  return {
    root: ctx.root,
    db,
    staleness: ctx.registry.staleness,
    ignoreComments: ctx.registry.ignoreComments,
  };
}

/** Merge per-ledger status results: union everything; stale if any ledger is stale. */
function mergeStatus(results: StatusResult[]): StatusResult {
  const first = results[0]!;
  let mergeTruncated = false;
  const union = (key: "changedFiles" | "addedFiles" | "deletedFiles" | "cosmeticChanges") => {
    const values = [...new Set(results.flatMap((r) => r[key]))].sort();
    if (values.length > STATUS_CAP) mergeTruncated = true;
    return values.slice(0, STATUS_CAP);
  };
  const unionNames = (key: "verifiedEntries" | "suspendedEntries" | "invalidEntries") =>
    [...new Set(results.flatMap((r) => r[key]))].sort();
  const stale = new Map<string, StaleEntry>();
  for (const r of results) {
    for (const entry of r.staleEntries) {
      if (!stale.has(entry.name)) stale.set(entry.name, entry);
    }
  }
  return {
    state: results.some((r) => r.state === "stale")
      ? "stale"
      : results.every((r) => r.state === "empty")
        ? "empty"
        : "fresh",
    mode: first.mode,
    changedFiles: union("changedFiles"),
    addedFiles: union("addedFiles"),
    deletedFiles: union("deletedFiles"),
    cosmeticChanges: union("cosmeticChanges"),
    verifiedEntries: unionNames("verifiedEntries"),
    suspendedEntries: unionNames("suspendedEntries"),
    staleEntries: [...stale.values()],
    invalidEntries: unionNames("invalidEntries"),
    truncated: mergeTruncated || results.some((r) => r.truncated),
  };
}

/** memoize_status: per-ledger staleness merged, then passed through the organizer chain. */
export async function statusCtx(ctx: ServiceContext) {
  const listings = await Promise.all(ctx.registry.ledgers.map((db) => db.listEntries()));
  const snapshot = listings.some(({ entries }) => entries.length > 0)
    ? await createWorkspaceSnapshot(ctx.root)
    : undefined;
  const results = await Promise.all(
    ctx.registry.ledgers.map((db, i) =>
      computeStatus(statusContextFor(ctx, db), { listing: listings[i], snapshot }),
    ),
  );
  return organizeResults(ctx, "status", mergeStatus(results));
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
  for (const ds of registry.producers) {
    if (!ds.processUpdate) continue;
    const r = await ds.processUpdate(current);
    if (r === null) {
      throw new Error(`update rejected by producer "${ds.id}"`);
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

  const sources = kind === "file" ? current.sources! : [];
  const strict = registry.staleness === "strict";
  const entry: Entry = {
    name,
    kind,
    sources,
    author,
    updated: new Date().toISOString(),
    summary: current.summary?.trim() || firstLine(content),
    content,
  };
  // Capture state before writing, so store files can never affect the baseline.
  const snapshot = await createWorkspaceSnapshot(root);
  const { baseline, matched } = await captureBaseline(snapshot, {
    sources,
    content,
    summary: entry.summary,
    normalized: !strict,
    ignoreComments: registry.ignoreComments,
  });

  const warnings: string[] = [];
  for (const ds of registry.producers) {
    if (!ds.lintSources) continue;
    const w = await ds.lintSources(root, sources, matched);
    warnings.push(...w);
  }

  await fs.mkdir(storePath(root), { recursive: true });
  const existed = (await registry.primaryDb.readEntry(name)) !== null;
  // Writes go to the first ledger of the first group only; porting memories
  // to other ledgers is the organizer's job.
  await registry.primaryDb.withLock(async () => {
    await registry.primaryDb.writeEntry(entry);
    const m = await registry.primaryDb.loadManifest();
    m.entries[name] = baseline;
    // Drop baselines whose entry files disappeared (manual deletion, failed wipe).
    const { entries } = await registry.primaryDb.listEntries();
    const onDisk = new Set(entries.map((e) => e.name));
    for (const key of Object.keys(m.entries)) {
      if (!onDisk.has(key)) delete m.entries[key];
    }
    await registry.primaryDb.saveManifest(m);
  });

  const result = {
    ok: true as const,
    name,
    matchedFiles: matched.length,
    ...(kind === "file" && matched.length === 0
      ? { warning: "sources matched no files; entry will be suspended until sources match" }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  await notifyObservers(
    ctx,
    (p) => p.onMemoryCreated?.(entry, existed ? "refresh" : "create", ctx.accessor ?? "unknown"),
  );
  return organizeResults(ctx, "update", result);
}

// ---------- recall ----------

/**
 * Render an entry body through the writer chain: the primary writer shapes the
 * content, any later writer contributes an annotation under its plugin id.
 */
function renderEntry(
  registry: Registry,
  entry: Entry,
): { content: string; format?: Record<string, unknown> } {
  const formatAnnotations: Record<string, unknown> = {};
  let rendered: unknown;
  for (const f of registry.writers) {
    const r = f.render?.(entry);
    if (r === undefined || r === null) continue;
    if (f === registry.writers[0]) rendered = r;
    else formatAnnotations[f.id] = r;
  }
  return {
    content: typeof rendered === "string" ? rendered : entry.content,
    ...(Object.keys(formatAnnotations).length > 0 ? { format: formatAnnotations } : {}),
  };
}

/**
 * `includeStale` opts into receiving the stored body of a stale or suspended
 * entry. Reorganizing a memory means rewriting text that already exists, so a
 * dreaming agent needs the old body — but it is never served by default, since
 * acting on stale content as if it were true is exactly what the gate prevents.
 */
export async function recallCtx(
  ctx: ServiceContext,
  topic?: string,
  includeStale = false,
) {
  const { registry } = ctx;
  let sawEntries = false;
  let firstState: StatusResult["state"] = "fresh";
  const availableNames: string[] = [];
  const availableNameSet = new Set<string>();
  let snapshot: Promise<WorkspaceSnapshot> | undefined;
  const workspace = () => snapshot ??= createWorkspaceSnapshot(ctx.root);
  let result: unknown;
  let access: { topic?: string; entries: { name: string; status: EntryStatus | "missing" }[] } = {
    entries: [],
  };

  // Ledger groups are tried in order; within a group the ledgers are queried
  // in parallel and merged by entry name — the front ledger wins on
  // contradiction. If the group's candidates survive the filter chain, they
  // are the truth; otherwise recall continues with the next group.
  outer: for (const group of registry.ledgerGroups) {
    const lists = await Promise.all(group.map((db) => db.listEntries()));
    const shared = lists.some(({ entries }) => entries.length > 0) ? await workspace() : undefined;
    const statuses = await Promise.all(
      group.map((db, i) =>
        computeStatus(statusContextFor(ctx, db), { listing: lists[i], snapshot: shared }),
      ),
    );
    const status = mergeStatus(statuses);
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const e of list.entries) {
        if (!seen.has(e.name)) {
          seen.add(e.name);
          entries.push(e);
        }
      }
    }
    if (entries.length === 0) continue;
    sawEntries = true;
    firstState = status.state;

    const staleMap = new Map(status.staleEntries.map((s) => [s.name, s]));
    const verifiedSet = new Set(status.verifiedEntries);
    const suspendedSet = new Set(status.suspendedEntries);
    let candidates: RecallCandidate[] = entries.map((e) => ({
      entry: e,
      status: (staleMap.has(e.name)
        ? "stale"
        : suspendedSet.has(e.name)
          ? "suspended"
          : verifiedSet.has(e.name)
            ? "verified"
            : "fresh") as EntryStatus,
      changedSources: staleMap.get(e.name)?.changedSources ?? [],
      brokenClaims: staleMap.get(e.name)?.brokenClaims,
      annotations: {} as Record<string, unknown>,
    }));
    for (const f of registry.filters) {
      candidates = (await f.filter({ topic }, candidates)) ?? candidates;
    }
    for (const c of candidates) {
      if (!availableNameSet.has(c.entry.name)) {
        availableNameSet.add(c.entry.name);
        availableNames.push(c.entry.name);
      }
    }

    if (!topic) {
      if (candidates.length === 0) continue;
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
      break outer;
    }

    const c = candidates.find((c) => c.entry.name === topic);
    if (!c) continue;
    access = { topic, entries: [{ name: topic, status: c.status }] };
    if (c.status === "stale") {
      result = {
        name: topic,
        stale: true as const,
        status: "stale" as const,
        changedSources: c.changedSources,
        ...(c.brokenClaims && c.brokenClaims.length > 0 ? { brokenClaims: c.brokenClaims } : {}),
        hint:
          c.brokenClaims && c.brokenClaims.length > 0
            ? "Memory is stale: the listed claim regions no longer match. Re-read those specific source regions and patch this entry in place via memoize_update."
            : "Memory is stale: re-read the changed source files, then call memoize_update to refresh this entry.",
        ...(includeStale ? renderEntry(registry, c.entry) : {}),
        ...c.annotations,
      };
    } else if (c.status === "suspended") {
      result = {
        name: topic,
        stale: true as const,
        status: "suspended" as const,
        changedSources: c.changedSources,
        hint: "Memory sources are gone or unmatched: re-check the files it describes, then call memoize_update to refresh this entry.",
        ...(includeStale ? renderEntry(registry, c.entry) : {}),
        ...c.annotations,
      };
    } else {
      result = {
        name: c.entry.name,
        kind: c.entry.kind,
        author: c.entry.author,
        updated: c.entry.updated,
        summary: c.entry.summary,
        stale: false as const,
        status: c.status,
        ...renderEntry(registry, c.entry),
        ...c.annotations,
      };
    }
    break outer;
  }

  if (!sawEntries) return { state: "empty" as const, entries: [] };
  if (result === undefined) {
    // Every group was tried without finding the requested info.
    if (topic) {
      access = { topic, entries: [{ name: topic, status: "missing" }] };
      result = { error: `no entry "${topic}"`, available: availableNames };
    } else {
      access = { entries: [] };
      result = { state: firstState, entries: [] };
    }
  }

  const event: MemoryAccessEvent = { accessor: ctx.accessor ?? "unknown", ...access };
  await notifyObservers(ctx, (p) => p.onMemoryAccessed?.(event));
  return organizeResults(ctx, "recall", result);
}

// ---------- invalidate ----------

export async function invalidateCtx(
  ctx: ServiceContext,
  name: string | undefined,
  confirm: boolean,
) {
  const { registry } = ctx;
  // `invalid` holds entry files that exist on disk but failed to parse. They
  // can never be listed as entries, yet they must stay removable: a corrupt
  // file would otherwise pin the store to "stale" with no way to delete it.
  const { entries, invalid } = await registry.primaryDb.listEntries();
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
  if (
    name &&
    targets.length === 0 &&
    !invalid.includes(name) &&
    !(await registry.primaryDb.readEntry(name))
  ) {
    return { ok: false as const, error: `no entry "${name}"` };
  }

  const removed: string[] = [];
  // Deletes go to the first ledger of the first group only.
  await registry.primaryDb.withLock(async () => {
    if (name) {
      if (await registry.primaryDb.deleteEntry(name)) removed.push(name);
      const manifest = await registry.primaryDb.loadManifest();
      delete manifest.entries[name];
      await registry.primaryDb.saveManifest(manifest);
    } else {
      // Wipe unparseable files too, or a corrupt entry survives the wipe and
      // keeps the store stale.
      for (const n of [...entries.map((e) => e.name), ...invalid]) {
        if (await registry.primaryDb.deleteEntry(n)) removed.push(n);
      }
      await registry.primaryDb.saveManifest({ version: 1, entries: {} });
    }
  });
  return organizeResults(ctx, "invalidate", { ok: true as const, removed });
}

// ---------- root-based entry points (default registry, for tests/tools) ----------

export async function updateEntry(root: string, args: UpdateArgs) {
  const registry = await getRegistry(root);
  return updateEntryCtx({ root, registry }, args);
}

export async function recall(root: string, topic?: string, includeStale = false) {
  const registry = await getRegistry(root);
  return recallCtx({ root, registry }, topic, includeStale);
}

export async function invalidate(root: string, name: string | undefined, confirm: boolean) {
  const registry = await getRegistry(root);
  return invalidateCtx({ root, registry }, name, confirm);
}

export async function statusForRoot(root: string) {
  const registry = await getRegistry(root);
  return statusCtx({ root, registry });
}
