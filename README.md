# agent-memoize

Shared project-memory MCP server for AI coding agents (Claude Code, Codex, and any MCP client).

Agents waste context re-analyzing the same project every session. `agent-memoize` gives them a
small, durable memory store at `<project>/.agent-memoize/`: while an agent reads your code it
writes per-topic notes ("memories"), and on the next session it recalls them instead of
re-scanning the codebase. The store is **shared** — every agent connected to the project reads
and writes the same memories, and each memory records which agent wrote it.

The hard part is staleness: you (or a `git pull`, or another agent) can change the project
without an agent knowing. The server handles this in code, not prompt prose:

- Every memory declares the files it was derived from (`sources`).
- At session start the agent calls `memoize_status` — one cheap check (git state diff, or
  content hashes outside git repos) that reports exactly which files changed and which memories
  are stale.
- Stale memories are never served: `memoize_recall` returns the changed source files to re-read
  instead, so the worst case degrades to what the agent does today.
- Memories recording **user decisions** are never invalidated by file changes — only by the
  user contradicting them.

Memory content enters the agent's context strictly on demand (via `recall`), and tool output is
compact — the store costs almost no context when unused.

## Install

```sh
npm install -g agent-memoize-mcp        # or run it via npx (no install)
```

## Configure your agent

**Claude Code** — `.mcp.json` in the project (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "agent-memoize-mcp"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.agent-memoize]
command = "npx"
args = ["-y", "agent-memoize-mcp"]
```

**OpenCode** — `opencode.json` in the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agent-memoize": {
        "type": "local",
        "command": ["npx", "-y", "agent-memoize-mcp"]
      }
    }
  }
}
```

Or add it from the CLI: `opencode2 mcp add agent-memoize -- npx -y agent-memoize-mcp`.

**Pi** — `.mcp.json` in the project (or `~/.config/mcp/mcp.json` for user scope). Pi reads the
standard `mcpServers` format, so Claude Code's project config works as-is:

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "agent-memoize-mcp"]
    }
  }
}
```

**ZCode** — add via Settings → MCP Servers → New MCP Server (type `stdio`, command `npx`,
args `-y agent-memoize-mcp`), or declare it in the workspace config `<project>/.zcode/config.json`:

```json
{
  "mcp": {
    "servers": {
      "agent-memoize": {
        "command": "npx",
        "args": ["-y", "agent-memoize-mcp"]
      }
    }
  }
}
```

ZCode also accepts the standard `mcpServers` structure in `<project>/.agents/mcp.json`, and can
import existing servers from Claude Code, Codex, or OpenCode configs via the Import button on
the MCP Servers page.

**Kimi** — `~/.kimi-code/mcp.json` (user scope) or `<project>/.kimi-code/mcp.json` (project
scope):

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "agent-memoize-mcp"]
    }
  }
}
```

Or add it from the CLI: `kimi mcp add agent-memoize -- npx -y agent-memoize-mcp`.

**Any MCP client**: launch `agent-memoize` over stdio. The project root is resolved from
`--root <dir>`, then `$MEMOIZE_ROOT`, then the process working directory.

**Running from a local checkout** (development):

```json
{ "mcpServers": { "agent-memoize": { "command": "node", "args": ["/path/to/memoize-skill/dist/index.js"] } } }
```

## Tell the agent how to use it

MCP tools don't invoke themselves. Add this block to your project's `AGENTS.md` — read by
Codex, OpenCode, Pi, ZCode, and Kimi — or `CLAUDE.md` (Claude Code) so agents adopt the workflow:

```markdown
## Project memory (agent-memoize MCP)

- At session start, call `memoize_status` once. If entries are stale, re-read only the listed
  files — do not rescan the project.
- Before exploring the codebase, call `memoize_recall`. Recall a topic before reading the files
  it describes; if the memory is fresh and sufficient, skip reading them.
- After editing files, call `memoize_update` for each affected entry (kind="file", with
  `sources`). Create entries as you learn the project: architecture, conventions, gotchas.
- Record user decisions and preferences with `memoize_update` (kind="decision", no sources).
- Memory guides navigation only: always read a file before editing it, even if memory
  describes it.
```

## Tools

| Tool | Purpose |
| --- | --- |
| `memoize_status()` | Session-start check. Returns `{ state, mode, changedFiles, addedFiles, deletedFiles, staleEntries }`. `state`: `empty` / `fresh` / `stale`. |
| `memoize_recall(topic?)` | No topic: index of entries (names, summaries, staleness — no content). With topic: entry content if fresh, else the changed source files to re-read. |
| `memoize_update(name, content, kind, sources?, summary?, author?)` | Create/refresh an entry and re-baseline its fingerprints. `kind="file"` requires `sources` (project-relative paths/globs). |
| `memoize_invalidate(name?, confirm)` | Delete one entry, or the whole store when `name` is omitted. Requires `confirm=true` — the store is shared. |

The `author` of each entry defaults to the MCP client's name (from the protocol handshake), so
you can see whether Codex or Claude Code wrote a memory.

## Store format

```
.agent-memoize/
  manifest.json        # per-entry fingerprints (machine-managed; do not edit)
  project.md           # an entry
  modules/auth.md      # nested names map to subdirectories
  decisions/...
```

An entry is Markdown with YAML front matter — human-readable, diffable, safe to commit or to
gitignore:

```markdown
---
kind: file                    # "file" (derived from code) | "decision" (from conversation)
sources:
  - src/auth/**               # required for kind=file
author: claude-code
updated: 2026-08-06T03:18:57.000Z
summary: Auth flow uses JWT middleware in src/auth/login.ts
---
Free-form markdown...
```

### How staleness is decided

Each entry carries a baseline in `manifest.json`: the git state (HEAD + dirty files) and the
content hashes of its matched sources at update time. `memoize_status` compares the baseline
against the current workspace, per entry:

- **Git repos**: HEAD moved → `git diff` between the commits gives precise changed/added/deleted
  files. Dirty-set differences catch uncommitted edits. Files that were dirty at baseline *and*
  now are re-verified by hash (git state alone can't see a second edit to the same dirty file).
- **Non-git**: content hashes of matched sources, with an mtime+size pre-check so unchanged
  files are never re-hashed.

Only entries whose `sources` intersect the changed files go stale. Updating one entry never
clears another entry's staleness. Writes are atomic and guarded by a short-lived lock, so
multiple agents can share the store safely.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs unit + MCP-over-stdio integration tests
```

Publishing: `npm publish` (`prepublishOnly` runs build + tests; only `dist/` ships).
