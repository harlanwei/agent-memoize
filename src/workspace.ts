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
 * With ignoreComments, full-line comments are dropped per file extension
 * (line comments //, #, --, ; and block comments).
 */
export function normalizeContent(text: string, opts: { ignoreComments: boolean; ext: string }): string {
  const out: string[] = [];
  const spec = opts.ignoreComments ? COMMENT_SPECS[opts.ext] : undefined;
  const blockState = { inBlock: false };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (spec && isCommentLine(line, spec, blockState)) continue;
    if (line.trim() !== "") out.push(line);
  }
  return out.join("\n");
}

interface CommentSpec {
  line?: string[];
  block?: [string, string];
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

function isCommentLine(line: string, spec: CommentSpec, state: { inBlock: boolean }): boolean {
  const t = line.trim();
  if (spec.block) {
    const [startSym, endSym] = spec.block;
    if (state.inBlock) {
      if (endSym && t.includes(endSym)) state.inBlock = false;
      return true;
    }
    if (t.includes(startSym)) {
      if (!t.slice(t.indexOf(startSym)).includes(endSym)) state.inBlock = true;
      return true;
    }
  }
  if (spec.line?.some((m) => t.startsWith(m))) return true;
  return false;
}

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
  "files", "markdown", "module", "modules", "type", "kind", "name", "text", "body", "line",
  "lines", "code", "docs", "documentation", "describe", "describes", "contains", "provides", "uses",
  "returns", "takes", "user", "users", "agent", "agents", "handled", "handles", "handling",
]);

/** Significant tokens from entry text: identifiers and path-like tokens, minus stopwords. */
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const re of [IDENT_RE, PATH_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const t = m[0];
      if (t.length < 4) continue;
      if (STOPWORDS.has(t.toLowerCase())) continue;
      tokens.add(t);
    }
  }
  return tokens;
}

export function lineHash(line: string): string {
  return createHash("sha256").update(line.replace(/\s+$/, "")).digest("hex");
}

/**
 * Lines of rel that reference tokens from the entry text — the claim regions.
 * Empty when no token appears in the file (caller falls back to whole-file checks).
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
  const out: ClaimRegion[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    const line = lines[i];
    for (const t of tokens) {
      if (line.includes(t)) {
        out.push({ line: i + 1, hash: lineHash(line) });
        break;
      }
    }
  }
  return out;
}

/** True when every claim line still exists somewhere in the file.
 * Position-independent: an edit that inserts or removes lines elsewhere
 * shifts line numbers but not content, so a claim is broken only when the
 * referenced line text is actually gone (or its whitespace changed). */
export async function claimsIntact(
  root: string,
  rel: string,
  claims: ClaimRegion[],
): Promise<boolean> {
  let content;
  try {
    content = await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return false;
  }
  const present = new Map<string, number>();
  for (const line of content.split("\n")) {
    const h = lineHash(line);
    present.set(h, (present.get(h) ?? 0) + 1);
  }
  for (const c of claims) {
    if (!present.has(c.hash)) return false;
  }
  return true;
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
