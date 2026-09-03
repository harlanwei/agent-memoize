import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Store-internal paths are excluded from all git signals: writes to the store
 *  itself must never look like project changes. */
const STORE_PREFIX = ".agent-memoize/";

export function isStorePath(rel: string): boolean {
  return rel === ".agent-memoize" || rel.startsWith(STORE_PREFIX);
}

/**
 * Path quoting is always disabled: git escapes non-ASCII and special
 * characters by default, and a quoted path never matches the tree, which would
 * silently hide changes to those files from staleness detection.
 */
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Current HEAD sha, or null on an unborn branch (no commits yet). */
export async function head(root: string): Promise<string | null> {
  try {
    return (await git(root, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

/** True if `sha` still resolves to a commit (false after history rewrites). */
export async function isValidCommit(root: string, sha: string): Promise<boolean> {
  try {
    await git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Paths with worktree changes vs. HEAD, including untracked files. Store paths excluded. */
export async function dirtyList(root: string): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parsePorcelain(out).filter((p) => !isStorePath(p));
}

export function parsePorcelain(out: string): string[] {
  if (out.includes("\0")) {
    const records = out.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const code = record.slice(0, 2);
      const current = record.slice(3);
      if (current) paths.push(current);
      // In -z format a rename/copy record is followed by its original path.
      if (code.includes("R") || code.includes("C")) {
        const original = records[++i];
        if (original) paths.push(original);
      }
    }
    return paths;
  }

  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // Format: "XY <path>" or "XY <orig> -> <new>" for renames.
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    const add = (value: string) => {
      let clean = value;
      if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
      if (clean) paths.push(clean);
    };
    if (arrow >= 0) {
      add(p.slice(0, arrow));
      add(p.slice(arrow + 4));
    } else {
      add(p);
    }
  }
  return paths;
}

export interface CommitDiff {
  changed: string[];
  added: string[];
  deleted: string[];
}

/** name-status diff between two commits. Store paths excluded. */
export async function diffNameOnly(root: string, from: string, to: string): Promise<CommitDiff> {
  const out = await git(root, ["diff", "--name-status", from, to]);
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [code, ...rest] = line.split("\t");
    const c = code[0];
    if (c === "A") added.push(rest[0]);
    else if (c === "D") deleted.push(rest[0]);
    else if (c === "M" || c === "T") changed.push(rest[0]);
    else if (c === "R" || c === "C") {
      if (rest[0]) deleted.push(rest[0]);
      if (rest[1]) added.push(rest[1]);
    }
  }
  const keep = (p: string) => !isStorePath(p);
  return {
    changed: changed.filter(keep),
    added: added.filter(keep),
    deleted: deleted.filter(keep),
  };
}

/** All tracked files (store paths excluded, in case the store was committed). */
export async function trackedFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files"]);
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !isStorePath(p));
}
