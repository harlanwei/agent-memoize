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
npm install -g @naevic/agent-memoize        # or run it via npx (no install)
```

## Configure your agent

**Claude Code** — `.mcp.json` in the project (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.agent-memoize]
command = "npx"
args = ["-y", "@naevic/agent-memoize"]
```

**OpenCode** — `opencode.json` in the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agent-memoize": {
        "type": "local",
        "command": ["npx", "-y", "@naevic/agent-memoize"]
      }
    }
  }
}
```

Or add it from the CLI: `opencode2 mcp add agent-memoize -- npx -y @naevic/agent-memoize`.

**Pi** — install the `pi-mcp-adapter` extension first, then restart Pi:

```sh
pi install npm:pi-mcp-adapter
```

Pi doesn't load MCP servers without it. Once installed, the adapter reads standard MCP files
automatically, so Claude Code's project config works as-is — `.mcp.json` in the project (or
`~/.config/mcp/mcp.json` for user scope):

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

**ZCode** — add via Settings → MCP Servers → New MCP Server (type `stdio`, command `npx`,
args `-y @naevic/agent-memoize`), or declare it in the workspace config `<project>/.zcode/config.json`:

```json
{
  "mcp": {
    "servers": {
      "agent-memoize": {
        "command": "npx",
        "args": ["-y", "@naevic/agent-memoize"]
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
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

Or add it from the CLI: `kimi mcp add agent-memoize -- npx -y @naevic/agent-memoize`.

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
  files — do not rescan the project. `verified` entries are already fresh (auto re-baselined);
  `suspended` entries need their sources fixed via `memoize_update`.
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
| `memoize_status()` | Session-start check. Returns `{ state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries }`. `state`: `empty` / `fresh` / `stale`. |
| `memoize_recall(topic?)` | No topic: index of entries (names, summaries, per-entry `status`: `fresh` / `verified` / `stale` / `suspended` — no content). With topic: entry content if fresh or verified, else the changed source files to re-read (narrowed to the files that actually break the memory). |
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
| `claims` (default) | fresh | auto re-baselined (`verified`) | **stale** | stale |
| `cosmetic-only` | fresh | auto re-baselined | **stale** | stale |

A **claim line** is a line of a source file that the entry text references; staleness is judged
on claim lines only, and the check is position-independent (inserting or removing lines
elsewhere in the file does not invalidate the memory). `changedSources` is narrowed to the
files whose claim lines actually broke.

Recovery is automatic where it is safe:

- A changed file whose claim lines are intact is **auto re-baselined** — the memory stays fresh
  and `memoize_status` lists it under `verifiedEntries` (which counts as fresh for recall).
- A vanished explicit source with identical content elsewhere in the tree is treated as a
  **rename**: the entry sources are updated automatically.
- A vanished source with no rename (or sources that match nothing) leaves the entry
  **suspended**: it needs agent attention, but is no longer stuck in perpetual staleness.
- Cosmetic-only changes are reported in `cosmeticChanges` so nothing is hidden from the agent.

Only entries whose `sources` intersect the changed files are touched. Updating one entry never
clears staleness for another entry. Writes are atomic and guarded by a short-lived lock, so
multiple agents can share the store safely. Config knob: `staleness` in
`.agent-memoize/config.json` (or `MEMOIZE_STALENESS` env): `strict` | `claims` | `cosmetic-only`,
default `claims`. `ignoreComments: true` additionally strips full-line comments per language
when computing normalized hashes.
## Plugins

The server is a plugin pipeline: every capability is provided by an enabled plugin, so
features compose non-exclusively and are ordered by a numeric `priority` (higher runs first).
Built-in plugins ship with the package; third-party plugins load as npm packages.

| Plugin type | What it does | Built-in (default) |
| --- | --- | --- |
| `datasource` | Produces and normalizes the raw input that becomes a memory; may also register extra MCP tools (e.g. a language-server source) | `agent` — validates `memoize_update` input, tags provenance, lints wide `sources` globs |
| `database` | Persists entries and baselines. First enabled database is the primary read/write target; the rest are mirrors (writes fan out, failures warn) | `files` — `.agent-memoize/` markdown files + `manifest.json` |
| `format` | Defines the memory representation and injects the agent instruction that produces it (into the `memoize_update` description). Highest-priority format is primary: its `render` shapes recall content; others annotate | `markdown` — free-form markdown + re-verification guidance |
| `filter` | Retrieval strategy: gate, rank, drop, or annotate recall candidates. Filters chain in priority order | `core-filter` — the staleness gate anchor |

### Config

`.agent-memoize/config.json`:

```json
{
  "version": 1,
  "staleness": "claims",
  "ignoreComments": false,
  "plugins": [
    { "id": "files", "priority": 100 },
    { "id": "markdown", "priority": 100 },
    { "id": "core-filter", "priority": 100 },
    { "id": "agent", "priority": 100 },
    { "id": "agent-memoize-db-sqlite", "priority": 200, "options": { "dbPath": ".memo.sqlite" } },
    { "id": "agent-memoize-filter-semantic", "priority": 50, "options": { "model": "local" } }
  ]
}
```

When the config file is missing, or a type has no plugins, the defaults above are used — no
config means exactly the previous behavior. Precedence: config file < `MEMOIZE_PLUGINS` env
(JSON array) < `--plugins <json>` CLI arg.

**Resolution**: built-in ids (`files`, `markdown`, `core-filter`, `agent`) resolve internally;
anything else is `import()`ed — an npm package name resolved first against the server, then
against the project (`node_modules`), or an absolute path to a local build for development.
A plugin module exports `{ plugin }`, a default plugin object, or a default factory
`(options) => plugin`. The plugin id and type are validated at startup; load or init failures
abort the server with a clear message (fail fast).

**Trust model**: plugins run with full user privileges, exactly like the MCP server itself.
Only enable packages you trust. Plugin-registered tools are namespaced
`memoize_<pluginId>_<name>` so they can never shadow the core tools.

### Writing a plugin

```ts
import type { DatabasePlugin, PluginContext } from "@naevic/agent-memoize";

export const plugin: DatabasePlugin = {
  id: "my-db",
  version: "1.0.0",
  type: "database",
  async init(ctx: PluginContext) {
    // ctx.root, ctx.options, ctx.registerTool, ctx.log, ctx.db
  },
  async listEntries() { /* -> { entries, invalid } */ },
  async readEntry(name) { /* -> Entry | null */ },
  async writeEntry(entry) { /* ... */ },
  async deleteEntry(name) { /* -> boolean */ },
  async loadManifest() { /* -> Manifest */ },
  async saveManifest(m) { /* ... */ },
  async withLock(fn) { /* -> fn() */ },
};
```

`Entry` and `Manifest` are the core data contract (`src/types.ts`): databases store them,
formats shape `entry.content`, datasources produce them, filters rank them.
## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs unit + MCP-over-stdio integration tests
```

Publishing: `npm publish` (`prepublishOnly` runs build + tests; only `dist/` ships).
