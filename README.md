# @naevic/agent-memoize

English | [中文](README.zh-cn.md)

`@naevic/agent-memoize` is an MCP server that provides project-level memory capabilities for AI coding agents.

![Example of `agent-memoize` coming in handy](docs/static/introduction.png)

## Motive

Coding agents often waste context re-analyzing the same project every session, which is extremely time-consuming with large projects. Also, agents won't remember your past choices unless you explicitly tell them to write it down.

The idea behind `agent-memoize` is simple: gives them a small, durable memory store. While an agent reads your code, it writes per-topic notes, and on the next session it recalls them instead of re-scanning the codebase. The store is **shared** — every agent connected to the project reads and writes the same memories, and each memory records which agent wrote it.

The hard part is staleness: you (or a `git pull`, or another agent) can change the project without an agent knowing. `agent-memoize` handles this in code, not prompt prose:

- Every memory declares the files it was derived from.
- At session start the MCP server does one cheap check that reports exactly which files changed and which memories are stale.
- Stale memories are never served: the MCP server returns the changed source files and ask the agent to re-read instead, so the worst case degrades to what the agent does today.
- Memories recording user decisions are never invalidated by file changes, only by the user contradicting them.

Memory content enters the agent's context strictly on demand, and tool output is compact. The store costs almost no context when unused.

## Quick start (macOS, Linux, WSL)

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/harlanwei/agent-memoize/main/install.sh)
```

Windows users under non-WSL environments need to install manually.

## Install

### Automatic installation (macOS, Linux, WSL)

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/harlanwei/agent-memoize/main/install.sh)
```

After installation, `agent-memoize` will be enabled for all projects automatically.

| Optional flags | Effect |
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

Pi doesn't load MCP servers without it. Once installed, the adapter reads standard MCP files automatically, so Claude Code's project config works as-is — `.mcp.json` in the project (or `~/.config/mcp/mcp.json` for user scope):

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

**Kimi Code** — `~/.kimi-code/mcp.json` (user scope) or `<project>/.kimi-code/mcp.json` (project scope):

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

ZCode also accepts the standard `mcpServers` structure in `<project>/.agents/mcp.json`, and can import existing servers from Claude Code, Codex, or OpenCode configs via the Import button on the MCP Servers page.

**Running from a local checkout** (development):

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "node",
      "args": ["/path/to/agent-memoize/dist/index.js"]
    }
  }
}
```

### Step 3: inform your coding agent about the workflow

Add this block to your project's `AGENTS.md` (read by most coding agents, including Codex, OpenCode, Pi, ZCode, and Kimi Code) or `CLAUDE.md` (Claude Code) so agents adopt the workflow:

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

## Configurations

`.agent-memoize/config.json`:

```json
{
  "version": 1,
  "staleness": "selective",
  "ignoreComments": false,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [{ "id": "@naevic/agent-memoize/dream-organizer" }],
    "observers": []
  }
}
```

The `plugins` field groups plugins by category; the categories are the six keys above, and within each category plugins run in the order they are listed. A category you don't configure falls back to its default built-in — the example above is the full default pipeline, and no config at all means exactly that. A category you do configure runs exactly the plugins you list: `"writers": []` leaves the writers category empty, and `"writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }]` replaces its default. The `producers`, `writers`, and `ledgers` categories are required: if any of them ends up empty, startup fails. Precedence: config file < `MEMOIZE_PLUGINS` env (same shape as the config file) < `--plugins <json>` CLI arg.

**How `id` resolves**: ids starting with `@naevic/agent-memoize/` are built-in plugins, resolved internally. Anything else is `import()`ed — an npm package name (resolved first against the server, then against the project `node_modules`), or an absolute path or `file:` URL to a local build for development. A plugin module exports `{ plugin }`, a default plugin object, or a default factory `(options) => plugin`. The config `id` is the module specifier; the plugin itself declares the id it is registered under (e.g. `dashboard` for the `@naevic/agent-memoize-plugin-log-observer` package), which is what appears in logs and in plugin tool names. Plugin id and type are validated at startup (a plugin must be configured under its own category); load or init failures abort the server with a clear message (fail fast).

## Plugins

The server is a plugin pipeline: every capability is provided by an enabled plugin, so features compose non-exclusively and run in the order they are listed within their category. Built-in plugins ship with the `@naevic/agent-memoize` package and use `@naevic/agent-memoize/` ids; third-party plugins load as npm packages.

