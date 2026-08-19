import { captureBaseline } from "./baseline.js";
import {
  classifyChange,
  compileSources,
  compileTokenMatcher,
  entryReferencesFile,
  findBrokenClaims,
  fingerprint,
  findRename,
} from "./workspace.js";
import { getRegistry } from "./plugins/registry.js";
import type { LedgerPlugin } from "./plugin.js";
import { commitDiff, createWorkspaceSnapshot, type WorkspaceSnapshot } from "./snapshot.js";
import type { EntryBaseline, StaleEntry, StalenessPolicy, StatusResult } from "./types.js";

/** Output arrays are capped so a huge diff can't flood the agent's context. */
const CAP = 50;

export interface StatusContext {
  root: string;
  db: LedgerPlugin;
  staleness: StalenessPolicy;
  ignoreComments: boolean;
}

interface ReBaselinePlan {
  name: string;
  sources: string[];
}

type EntryListing = Awaited<ReturnType<LedgerPlugin["listEntries"]>>;

export interface ComputeStatusOptions {
  listing?: EntryListing;
  snapshot?: WorkspaceSnapshot;
}

function emptyResult(mode: "git" | "hash" | null, invalid: string[] = []): StatusResult {
  return {
    state: "empty",
    mode,
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    cosmeticChanges: [],
    verifiedEntries: [],
    suspendedEntries: [],
    staleEntries: [],
    invalidEntries: invalid,
    truncated: false,
  };
}

function symDiff(a: string[], b: string[]): string[] {
  const sb = new Set(b);
  const sa = new Set(a);
  return [...a.filter((p) => !sb.has(p)), ...b.filter((p) => !sa.has(p))];
}

/** Staleness policies other than "strict" use normalized fingerprints + claim regions. */
function normalized(ctx: StatusContext): boolean {
  return ctx.staleness !== "strict";
}

/**
 * Content-compare matched source files against the baseline (non-git path /
 * git fallback). Cosmetic changes are recorded globally but never stale.
 */
async function contentCompare(
  ctx: StatusContext,
  matched: string[],
  base: EntryBaseline | null,
  changed: Set<string>,
  added: Set<string>,
  deleted: Set<string>,
  cosmetic: Set<string>,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const baseFiles = base?.files ?? {};
  for (const p of matched) {
    if (!(p in baseFiles)) {
      added.add(p);
      continue;
    }
    const c = await classifyChange(ctx.root, p, baseFiles[p], ctx.ignoreComments, snapshot.files);
    if (c === "changed") changed.add(p);
    else if (c === "deleted") deleted.add(p);
    else if (c === "cosmetic") cosmetic.add(p);
  }
  const matchedSet = new Set(matched);
  for (const p of Object.keys(baseFiles)) {
    if (!matchedSet.has(p)) deleted.add(p);
  }
}

