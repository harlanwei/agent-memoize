import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { ClaimRegion, FileFingerprint } from "./types.js";

export const STORE_DIR = ".agent-memoize";

export function storePath(root: string): string {
  return path.join(root, STORE_DIR);
}

const NAME_RE = /^[a-z0-9][a-z0-9/_-]*$/;

/** Entry names: lowercase segments, no dots — also makes traversal impossible. */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.split("/").includes("..");
}

// ---------- trees & globs ----------

const SKIP_DIRS = new Set([".git", "node_modules", STORE_DIR]);

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
        await walk(path.join(dir, d.name), base ? base + "/" + d.name : d.name);
      } else if (d.isFile()) {
        out.push(base ? base + "/" + d.name : d.name);
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

// ---------- normalized content (Layer 1: cosmetic noise immunity) ----------

/**
 * Whitespace-normalized copy: trailing whitespace stripped, blank lines dropped.
 * With ignoreComments, comments are stripped per file extension (line comments
 * //, #, --, ; and block comments). Code around a block marker is preserved —
 * a semantic edit there must change the normalized hash, never count as
 * cosmetic.
 */
export function normalizeContent(text: string, opts: { ignoreComments: boolean; ext: string }): string {
  const out: string[] = [];
  const spec = opts.ignoreComments ? COMMENT_SPECS[opts.ext] : undefined;
  const blockState = { inBlock: false };
  for (const raw of text.split("\n")) {
    const line = (spec ? stripComments(raw, spec, blockState) : raw).replace(/\s+$/, "");
    if (line.trim() !== "") out.push(line);
  }
  return out.join("\n");
}

interface CommentSpec {
  line?: string[];
  block?: [string, string];
}

/**
 * Remove comments from a single line for normalized hashing, honoring string
 * literals and a block-comment state carried across lines. Code before an
 * opening block marker and after a closing one is kept; lines inside a
 * multi-line block contribute nothing. A line comment is dropped only when it
 * starts the trimmed line — a trailing comment stays in the hash, keeping the
 * conservative behavior this layer always had.
 */
function stripComments(line: string, spec: CommentSpec, state: { inBlock: boolean }): string {
  const block = spec.block;
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      out += ch;
      if (ch === inStr && line[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      out += ch;
      continue;
    }
    if (block) {
      if (state.inBlock) {
        const closeAt = line.indexOf(block[1], i);
        if (closeAt < 0) return out; // rest of the line is inside the block
        state.inBlock = false;
        i = closeAt + block[1].length - 1;
        continue;
      }
      if (line.startsWith(block[0], i)) {
        const closeAt = line.indexOf(block[1], i + block[0].length);
        if (closeAt < 0) {
          state.inBlock = true; // block continues on later lines
          return out;
        }
        i = closeAt + block[1].length - 1;
        continue;
      }
    }
    if (spec.line?.some((m) => line.startsWith(m, i))) {
      return out.trim() === "" ? "" : out + line.slice(i);
    }
    out += ch;
  }
  return out;
}

const COMMENT_SPECS: Record<string, CommentSpec> = {
  ".ts": { line: ["//"], block: ["/*", "*/"] },
  ".tsx": { line: ["//"], block: ["/*", "*/"] },
  ".mts": { line: ["//"], block: ["/*", "*/"] },
  ".cts": { line: ["//"], block: ["/*", "*/"] },
  ".js": { line: ["//"], block: ["/*", "*/"] },
  ".jsx": { line: ["//"], block: ["/*", "*/"] },
  ".mjs": { line: ["//"], block: ["/*", "*/"] },
  ".cjs": { line: ["//"], block: ["/*", "*/"] },
  ".java": { line: ["//"], block: ["/*", "*/"] },
  ".c": { line: ["//"], block: ["/*", "*/"] },
  ".h": { line: ["//"], block: ["/*", "*/"] },
  ".cpp": { line: ["//"], block: ["/*", "*/"] },
  ".hpp": { line: ["//"], block: ["/*", "*/"] },
  ".cc": { line: ["//"], block: ["/*", "*/"] },
  ".cs": { line: ["//"], block: ["/*", "*/"] },
  ".go": { line: ["//"], block: ["/*", "*/"] },
  ".rs": { line: ["//"], block: ["/*", "*/"] },
  ".swift": { line: ["//"], block: ["/*", "*/"] },
  ".kt": { line: ["//"], block: ["/*", "*/"] },
  ".php": { line: ["//", "#"], block: ["/*", "*/"] },
  ".py": { line: ["#"] },
  ".rb": { line: ["#"] },
  ".sh": { line: ["#"] },
  ".bash": { line: ["#"] },
  ".zsh": { line: ["#"] },
  ".yml": { line: ["#"] },
  ".yaml": { line: ["#"] },
  ".toml": { line: ["#"] },
  ".ini": { line: [";", "#"] },
  ".cfg": { line: [";", "#"] },
  ".sql": { line: ["--"], block: ["/*", "*/"] },
  ".lua": { line: ["--"] },
  ".css": { block: ["/*", "*/"] },
  ".scss": { line: ["//"], block: ["/*", "*/"] },
  ".less": { block: ["/*", "*/"] },
  ".html": { block: ["<!--", "-->"] },
  ".xml": { block: ["<!--", "-->"] },
  ".md": { block: ["<!--", "-->"] },
};

// ---------- fingerprints ----------

export interface NormalizeOpts {
  ignoreComments: boolean;
}

/** Read-only helpers shared by status/update. */
export type ChangeClass = "unchanged" | "cosmetic" | "changed" | "deleted";

export async function fingerprint(
  root: string,
  rel: string,
  norm: NormalizeOpts | null,
): Promise<FileFingerprint | null> {
  const fp = path.join(root, rel);
  let st;
  try {
    st = await fs.stat(fp);
  } catch {
    return null;
  }
  const raw = await fs.readFile(fp);
  const f: FileFingerprint = {
    sha256: createHash("sha256").update(raw).digest("hex"),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
  if (norm) {
    f.norm = createHash("sha256")
      .update(normalizeContent(raw.toString("utf8"), { ignoreComments: norm.ignoreComments, ext: path.extname(rel) }))
      .digest("hex");
  }
  return f;
}

/**
 * Classify a file against its baseline fingerprint. mtime+size are checked
 * first; sha256 only on mismatch; the normalized hash only when both differ,
 * so verification stays cheap and never touches the agent context.
 */
export async function classifyChange(
  root: string,
  rel: string,
  fp: FileFingerprint | undefined,
  ignoreComments: boolean,
): Promise<ChangeClass> {
  if (!fp) return "changed";
  let st;
  try {
    st = await fs.stat(path.join(root, rel));
  } catch {
    return "deleted";
  }
  if (st.mtimeMs === fp.mtimeMs && st.size === fp.size) return "unchanged";
  const raw = await fs.readFile(path.join(root, rel));
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha === fp.sha256) return "unchanged";
  if (fp.norm) {
    const norm = createHash("sha256")
      .update(normalizeContent(raw.toString("utf8"), { ignoreComments, ext: path.extname(rel) }))
      .digest("hex");
    if (norm === fp.norm) return "cosmetic";
  }
  return "changed";
}

// ---------- claim regions (Layer 2: claim-scoped staleness) ----------

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g;
const PATH_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}(?=[\s.,;:)])/g;
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "also", "because", "been", "before", "being",
  "between", "both", "could", "each", "every", "first", "from", "further", "have", "here", "into",
  "last", "more", "most", "never", "other", "over", "same", "second", "should", "some", "such",
  "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through",
  "under", "until", "using", "very", "when", "where", "which", "while", "with", "would", "your",
  "entry", "entries", "memory", "memories", "note", "notes", "source", "sources", "content",
  "summary", "author", "updated", "stale", "fresh", "decision", "decisions", "project", "file",
  "files", "markdown", "modules", "text", "body",
  "lines", "docs", "documentation", "describe", "describes", "contains", "provides",
  "takes", "users", "agents", "handled", "handles", "handling",
]);

