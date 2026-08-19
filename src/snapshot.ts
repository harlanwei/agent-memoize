import {
  diffNameOnly,
  dirtyList,
  head as gitHead,
  isGitRepo,
  isValidCommit,
  trackedFiles,
  type CommitDiff,
} from "./git.js";
import { walkTree, WorkspaceFileCache } from "./workspace.js";

export interface WorkspaceSnapshot {
  root: string;
  mode: "git" | "hash";
  git: { head: string | null; dirty: string[] } | null;
  tree: string[];
  files: WorkspaceFileCache;
  diffs: Map<string, Promise<CommitDiff | null>>;
}

/** Capture project-wide state once for an update, status, or recall operation. */
export async function createWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const repo = await isGitRepo(root);
  if (!repo) {
    return {
      root,
      mode: "hash",
      git: null,
      tree: await walkTree(root),
      files: new WorkspaceFileCache(root),
      diffs: new Map(),
    };
  }
  const [head, dirty, tracked] = await Promise.all([
    gitHead(root),
    dirtyList(root),
    trackedFiles(root),
  ]);
  return {
    root,
    mode: "git",
    git: { head, dirty },
    tree: [...new Set([...tracked, ...dirty])],
    files: new WorkspaceFileCache(root),
    diffs: new Map(),
  };
}

/** Commit diffs are shared by entries and ledgers with the same baseline head. */
export function commitDiff(
  snapshot: WorkspaceSnapshot,
  oldHead: string,
): Promise<CommitDiff | null> {
  let pending = snapshot.diffs.get(oldHead);
  if (!pending) {
    const currentHead = snapshot.git?.head;
    pending = currentHead
      ? isValidCommit(snapshot.root, oldHead).then((valid) =>
          valid ? diffNameOnly(snapshot.root, oldHead, currentHead) : null,
        )
      : Promise.resolve(null);
    snapshot.diffs.set(oldHead, pending);
  }
  return pending;
}
