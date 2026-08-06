import { promises as fs } from "node:fs";
import { dirtyList, head as gitHead, isGitRepo, trackedFiles } from "./git.js";
import { computeStatus } from "./status.js";
import {
  deleteEntry,
  emptyManifest,
  entryFilePath,
  fingerprint,
  isValidName,
  listEntries,
  loadManifest,
  matchesAny,
  readEntry,
  saveManifest,
  storePath,
  walkTree,
  withLock,
  writeEntry,
} from "./store.js";
import type { Entry, EntryKind, FileFingerprint } from "./types.js";

export interface UpdateArgs {
  name: string;
  content: string;
  kind: EntryKind;
  sources?: string[];
  summary?: string;
  author: string;
}

function firstLine(content: string): string {
  return content
    .trim()
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .slice(0, 120);
}

export async function updateEntry(root: string, args: UpdateArgs) {
  const { name, kind, author } = args;
  const content = args.content ?? "";
  if (!isValidName(name)) {
    throw new Error(`invalid entry name "${name}": use lowercase segments like "modules/auth"`);
  }
  if (!content.trim()) throw new Error("content must not be empty");
  if (kind === "file" && (!args.sources || args.sources.length === 0)) {
    throw new Error('sources (project-relative paths/globs) are required for kind="file"');
  }
  if (kind === "decision" && args.sources?.length) {
    throw new Error('kind="decision" entries take no sources');
  }

  const repo = await isGitRepo(root);
  // Capture state BEFORE writing, so the store's own files can never affect the baseline.
  const gitNow = repo ? { head: await gitHead(root), dirty: await dirtyList(root) } : null;
  const tree = repo
    ? [...new Set([...(await trackedFiles(root)), ...gitNow!.dirty])]
    : await walkTree(root);
  const sources = kind === "file" ? args.sources! : [];
  const matched = tree.filter((p) => matchesAny(sources, p));

  const entry: Entry = {
    name,
    kind,
    sources,
    author,
    updated: new Date().toISOString(),
    summary: args.summary?.trim() || firstLine(content),
    content,
  };

  await fs.mkdir(storePath(root), { recursive: true });
  await withLock(root, async () => {
    await writeEntry(root, entry);
    const files: Record<string, FileFingerprint> = {};
    for (const p of matched) {
      try {
        files[p] = await fingerprint(root, p);
      } catch {
        // vanished between listing and hashing — skip it
      }
    }
    const manifest = await loadManifest(root);
    manifest.entries[name] = { git: gitNow, files };
    // Drop baselines whose entry files disappeared (manual deletion, failed wipe).
    const { entries } = await listEntries(root);
    const onDisk = new Set(entries.map((e) => e.name));
    for (const key of Object.keys(manifest.entries)) {
      if (!onDisk.has(key)) delete manifest.entries[key];
    }
    await saveManifest(root, manifest);
  });

  return {
    ok: true as const,
    name,
    matchedFiles: matched.length,
    ...(kind === "file" && matched.length === 0
      ? { warning: "sources matched no files; entry will report stale until sources match" }
      : {}),
  };
}

export async function recall(root: string, topic?: string) {
  const status = await computeStatus(root);
  if (status.state === "empty") return { state: "empty" as const, entries: [] };

  const { entries } = await listEntries(root);
  const staleMap = new Map(status.staleEntries.map((s) => [s.name, s.changedSources]));

  if (!topic) {
    return {
      state: status.state,
      entries: entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        summary: e.summary,
        author: e.author,
        updated: e.updated,
        stale: staleMap.has(e.name),
      })),
    };
  }

  const entry = entries.find((e) => e.name === topic);
  if (!entry) {
    return { error: `no entry "${topic}"`, available: entries.map((e) => e.name) };
  }
  const changedSources = staleMap.get(topic);
  if (changedSources) {
    return {
      name: topic,
      stale: true as const,
      changedSources,
      hint: "Memory is stale: re-read the changed source files, then call memoize_update to refresh this entry.",
    };
  }
  return {
    name: entry.name,
    kind: entry.kind,
    author: entry.author,
    updated: entry.updated,
    summary: entry.summary,
    stale: false as const,
    content: entry.content,
  };
}

export async function invalidate(root: string, name: string | undefined, confirm: boolean) {
  const { entries } = await listEntries(root);
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
  if (name && targets.length === 0 && !(await readEntry(root, name))) {
    return { ok: false as const, error: `no entry "${name}"` };
  }

  const removed: string[] = [];
  await withLock(root, async () => {
    if (name) {
      if (await deleteEntry(root, name)) removed.push(name);
      const manifest = await loadManifest(root);
      delete manifest.entries[name];
      await saveManifest(root, manifest);
    } else {
      for (const e of entries) {
        if (await deleteEntry(root, e.name)) removed.push(e.name);
      }
      await saveManifest(root, emptyManifest());
    }
  });
  return { ok: true as const, removed };
}

/** Exposed for tests/tools that need the resolved store location. */
export { entryFilePath, storePath };