/**
 * Significant tokens from entry text: identifiers and path-like tokens, minus stopwords.
 * Identifiers ≥3 chars are accepted (was 4) so entries about short-named symbols still
 * get claim coverage; path-like tokens still require ≥4 chars. Common code/symbol words
 * that were previously stripped (type, name, value, kind, mode, key, data, item, module,
 * code, line, returns, uses, user, agent) are now kept, since they are frequently real
 * identifiers referenced by the entry.
 */
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  IDENT_RE.lastIndex = 0;
  for (const m of text.matchAll(IDENT_RE)) {
    const t = m[0];
    if (t.length < 3) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
    tokens.add(t);
  }
  PATH_RE.lastIndex = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const t = m[0];
    if (t.length < 4) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
    tokens.add(t);
  }
  return tokens;
}

/** Escape a string for literal inclusion in a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single word-boundary RegExp that matches any of the given identifier tokens.
 * Path-like tokens (containing "/" or ".") are returned separately for substring matching,
 * since they are not word-shaped.
 */
function buildTokenMatcher(tokens: Iterable<string>): { wordRe: RegExp | null; paths: string[] } {
  const idents: string[] = [];
  const paths: string[] = [];
  for (const t of tokens) {
    if (t.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(t)) paths.push(t);
    else idents.push(t);
  }
  const wordRe = idents.length
    ? new RegExp(`(?:^|[^\\w])(${idents.map(reEscape).join("|")})(?:$|[^\\w])`)
    : null;
  return { wordRe, paths };
}

