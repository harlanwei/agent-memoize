# @naevic/agent-memoize

English | [中文](README.zh-cn.md)

`@naevic/agent-memoize` is an MCP server that provides project-level memory capabilities for AI coding agents.

![Example of `agent-memoize` coming in handy](docs/static/introduction.png)

## Motive

Coding agents often waste context re-analyzing the same project every session, which is extremely time-consuming with large projects. Also, agents won't remember your past choices unless you explicitly tell them to write it down.

The idea behind `agent-memoize` is simple: gives them a small, durable memory store. While an agent reads your code, it writes per-topic notes, and on the next session it recalls them instead of re-scanning the codebase. The store is **shared** — every agent connected to the project reads and writes the same memories, and each memory records which agent wrote it.

The hard part is staleness: you (or a `git pull`, or another agent) can change the project without an agent knowing. `agent-memoize` handles this in code, not prompt prose:

- Every memory declares the files it was derived from.
- At session start the MCP server does one cheap check that reports which memory source files changed and which memories are stale.
- Stale memories are never served as truth: the MCP server returns the changed source files and ask the agent to re-read instead, so the worst case degrades to what the agent does today. `memoize_recall(topic, includeStale=true)` also returns the outdated body, for when you need to rewrite it.
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

After installation, `agent-memoize` is configured at user scope and will be enabled for all projects automatically.

| Optional flags | Effect |
| --- | --- |
| `--agent claude,codex` | Configure only the listed agents (no detection or agent-selection prompts) |
| `--yes` | Approve every prompt automatically |

### Manual installation (macOS, Linux, Windows)

<details>
<summary>Expand</summary>

### Step 1: install the npm package

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

**OpenCode** — `~/.config/opencode/opencode.json` (user scope) or `opencode.json` in the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-memoize": {
      "type": "local",
      "command": ["npx", "-y", "@naevic/agent-memoize"]
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

**ZCode** — `~/.zcode/cli/config.json` (user scope) or `<project>/.zcode/config.json` (workspace scope):

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

**DeepSeek Harness (DSH)** — not officially supported as of now. DSH uses a vastly different plugin system and is still in early development. If you must use DSH, there are plugins that integrate MCPs into DSH. Try at your own risk.

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

### Step 3: adapt your coding agent to the workflow

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
  Producer plugins are sources of truth — follow the producer guidance in the
  `memoize_update` tool description.
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

The default configuration should suffice for most use cases. If you need more fine grained control over the MCP server's behavior, edit `.agent-memoize/config.json`:

```json
{
  "version": 1,
  "staleness": "selective", // `selective` (default): only changes to selected lines
                            // would affect a memory's staleness
                            // `strict`: changes to relevant files would affect a
                            // memory's staleness, regardless of whether the changes
                            // are on the selected lines
  "ignoreComments": false   // `false` (default): changes to comments will affect a
                            // memory's staleness
                            // `true`: changes to comments will not affect a memory's
                            // staleness. Coding agents sometimes document their changes
                            // in comments, so this is not recommended
}
```

`agent-memoize` provides support for plugins. Every capability is provided by a plugin. However, using custom plugins could introduce unnecessary complications to the pipeline. **We strongly suggest against using custom plugins unless you are very experienced in doing so**.

## How it works

### Tools

| Tool | Purpose |
| --- | --- |
| `memoize_status()` | Session-start check for memory source files. Returns `{ dreaming?, state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries, invalidEntries, truncated }`. `dreaming` leads the result and is present only once enough stale/suspended memories have accumulated (default 15) — see [Organizer plugins](docs/plugins.md#organizer-plugins). File arrays are capped; `truncated=true` means more changes exist. `state`: `empty` / `fresh` / `stale`. |
| `memoize_recall(topic?, includeStale?)` | No topic: index of entries (names, summaries, per-entry `status`: `fresh` / `verified` / `stale` / `suspended` — no content). With topic: entry content if fresh or verified, else the changed source files to re-read (narrowed to the files that actually break the memory). `includeStale=true` additionally returns the stored body of a stale/suspended entry, so it can be rewritten. |
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
- Cosmetic-only source changes are reported in `cosmeticChanges`.

Only entries whose `sources` intersect the changed files are touched. Updating one entry never clears staleness for another entry. Writes are atomic and guarded by a short-lived lock, so multiple agents can share the store safely.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs unit + MCP-over-stdio integration tests
```

Publishing: `npm publish` (`prepublishOnly` runs build + tests; only `dist/` ships).
