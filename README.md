# @naevic/agent-memoize

`@naevic/agent-memoize` is a shared project-memory MCP server for AI coding agents.

![Example of `agent-memoize` coming in handy](docs/static/introduction.png)

## Why

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

### Automatic installation (macOS, Linux, WSL)

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/harlanwei/memoize/main/install.sh)
```

It installs the MCP server globally, detects which coding agents you have and
asks which to configure as MCP clients, and injects the workflow prompt into
your project's `AGENTS.md`/`CLAUDE.md` — and, on request, the global agent
prompts (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.config/opencode/AGENTS.md`, `~/.kimi-code/AGENTS.md`, `~/.zcode/AGENTS.md`).

> Run it from the project directory you want to configure: project-scope
> configs (`.mcp.json`, `opencode.json`, `.kimi-code/mcp.json`,
> `.zcode/config.json`, `AGENTS.md`) are written into your current directory,
> and Codex's `~/.codex/config.toml` into your home directory. Config edits
> are backed up to `*.bak` before being edited, and the prompt injection is
> idempotent — re-running never duplicates an entry.
>
> `bash <(…)` is used instead of `curl … | bash` so the script's prompts can
> still read your answers from the terminal.

| Flag | Meaning |
| --- | --- |
| `--agent claude,codex` | Configure only the listed agents (no detection, no prompts) |
| `--yes` | Approve every prompt automatically |

### Manual installation (macOS, Linux, Windows)
<details>
<summary>Expand</summary>

### Step 1: install it on your computer

```sh
npm install -g @naevic/agent-memoize
```

### Step 2: set up your coding agent as an MCP client

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

Or add it from the CLI: `opencode mcp add agent-memoize -- npx -y @naevic/agent-memoize`.

**Pi coding agent** — install the `pi-mcp-adapter` extension first, then restart Pi:

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

**DeepSeek Harness** — (TBA)

**Kimi Code** — `~/.kimi-code/mcp.json` (user scope) or `<project>/.kimi-code/mcp.json` (project
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

**ZCode** — declare it in the workspace config `<project>/.zcode/config.json`:

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

**Running from a local checkout** (development):

```json
{ "mcpServers": { "agent-memoize": { "command": "node", "args": ["/path/to/memoize-skill/dist/index.js"] } } }
```

### Step 3: inform your coding agent about the workflow

Add this block to your project's `AGENTS.md` (read by
most coding agents, including Codex, OpenCode, Pi, ZCode, and Kimi Code) or `CLAUDE.md` (Claude Code) so agents adopt the workflow:

```markdown
<!-- agent-memoize:start -->
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
<!-- agent-memoize:end -->
```

Or, better yet, inject it using the CLI:

```sh
agent-memoize --inject                       # current project: AGENTS.md and CLAUDE.md
                                             # (both created if missing)
agent-memoize --inject global                # global prompts of every supported agent
                                             # installed on PATH
agent-memoize --inject global:claude,codex   # ... or just the listed agents
```
</details>

## Tools

| Tool | Purpose |
| --- | --- |
| `memoize_status()` | Session-start check. Returns `{ state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries }`. `state`: `empty` / `fresh` / `stale`. |
| `memoize_recall(topic?)` | No topic: index of entries (names, summaries, per-entry `status`: `fresh` / `verified` / `stale` / `suspended` — no content). With topic: entry content if fresh or verified, else the changed source files to re-read (narrowed to the files that actually break the memory). |
| `memoize_update(name, content, kind, sources?, summary?, author?)` | Create/refresh an entry and re-baseline its fingerprints. `kind="file"` requires `sources` (project-relative paths/globs). |
| `memoize_invalidate(name?, confirm)` | Delete one entry, or the whole store when `name` is omitted. Requires `confirm=true` — the store is shared. |

The `author` of each entry defaults to the MCP client's name (from the protocol handshake), so
you can see which coding agent wrote that memory.

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
features compose non-exclusively and run in the order they are listed in the `plugins` array
(earlier runs first). Built-in plugins ship with the package; third-party plugins load as npm packages.