/**
 * True if any token from `text` is referenced by the file `rel`'s content.
 * Identifier tokens match on word boundaries (so "auth" ≠ "authority");
 * path-like tokens match by substring. Used to decide whether a newly-added
 * file is plausibly relevant to an entry.
 */
export async function entryReferencesFile(
  root: string,
  rel: string,
  text: string,
): Promise<boolean> {
  const tokens = extractTokens(text);
  if (tokens.size === 0) return false;
  let content;
  try {
    content = await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return false;
  }
  const { wordRe, paths } = buildTokenMatcher(tokens);
  if (paths.some((p) => content.includes(p))) return true;
  return wordRe ? wordRe.test(content) : false;
}

/**
 * Strip a trailing inline comment from a line (e.g. `code // comment` → `code`),
 * honoring string literals so a `//` inside quotes isn't treated as a comment.
 * Only line-comment markers from the file's COMMENT_SPECS entry are considered.
 */
function stripInlineComment(line: string, spec: CommentSpec | undefined): string {
  if (!spec?.line) return line;
  const markers = spec.line;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === inStr && line[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    for (const m of markers) {
      if (line.startsWith(m, i)) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Normalize a single line for stable hashing: collapse internal whitespace
 * runs to one space, strip trailing whitespace, drop trailing inline comments
 * (per file extension), and strip a single trailing incidental semicolon.
 * Whitespace/comment/semicolon-only edits no longer break a claim line.
 */
export function normalizeLine(line: string, ext?: string): string {
  const spec = ext ? COMMENT_SPECS[ext] : undefined;
  let l = line.replace(/\s+/g, " ").trim();
  if (spec) l = stripInlineComment(l, spec).trim();
  // A trailing semicolon is incidental for most languages; stripping it keeps
  // `x` and `x;` hash-equal. Only one is stripped to avoid mangling `;;`-style syntax.
  if (l.endsWith(";")) l = l.slice(0, -1).trimEnd();
  return l;
}

/** Hash a normalized line (hashVersion 2). */
export function lineHash(line: string, ext?: string): string {
  return createHash("sha256").update(normalizeLine(line, ext)).digest("hex");
}

/** Legacy single-line hash (hashVersion 1): trailing whitespace stripped only. */
function legacyLineHash(line: string): string {
  return createHash("sha256").update(line.replace(/\s+$/, "")).digest("hex");
}

/** Hash a normalized multi-line block (lines joined with "\n") for hashVersion 2. */
function blockHash(lines: string[], ext?: string): string {
  return createHash("sha256")
    .update(lines.map((l) => normalizeLine(l, ext)).join("\n"))
    .digest("hex");
}

/**
 * Find the closing line index (0-based) of a brace-delimited block whose
 * opening `{` is on `startIdx` itself, honoring string/comment context so
 * braces inside literals or comments don't affect nesting. Returns -1 when
 * `startIdx` doesn't open a block (no unmatched `{` on that line) or the
 * block is unbalanced.
 */
function findBlockEnd(lines: string[], startIdx: number, ext?: string): number {
  const spec = ext ? COMMENT_SPECS[ext] : undefined;
  const blockPair = spec?.block;
  const lineMarkers = spec?.line ?? [];

  // Context-aware scan of a single line: returns the net brace delta and
  // whether the line opened a string/block comment that continues past its end.
  const scanLine = (
    line: string,
    ctx: { inStr: string | null; inBlock: boolean },
  ): { delta: number; lastOpenIdx: number } => {
    let delta = 0;
    let lastOpenIdx = -1;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const rest = line.slice(j);
      if (ctx.inStr) {
        if (ch === ctx.inStr && line[j - 1] !== "\\") ctx.inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        ctx.inStr = ch;
        continue;
      }
      if (blockPair) {
        if (rest.startsWith(blockPair[0])) {
          const closeInRest = rest.slice(blockPair[0].length).indexOf(blockPair[1]);
          if (closeInRest < 0) {
            ctx.inBlock = true;
            break;
          }
          j += blockPair[0].length + closeInRest + blockPair[1].length - 1;
          continue;
        }
        if (ctx.inBlock && rest.includes(blockPair[1])) {
          ctx.inBlock = false;
        }
      }
      if (ctx.inBlock) continue;
      if (lineMarkers.some((m) => rest.startsWith(m))) break;
      if (ch === "{") {
        delta++;
        lastOpenIdx = j;
      } else if (ch === "}") {
        delta--;
      }
    }
    return { delta, lastOpenIdx };
  };

  // The opening line must itself contain an unmatched `{`.
  const ctx = { inStr: null as string | null, inBlock: false };
  const first = scanLine(lines[startIdx], ctx);
  if (first.delta <= 0) return -1; // no unmatched open brace on the start line

  let depth = first.delta;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const { delta } = scanLine(lines[i], ctx);
    depth += delta;
    if (depth <= 0) return i;
  }
  return -1; // unbalanced
}

/**
 * Regions of `rel` that reference tokens from the entry text — the claim regions.
 * A token-hit line that opens a balanced `{ }` block becomes a block claim
 * spanning the block; otherwise a single-line claim. A block claim stays intact
 * as long as its exact normalized content still appears as a contiguous run
 * somewhere in the file (it may have moved). Empty when no token appears in the
 * file (caller falls back to whole-file checks). All hashes are hashVersion 2.
 */
export async function claimLines(
  root: string,
  rel: string,
  text: string,
  cap = 50,
): Promise<ClaimRegion[]> {
  const tokens = extractTokens(text);
  if (tokens.size === 0) return [];
  let content;
  try {
    content = await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return [];
  }
  const ext = path.extname(rel);
  const lines = content.split("\n");
  const { wordRe, paths } = buildTokenMatcher(tokens);
  const lineMatches = (line: string): boolean => {
    if (paths.some((p) => line.includes(p))) return true;
    return wordRe ? wordRe.test(line) : false;
  };
  const out: ClaimRegion[] = [];
  const claimedLines = new Set<number>();
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    if (!lineMatches(lines[i])) continue;
    const endIdx = findBlockEnd(lines, i, ext);
    if (endIdx > i) {
      const blockLines = lines.slice(i, endIdx + 1);
      for (let k = i; k <= endIdx; k++) claimedLines.add(k);
      out.push({
        line: i + 1,
        end: endIdx + 1,
        kind: "block",
        hash: blockHash(blockLines, ext),
        hashVersion: 2,
      });
    } else {
      out.push({ line: i + 1, hash: lineHash(lines[i], ext), hashVersion: 2 });
    }
  }
  return out;
}