| Category | What it does |
| --- | --- |
| `producers` | Produces and normalizes the raw input that becomes a memory; may also register extra MCP tools (e.g. a language-server source) |
| `writers` | Defines the memory representation and injects the agent instruction that produces it (into the `memoize_update` description). First writer in the config is primary: its `render` shapes recall content; others annotate |
| `ledgers` | Persists entries and baselines. Ledgers are organized into groups — recall tries groups in order (a group's ledgers are queried in parallel, the front one wins on contradiction); writes go to the first ledger only |
| `filters` | Retrieval strategy: gate, rank, drop, or annotate recall candidates. Filters chain in config order |
| `organizers` | Runs on an operation's result (`status` / `recall` / `update` / `invalidate`) right before it is returned to the agent, so it can give the agent extra guidance — e.g. whether to update memories. Plugins chain in config order; each sees the previous one's output |
| `observers` | Observability: `onMemoryCreated` fires when a memory is created/refreshed, `onMemoryAccessed` when an agent recalls memories. Hooks are best-effort — failures are logged, never fatal |

### Producer plugins

**`@naevic/agent-memoize/agent-producer`** (built-in, default) — validates `memoize_update` input, tags provenance, and lints wide `sources` globs.

### Writer plugins

**`@naevic/agent-memoize/markdown-writer`** (built-in, default) — free-form markdown with re-verification guidance.

### Ledger plugins

**`@naevic/agent-memoize/file-ledger`** (built-in, default) — persists entries as `.agent-memoize/` markdown files plus a machine-managed `manifest.json`.

Ledgers are organized into **groups** — each `ledgers` entry is either a single ledger or an array of ledgers, so `"ledgers": [ ledger1, [ledger2, ledger3], ledger4 ]` defines three groups: `[ledger1]`, `[ledger2, ledger3]`, `[ledger4]`. Recall tries the groups in order and stops at the first group that has the requested info after the filter chain: a group's ledgers are queried in parallel and merged by entry name, so when two ledgers in the same group contradict each other, the one listed first wins. If the group's candidates are all filtered out, recall continues with the next group. Writes (`memoize_update` / `memoize_invalidate`) go to the first ledger of the first group only; porting memories to the other ledgers is the organizer's job.

### Filter plugins

**`@naevic/agent-memoize/stale-filter`** (built-in, default) — the staleness gate anchor: stale content is never served from recall, and this plugin is the chain slot other filters compose around.

### Organizer plugins

**`@naevic/agent-memoize/dream-organizer`** (built-in, default) — once stale/suspended memories accumulate to a configurable amount (default 15), `memoize_status` returns an extra `dreaming` section telling the agent to spawn subagents that verify the memories against their current sources and reorganize them into a more concise format. It runs out of the box; to change the threshold, configure it with options:

```json
{
  "version": 1,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [
      { "id": "@naevic/agent-memoize/dream-organizer", "options": { "threshold": 15 } }
    ],
    "observers": []
  }
}
```

### Observer plugins

**`@naevic/agent-memoize-plugin-log-observer`** — logs every memory creation/refresh and every recall access, and serves an HTTP dashboard to inspect the logs. By default no observer plugin is enabled.

```sh
npm install -g @naevic/agent-memoize-plugin-log-observer
```

```json
{
  "version": 1,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [{ "id": "@naevic/agent-memoize/dream-organizer" }],
    "observers": [
      { "id": "@naevic/agent-memoize-plugin-log-observer", "options": { "port": 8888 } }
    ]
  }
}
```

Open `http://127.0.0.1:8888` to see the activity stream (auto-refreshes every 2 s). Raw logs are available at `/api/logs`; they are also appended as JSONL to `.agent-memoize/logs/dashboard.jsonl` — the JSONL file is the shared source of truth, and the dashboard tails it on every poll. On startup the dashboard replays the most recent `maxLogs` entries from that file, so history from previous agent sessions stays visible.

**Multiple agents on the same project**: when another agent's session already serves the dashboard for the same project (detected by probing the configured port's `/api/logs` `project` field), the new instance does not start a second HTTP server — it switches to log-only mode and appends its records to the shared JSONL file, where the running dashboard picks them up within ~2 s. If the port is held by an unrelated service instead, the dashboard falls back to a random port and logs the URL.

Every log record carries an `accessor` field identifying the MCP client that performed the operation (e.g. `claude-code`, `codex`), shown in the dashboard's agent column.

**Trust model**: plugins run with full user privileges, exactly like the MCP server itself. Only enable packages you trust. Plugin-registered tools are namespaced `memoize_<pluginId>_<name>` so they can never shadow the core tools.

## How it works

### Tools

| Tool | Purpose |
| --- | --- |
| `memoize_status()` | Session-start check. Returns `{ state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries }`. `state`: `empty` / `fresh` / `stale`. |
| `memoize_recall(topic?)` | No topic: index of entries (names, summaries, per-entry `status`: `fresh` / `verified` / `stale` / `suspended` — no content). With topic: entry content if fresh or verified, else the changed source files to re-read (narrowed to the files that actually break the memory). |
| `memoize_update(name, content, kind, sources?, summary?, author?)` | Create/refresh an entry and re-baseline its fingerprints. `kind="file"` requires `sources` (project-relative paths/globs). |
| `memoize_invalidate(name?, confirm)` | Delete one entry, or the whole store when `name` is omitted. Requires `confirm=true` — the store is shared. |

The `author` of each entry defaults to the MCP client's name (from the protocol handshake), so you can see which coding agent wrote that memory.

### Store format

```
.agent-memoize/
  manifest.json        # per-entry fingerprints (machine-managed; do not edit)
  project.md           # an entry
  modules/auth.md      # nested names map to subdirectories
  decisions/...
```

An entry is Markdown with YAML front matter — human-readable, diffable, safe to commit or to gitignore:

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

- A changed file whose claim lines are intact is **auto re-baselined** — the memory stays fresh and `memoize_status` lists it under `verifiedEntries` (which counts as fresh for recall).
- A vanished explicit source with identical content elsewhere in the tree is treated as a **rename**: the entry sources are updated automatically.
- A vanished source with no rename (or sources that match nothing) leaves the entry **suspended**: it needs agent attention, but is no longer stuck in perpetual staleness.
- Cosmetic-only changes are reported in `cosmeticChanges` so nothing is hidden from the agent.

Only entries whose `sources` intersect the changed files are touched. Updating one entry never clears staleness for another entry. Writes are atomic and guarded by a short-lived lock, so multiple agents can share the store safely. Config knob: `staleness` in `.agent-memoize/config.json` (or `MEMOIZE_STALENESS` env): `strict` | `selective`, default `selective`. `ignoreComments: true` additionally strips comments (per-language line and block comments, keeping the code around them) when computing normalized hashes.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs unit + MCP-over-stdio integration tests
```

Publishing: `npm publish` (`prepublishOnly` runs build + tests; only `dist/` ships).