| Plugin type | What it does | Built-in (default) |
| --- | --- | --- |
| `datasource` | Produces and normalizes the raw input that becomes a memory; may also register extra MCP tools (e.g. a language-server source) | `agent` — validates `memoize_update` input, tags provenance, lints wide `sources` globs |
| `database` | Persists entries and baselines. First enabled database is the primary read/write target; the rest are mirrors (writes fan out, failures warn) | `files` — `.agent-memoize/` markdown files + `manifest.json` |
| `format` | Defines the memory representation and injects the agent instruction that produces it (into the `memoize_update` description). First format in the config is primary: its `render` shapes recall content; others annotate | `markdown` — free-form markdown + re-verification guidance |
| `filter` | Retrieval strategy: gate, rank, drop, or annotate recall candidates. Filters chain in config order | `core-filter` — the staleness gate anchor |
| `postprocessing` | Runs on an operation's result (`status` / `recall` / `update` / `invalidate`) right before it is returned to the agent, so it can give the agent extra guidance — e.g. whether to update memories. Plugins chain in config order; each sees the previous one's output | — (opt-in) |
| `debugging` | Observability: `onMemoryCreated` fires when a memory is created/refreshed, `onMemoryAccessed` when an agent recalls memories. Hooks are best-effort — failures are logged, never fatal | — (opt-in) |

### Config

`.agent-memoize/config.json`:

```json
{
  "version": 1,
  "staleness": "claims",
  "ignoreComments": false,
  "plugins": [
    { "id": "files" },
    { "id": "markdown" },
    { "id": "core-filter" },
    { "id": "agent" },
    { "id": "agent-memoize-db-sqlite", "options": { "dbPath": ".memo.sqlite" } },
    { "id": "agent-memoize-filter-semantic", "options": { "model": "local" } }
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

### Using local, unpublished plugins

To use a plugin that has not been published to npm (e.g. a development checkout of
`@naevic/agent-memoize-plugin-dreaming`), point the config at its **built** entry file instead
of the package name:

```sh
# from the plugin's checkout: build it first, so dist/ is up to date
npm run build          # in memoize-skill, this builds the core and both plugin packages
```

```json
{
  "version": 1,
  "plugins": [
    { "id": "files" },
    { "id": "markdown" },
    { "id": "core-filter" },
    { "id": "agent" },
    {
      "id": "/home/you/dev/memoize-skill/packages/agent-memoize-plugin-dreaming/dist/index.js",
      "options": { "threshold": 15 }
    }
  ]
}
```

Notes:

- The `id` may be an absolute path or a `file:` URL (e.g. `file:///home/you/dev/.../dist/index.js`).
- The path must point at the **compiled** output (`dist/index.js`), not the TypeScript source.
- Re-run the plugin's build after changing it — the server `import()`s the file, it does not watch it.
- The entry's `id` and `type` come from the plugin module itself, so the config key can stay a path
  while the plugin is still registered under its declared id (e.g. `dreaming`).
- Once the plugin is published, just swap the `id` back to the package name and install it:
  the two companion plugins below show the published form.

### Companion plugins

**`@naevic/agent-memoize-plugin-dreaming`** (postprocessing) — once stale/suspended memories
accumulate to a configurable amount (default 15), `memoize_status` returns an extra `dreaming`
section telling the agent to spawn subagents that verify the memories against their current
sources and reorganize them into a more concise format.

```sh
npm install -D @naevic/agent-memoize-plugin-dreaming   # in the project (or the server install)
# not published yet? use a local build instead — see "Using local, unpublished plugins" above
```

```json
{
  "version": 1,
  "plugins": [
    { "id": "files" },
    { "id": "markdown" },
    { "id": "core-filter" },
    { "id": "agent" },
    { "id": "dreaming", "options": { "threshold": 15 } }
  ]
}
```

**`@naevic/agent-memoize-plugin-dashboard`** (debugging) — logs every memory creation/refresh
and every recall access, and serves an HTTP dashboard to inspect the logs. By default no
debugging plugin is enabled.

```sh
npm install -D @naevic/agent-memoize-plugin-dashboard
# not published yet? use a local build instead — see "Using local, unpublished plugins" above
```

```json
{
  "version": 1,
  "plugins": [
    { "id": "files" },
    { "id": "markdown" },
    { "id": "core-filter" },
    { "id": "agent" },
    { "id": "dashboard", "options": { "port": 8888 } }
  ]
}
```

Open `http://127.0.0.1:8888` to see the activity stream (auto-refreshes every 2 s). Raw logs
are available at `/api/logs`; they are also appended as JSONL to
`.agent-memoize/logs/dashboard.jsonl` — the JSONL file is the shared source of truth, and the
dashboard tails it on every poll. On startup the dashboard replays the most recent `maxLogs`
entries from that file, so history from previous agent sessions stays visible.

**Multiple agents on the same project**: when another agent's session already serves the
dashboard for the same project (detected by probing the configured port's `/api/logs`
`project` field), the new instance does not start a second HTTP server — it switches to
log-only mode and appends its records to the shared JSONL file, where the running dashboard
picks them up within ~2 s. If the port is held by an unrelated service instead, the dashboard
falls back to a random port and logs the URL.

Every log record carries an `accessor` field identifying the MCP client that performed the
operation (e.g. `claude-code`, `codex`), shown in the dashboard's agent column.

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
