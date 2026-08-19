import { claimLines, compileSources, compileTokenMatcher } from "./workspace.js";
import type { WorkspaceSnapshot } from "./snapshot.js";
import type { ClaimRegion, EntryBaseline, FileFingerprint } from "./types.js";

export interface BaselineInput {
  sources: string[];
  content: string;
  summary: string;
  normalized: boolean;
  ignoreComments: boolean;
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit = 16,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

/** Shared update/re-baseline capture; each source is read at most once per operation. */
export async function captureBaseline(
  snapshot: WorkspaceSnapshot,
  input: BaselineInput,
): Promise<{ baseline: EntryBaseline; matched: string[] }> {
  const matched = snapshot.tree.filter(compileSources(input.sources));
  const norm = input.normalized ? { ignoreComments: input.ignoreComments } : null;
  const text = `${input.content}\n${input.summary}`;
  const tokenMatcher = input.normalized ? compileTokenMatcher(text) : undefined;
  const files: Record<string, FileFingerprint> = {};
  const claims: Record<string, ClaimRegion[]> = {};

  const captured = await mapConcurrent(
    matched,
    async (rel) => {
      const fingerprint = await snapshot.files.fingerprint(rel, norm);
      if (!fingerprint) return null;
      const regions = tokenMatcher
        ? await claimLines(
            snapshot.root,
            rel,
            text,
            50,
            input.ignoreComments,
            snapshot.files,
            tokenMatcher,
          )
        : undefined;
      return { rel, fingerprint, regions };
    },
  );
  for (const item of captured) {
    if (!item) continue;
    files[item.rel] = item.fingerprint;
    if (item.regions) claims[item.rel] = item.regions;
  }

  return {
    matched,
    baseline: {
      git: snapshot.git,
      files,
      hashMode: input.normalized ? "normalized" : "raw",
      claims: input.normalized ? claims : undefined,
    },
  };
}