export async function computeStatus(
  ctx: StatusContext,
  options: ComputeStatusOptions = {},
): Promise<StatusResult> {
  const { root, db } = ctx;
  const { entries, invalid } = options.listing ?? await db.listEntries();
  if (entries.length === 0) return emptyResult(null, invalid);

  const snapshot = options.snapshot ?? await createWorkspaceSnapshot(root);
  const { mode, git: gitNow, tree } = snapshot;
  const manifest = await db.loadManifest();

  const changed = new Set<string>();
  const added = new Set<string>();
  const deleted = new Set<string>();
  const cosmetic = new Set<string>();
  const stale: StaleEntry[] = [];
  const suspended: string[] = [];
  const reBaseline = new Map<string, ReBaselinePlan>();

  for (const e of entries) {
    if (e.kind === "decision") continue; // only the user can contradict a decision
    const base = manifest.entries[e.name] ?? null;
    const sourceMatcher = compileSources(e.sources);
    const matched = tree.filter(sourceMatcher);
    const entryText = `${e.content}\n${e.summary}`;
    const tokenMatcher = normalized(ctx) ? compileTokenMatcher(entryText) : undefined;
    const ec = new Set<string>();
    const ea = new Set<string>();
    const ed = new Set<string>();

    if (gitNow?.head && base?.git?.head) {
      if (base.git.head !== gitNow.head) {
        // Commits happened since the baseline: precise diff, or hash fallback
        // if the baseline commit was lost to a history rewrite.
        const d = await commitDiff(snapshot, base.git.head);
        if (d) {
          d.changed.forEach((p) => ec.add(p));
          d.added.forEach((p) => ea.add(p));
          d.deleted.forEach((p) => ed.add(p));
        } else {
          await contentCompare(ctx, matched, base, ec, ea, ed, cosmetic, snapshot);
        }
      }
      // Files that became dirty or clean since the baseline.
      symDiff(base.git.dirty, gitNow.dirty).forEach((p) => ec.add(p));
      // Files dirty in both baseline and now may have been edited *again*;
      // git state can't tell them apart, so verify content by hash.
      const dirtyNow = new Set(gitNow.dirty);
      for (const p of base.git.dirty) {
        if (dirtyNow.has(p) && sourceMatcher(p)) {
          const c = await classifyChange(root, p, base.files[p], ctx.ignoreComments, snapshot.files);
          if (c === "changed") ec.add(p);
          else if (c === "deleted") ed.add(p);
        }
      }
    } else {
      await contentCompare(ctx, matched, base, ec, ea, ed, cosmetic, snapshot);
    }

    // Dirty-set changes don't encode whether a path was added or deleted.
    // Resolve relevant paths against the entry baseline so worktree renames
    // follow the same delete+add recovery path as committed renames.
    for (const p of [...ec]) {
      if (!sourceMatcher(p)) continue;
      const current = await fingerprint(root, p, null, snapshot.files);
      if (!current) {
        ec.delete(p);
        ed.add(p);
      } else if (base && !(p in base.files)) {
        ec.delete(p);
        ea.add(p);
      }
    }

    // Claim-scoped triage per hit file.
    const entryStaleSources: string[] = [];
    const entryBrokenClaims: { path: string; line: number; end?: number; kind?: "line" | "block" }[] = [];
    let unrecoveredDelete = false;
    let needsRebaseline = false;
    const renames: { from: string; to: string }[] = [];

    for (const p of hitsOf(ec, ea, ed, sourceMatcher)) {
      if (ea.has(p)) {
        added.add(p);
        // A new file inside the sources glob. Under "strict" this always stales.
        // Under claim-aware policies, an unrelated new file (one the entry's text
        // doesn't reference) only re-baselines coverage — it doesn't break any
        // existing claim. If the entry has no token coverage at all we can't prove
        // the file is unrelated, so surface it to preserve the safety property.
        if (normalized(ctx)) {
          const referenced = await entryReferencesFile(
            root,
            p,
            entryText,
            ctx.ignoreComments,
            snapshot.files,
            tokenMatcher,
          );
          if (referenced) {
            entryStaleSources.push(p);
          } else if (tokenMatcher?.size === 0) {
            // No token coverage to prove the file is unrelated — surface it.
            entryStaleSources.push(p);
          } else {
            // Unrelated new file: refresh coverage without invalidating claims.
            needsRebaseline = true;
          }
        } else {
          entryStaleSources.push(p);
        }
        continue;
      }
      if (ed.has(p)) {
        deleted.add(p);
        if (e.sources.includes(p)) {
          // Explicit-path source vanished: look for a rename (same content elsewhere).
          const to = await findRename(root, p, base?.files[p], tree, snapshot.files);
          if (to) {
            renames.push({ from: p, to });
            added.add(to);
            needsRebaseline = true;
            continue;
          }
        }
        unrecoveredDelete = true;
        entryStaleSources.push(p);
        continue;
      }
      // Changed file: cosmetic → fresh; claim lines intact → re-baseline;
      // claim line broken (or no claims) → stale.
      const classification = await classifyChange(
        root,
        p,
        base?.files[p],
        ctx.ignoreComments,
        snapshot.files,
      );
      if (classification === "unchanged") {
        needsRebaseline = true;
        continue;
      }
      if (classification === "cosmetic") {
        cosmetic.add(p);
        needsRebaseline = true;
        continue;
      }
      changed.add(p);
      const claims = base?.claims?.[p];
      if (claims && claims.length > 0) {
        const broken = await findBrokenClaims(root, p, claims, ctx.ignoreComments, snapshot.files);
        if (broken.length === 0) {
          needsRebaseline = true;
          continue;
        }
        entryStaleSources.push(p);
        for (const b of broken.slice(0, 10)) {
          entryBrokenClaims.push({
            path: p,
            line: b.line,
            end: b.end,
            kind: b.kind,
          });
        }
        continue;
      }
      // No claims for this file (old baseline or degenerate entry): whole-file rule.
      entryStaleSources.push(p);
    }

    if (entryStaleSources.length > 0) {
      const onlyUnrecoveredDeletes =
        unrecoveredDelete && entryStaleSources.every((p) => ed.has(p));
      if (onlyUnrecoveredDeletes) {
        // Sources vanished with no rename and nothing else to re-read:
        // the entry needs attention, not a stale re-read.
        suspended.push(e.name);
      } else {
        stale.push({
          name: e.name,
          changedSources: [...new Set(entryStaleSources)].sort(),
          brokenClaims: entryBrokenClaims.length > 0 ? entryBrokenClaims : undefined,
        });
      }
      // No re-baseline for entries with stale sources, even when other files
      // triggered needsRebaseline or a rename: rebuilding the baseline would
      // fingerprint the broken/vanished content and erase the staleness
      // signal on the next run. The entry stays stale/suspended until the
      // agent re-reads it and calls memoize_update.
    } else if (matched.length === 0 && renames.length === 0) {
      suspended.push(e.name);
    } else if (renames.length > 0) {
      reBaseline.set(e.name, {
        name: e.name,
        sources: e.sources.map((s) => {
          const r = renames.find((r) => r.from === s);
          return r ? r.to : s;
        }),
      });
    } else if (needsRebaseline) {
      reBaseline.set(e.name, { name: e.name, sources: e.sources });
    }
  }

  // Auto re-baseline (Layer 2/3): best-effort; on lock failure entries stay
  // fresh-as-verified but are simply re-checked next run.
  const staleNames = new Set(stale.map((s) => s.name));
  const suspendedNames = new Set(suspended);
  const verified: string[] = [];
  if (reBaseline.size > 0) {
    try {
      const byName = new Map(entries.map((e) => [e.name, e]));
      const prepared = await Promise.all(
        [...reBaseline.values()].map(async (plan) => {
          const entry = byName.get(plan.name);
          if (!entry) return null;
          const { baseline } = await captureBaseline(snapshot, {
            sources: plan.sources,
            content: entry.content,
            summary: entry.summary,
            normalized: normalized(ctx),
            ignoreComments: ctx.ignoreComments,
          });
          return { plan, entry, baseline };
        }),
      );
      await db.withLock(async () => {
        const m = await db.loadManifest();
        for (const item of prepared) {
          if (!item) continue;
          const { plan, entry, baseline } = item;
          if (plan.sources.join("\u0000") !== entry.sources.join("\u0000")) {
            await db.writeEntry({ ...entry, sources: plan.sources });
          }
          m.entries[plan.name] = baseline;
        }
        await db.saveManifest(m);
      });
      for (const name of reBaseline.keys()) {
        // Belt-and-braces: reBaseline is only populated for entries with no
        // stale sources, but never report a stale/suspended entry as verified.
        if (!staleNames.has(name) && !suspendedNames.has(name)) verified.push(name);
      }
    } catch {
      // lock timeout or write failure — verified entries stay reported, not persisted
      for (const name of reBaseline.keys()) {
        if (!staleNames.has(name) && !suspendedNames.has(name)) verified.push(name);
      }
    }
  }

  const sortCap = (s: Set<string>) => [...s].sort().slice(0, CAP);
  const truncated =
    changed.size > CAP || added.size > CAP || deleted.size > CAP || cosmetic.size > CAP;
  return {
    state: stale.length > 0 || invalid.length > 0 || suspended.length > 0 ? "stale" : "fresh",
    mode,
    changedFiles: sortCap(changed),
    addedFiles: sortCap(added),
    deletedFiles: sortCap(deleted),
    cosmeticChanges: sortCap(cosmetic),
    verifiedEntries: verified,
    suspendedEntries: suspended,
    staleEntries: stale,
    invalidEntries: invalid,
    truncated,
  };
}

function hitsOf(
  ec: Set<string>,
  ea: Set<string>,
  ed: Set<string>,
  matches: (path: string) => boolean,
): string[] {
  return [...new Set([...ec, ...ea, ...ed])].filter(matches);
}

/** Status entry point used by tools/tests: default registry for the root. */
export async function computeStatusForRoot(root: string): Promise<StatusResult> {
  const r = await getRegistry(root);
  return computeStatus({ root, db: r.primaryDb, staleness: r.staleness, ignoreComments: r.ignoreComments });
}
