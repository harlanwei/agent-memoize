## How staleness is decided

Each entry carries a baseline in `manifest.json`: the git state (HEAD + dirty files), the
content hashes of its matched sources, and — under the default policy — the **claim regions**:
the lines of each source file that the entry text actually references (identifiers and paths
extracted from the content). `memoize_status` compares the baseline against the current
workspace, per entry:

- **Git repos**: HEAD moved → `git diff` between the commits gives precise changed/added/deleted
  files. Dirty-set differences catch uncommitted edits. Files that were dirty at baseline *and*
  now are re-verified by hash (git state alone cannot see a second edit to the same dirty file).
- **Non-git**: content hashes of matched sources, with an mtime+size pre-check so unchanged
  files are never re-hashed.

Then the **staleness policy** decides what counts as stale:

| Policy | Cosmetic edits (whitespace/comments) | Non-claim edits | Claim-line edits | New files in `sources` |
| --- | --- | --- | --- | --- |
| `strict` | stale | stale | stale | stale |
| `selective` (default) | fresh | auto re-baselined (`verified`) | **stale** | stale when referenced, else re-baselined |

A **claim line** is a line of a source file that the entry text references; staleness is judged
on claim lines only, and the check is position-independent (inserting or removing lines
elsewhere in the file does not invalidate the memory). `changedSources` is narrowed to the
files whose claim lines actually broke.
