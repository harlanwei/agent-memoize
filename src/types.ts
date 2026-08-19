export type EntryKind = "file" | "decision";

/** How aggressively file changes invalidate entries (config knob, default "selective"). */
export type StalenessPolicy = "strict" | "selective";

/** Per-entry freshness grade surfaced in status/recall. */
export type EntryStatus = "fresh" | "verified" | "stale" | "suspended";

export interface EntryMeta {
  /** Entry name, e.g. "modules/auth". Maps to `<name>.md` inside the store. */
  name: string;
  /** "file" = derived from project files (invalidated by changes); "decision" = from conversation. */
  kind: EntryKind;
  /** Project-root-relative paths/globs the entry is derived from. Empty for decisions. */
  sources: string[];
  /** MCP client that wrote the entry (clientInfo.name), or "unknown". */
  author: string;
  /** ISO timestamp of last update. */
  updated: string;
  /** One-line summary for the recall index. */
  summary: string;
}

export interface Entry extends EntryMeta {
  /** Markdown body. */
  content: string;
}

export interface FileFingerprint {
  sha256: string;
  mtimeMs: number;
  size: number;
  /** sha256 of the whitespace-normalized content, when hashMode is "normalized". */
  norm?: string;
}

/**
 * A region in a source file that the entry's text references. Staleness for
 * the "selective" (non-strict) policy is judged on these regions only.
 *
 * A region is normally a single line, but may span a balanced block (function,
 * object, etc.) opened at `line` and closing at `end` — such a claim survives
 * as long as the block's content still exists somewhere in the file, even if
 * reformatted or reordered.
 */
export interface ClaimRegion {
  /** 1-based line number where the claim starts. */
  line: number;
  /** 1-based inclusive end line for block claims; omitted for single-line claims. */
  end?: number;
  /** "block" spans a balanced block from line..end; "line" (default) is a single line. */
  kind?: "line" | "block";
  /** sha256 of the normalized region content. */
  hash: string;
  /**
   * 1 = legacy (trailing-whitespace strip only); 2 = syntax-insensitive
   * normalization; 3 = normalization that preserves semantic whitespace.
   */
  hashVersion?: 1 | 2 | 3;
}

/**
 * Per-entry baseline captured at update time. Staleness is judged per entry
 * (baseline vs. current workspace state), so entries updated at different
 * times coexist correctly and updating one entry never un-stales another.
 */
export interface EntryBaseline {
  /** Git state at update time, or null when the project is not a git repo. */
  git: { head: string | null; dirty: string[] } | null;
  /** Fingerprints of files matched by the entry's sources at update time. */
  files: Record<string, FileFingerprint>;
  /** "normalized" when the staleness policy captured normalized hashes. */
  hashMode?: "raw" | "normalized";
  /** Claim regions per source file, when the entry was captured under a non-strict policy. */
  claims?: Record<string, ClaimRegion[]>;
}

export interface Manifest {
  version: 1;
  entries: Record<string, EntryBaseline>;
}

export interface StaleEntry {
  name: string;
  /** Changed/added/deleted paths that intersect the entry's sources. */
  changedSources: string[];
  /** Claim regions whose hashes no longer match the current file content (capped). */
  brokenClaims?: { path: string; line: number; end?: number; kind?: "line" | "block" }[];
}

export interface StatusResult {
  state: "empty" | "fresh" | "stale";
  mode: "git" | "hash" | null;
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  /** Files that changed but only cosmetically (whitespace/comments) — entries stay fresh. */
  cosmeticChanges: string[];
  /** Entries auto re-baselined this run: their claim lines were intact. */
  verifiedEntries: string[];
  /** Entries whose sources are gone/unmatched and no rename was found. */
  suspendedEntries: string[];
  staleEntries: StaleEntry[];
  /** Entry files that failed to parse. */
  invalidEntries: string[];
  /** True when a file-change output array was capped. */
  truncated: boolean;
}