/**
 * Multiset of every line hash (both legacy v1 and normalized v2) for the
 * current file content, so a stored claim hash matches regardless of which
 * hashVersion it was captured under.
 */
function currentLineHashes(lines: string[], ext?: string): Map<string, number> {
  const present = new Map<string, number>();
  for (const line of lines) {
    // Compute both; cost is negligible relative to the file read.
    const inc = (h: string) => present.set(h, (present.get(h) ?? 0) + 1);
    inc(legacyLineHash(line));
    inc(lineHash(line, ext));
  }
  return present;
}

/**
 * Claim regions whose hashes are no longer present in the current file content.
 * Single-line claims match on their stored hash (both v1 legacy and v2
 * normalized hashes are precomputed for the current file). Block claims are
 * position-independent: their composite hash must reproduce from some
 * contiguous run of lines anywhere in the file (see blockHashExists).
 */
export async function findBrokenClaims(
  root: string,
  rel: string,
  claims: ClaimRegion[],
): Promise<ClaimRegion[]> {
  if (claims.length === 0) return [];
  let content;
  try {
    content = await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return claims; // file gone → every claim is broken
  }
  const ext = path.extname(rel);
  const lines = content.split("\n");
  const present = currentLineHashes(lines, ext);
  const broken: ClaimRegion[] = [];
  for (const c of claims) {
    if (c.kind === "block" && c.end && c.hashVersion === 2) {
      // Block claims are verified position-independently by content (see blockHashExists).
      if (blockHashExists(lines, c, ext)) continue;
      broken.push(c);
    } else {
      if (!present.has(c.hash)) broken.push(c);
    }
  }
  return broken;
}

