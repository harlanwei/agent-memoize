import {
  diffNameOnly,
  dirtyList,
  head as gitHead,
  isGitRepo,
  isValidCommit,
  trackedFiles,
  type CommitDiff,
} from "./git.js";
import {
  fileChangedSince,
  listEntries,
  loadManifest,
  matchesAny,
  storeExists,
  walkTree,
} from "./store.js";
import type { EntryBaseline, StaleEntry, StatusResult } from "./types.js";

/** Output arrays are capped so a huge diff can't flood the agent's context. */
const CAP = 50;

function emptyResult(mode: "git" | "hash" | null): StatusResult {
  return {
    state: "empty",
    mode,
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    staleEntries: [],
    invalidEntries: [],
    truncated: false,
  };
}

function symDiff(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  const sa = new Set(a);
  return [...a.filter((p) => !sb.has(p)), ...b.filter((p) => !sa.has(p))];
}

/** Content-compare matched source files against the baseline (non-git path / fallback). */
async function hashCompareAll(
  root: string,
  matched: string[],
  base: EntryBaseline | null,
  changed: Set<string>,
  added: Set<string>,
  deleted: Set<string>,
): Promise<void> {
  const baseFiles = base?.files ?? {};
  for (const p of matched) {
    if (!(p in baseFiles)) added.add(p);
    else if (await fileChangedSince(root, p, baseFiles[p])) changed.add(p);
  }
  const matchedSet = new Set(matched);
  for (const p of Object.keys(baseFiles)) {
    if (!matchedSet.has(p)) deleted.add(p);
  }
}

export async function computeStatus(root: string): Promise<StatusResult> {
  if (!(await storeExists(root))) return emptyResult(null);

  const { entries, invalid } = await listEntries(root);
  const repo = await isGitRepo(root);
  const mode = repo ? ("git" as const) : ("hash" as const);
  if (entries.length === 0) {
    const r = emptyResult(mode);
    r.invalidEntries = invalid;
    if (invalid.length > 0) r.state = "stale";
    return r;
  }

  const gitNow = repo ? { head: await gitHead(root), dirty: await dirtyList(root) } : null;
  const tree = repo
    ? [...new Set([...(await trackedFiles(root)), ...gitNow!.dirty])]
    : await walkTree(root);
  const manifest = await loadManifest(root);

  // name-status diffs are identical for entries sharing a baseline head — cache them.
  const diffCache = new Map<string, CommitDiff | null>();
  const cachedDiff = async (oldHead: string, newHead: string): Promise<CommitDiff | null> => {
    if (!diffCache.has(oldHead)) {
      diffCache.set(
        oldHead,
        (await isValidCommit(root, oldHead)) ? await diffNameOnly(root, oldHead, newHead) : null,
      );
    }
    return diffCache.get(oldHead)!;
  };

  const changed = new Set<string>();
  const added = new Set<string>();
  const deleted = new Set<string>();
  const stale: StaleEntry[] = [];

  for (const e of entries) {
    if (e.kind === "decision") continue; // only the user can contradict a decision
    const base = manifest.entries[e.name] ?? null;
    const matched = tree.filter((p) => matchesAny(e.sources, p));
    const ec = new Set<string>();
    const ea = new Set<string>();
    const ed = new Set<string>();

    if (gitNow?.head && base?.git?.head) {
      if (base.git.head !== gitNow.head) {
        // Commits happened since the baseline: precise diff, or hash fallback
        // if the baseline commit was lost to a history rewrite.
        const d = await cachedDiff(base.git.head, gitNow.head);
        if (d) {
          d.changed.forEach((p) => ec.add(p));
          d.added.forEach((p) => ea.add(p));
          d.deleted.forEach((p) => ed.add(p));
        } else {
          await hashCompareAll(root, matched, base, ec, ea, ed);
        }
      }
      // Files that became dirty or clean since the baseline.
      symDiff(base.git.dirty, gitNow.dirty).forEach((p) => ec.add(p));
      // Files dirty in both baseline and now may have been edited *again*;
      // git state can't tell them apart, so verify content by hash.
      const dirtyNow = new Set(gitNow.dirty);
      for (const p of base.git.dirty) {
        if (dirtyNow.has(p) && matchesAny(e.sources, p)) {
          if (await fileChangedSince(root, p, base.files[p])) ec.add(p);
        }
      }
    } else {
      await hashCompareAll(root, matched, base, ec, ea, ed);
    }

    const hits = [...ec, ...ea, ...ed].filter((p) => matchesAny(e.sources, p));
    if (hits.length > 0 || matched.length === 0) {
      stale.push({ name: e.name, changedSources: hits.sort() });
      for (const p of hits) {
        if (ea.has(p)) added.add(p);
        else if (ed.has(p)) deleted.add(p);
        else changed.add(p);
      }
    }
  }

  const sortCap = (s: Set<string>) => [...s].sort().slice(0, CAP);
  const truncated = changed.size > CAP || added.size > CAP || deleted.size > CAP;
  return {
    state: stale.length > 0 || invalid.length > 0 ? "stale" : "fresh",
    mode,
    changedFiles: sortCap(changed),
    addedFiles: sortCap(added),
    deletedFiles: sortCap(deleted),
    staleEntries: stale,
    invalidEntries: invalid,
    truncated,
  };
}