/**
 * A block claim is intact when its stored composite hash can be reproduced from
 * some contiguous run of lines (of the original span length) anywhere in the
 * current file. This makes the check position-independent — the block may have
 * moved — while still requiring the block's exact normalized content (as a
 * unit) to be present. Reordering lines within the block is treated as a change.
 */
function blockHashExists(lines: string[], c: ClaimRegion, ext?: string): boolean {
  const span = c.end! - c.line + 1;
  for (let i = 0; i + span <= lines.length; i++) {
    if (blockHash(lines.slice(i, i + span), ext) === c.hash) return true;
  }
  return false;
}

/** True when every claim region still exists somewhere in the file. */
export async function claimsIntact(
  root: string,
  rel: string,
  claims: ClaimRegion[],
): Promise<boolean> {
  return (await findBrokenClaims(root, rel, claims)).length === 0;
}

// ---------- rename recovery (Layer 3) ----------

/**
 * Find a same-content file elsewhere in the tree (a rename of a vanished
 * source). Cheap: only files with the same size as the baseline are hashed.
 */
export async function findRename(
  root: string,
  from: string,
  fp: FileFingerprint | undefined,
  tree: string[],
): Promise<string | null> {
  if (!fp) return null;
  for (const rel of tree) {
    if (rel === from) continue;
    let st;
    try {
      st = await fs.stat(path.join(root, rel));
    } catch {
      continue;
    }
    if (st.size !== fp.size) continue;
    const raw = await fs.readFile(path.join(root, rel));
    if (createHash("sha256").update(raw).digest("hex") === fp.sha256) return rel;
  }
  return null;
}
