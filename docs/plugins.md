English | [中文](plugins.zh-cn.md)

# Plugins

You can customize how `agent-memoize` works by configuring the plugins. The server is a plugin pipeline: every capability is provided by an enabled plugin. Built-in plugins ship with the `@naevic/agent-memoize` package and use `@naevic/agent-memoize/` ids; third-party plugins load as npm packages.

Plugins are categorized into six categories:

| Category | What it does |
| --- | --- |
| `producers` | Sources of truth: generate the truth a memory is derived from (or tell the main agent how to generate it) and hand that truth to the main agent; may also register extra MCP tools (e.g. LSP analysis) |
| `writers` | Defines the memory representation and injects the agent instruction that produces it (into the `memoize_update` description). First writer in the config is primary: its `render` shapes recall content; others annotate |
| `ledgers` | Persists entries and baselines. Ledgers are organized into groups — recall tries groups in order (a group's ledgers are queried in parallel, the front one wins on contradiction); writes go to the first ledger only |
| `filters` | Retrieval strategy: gate, rank, drop, or annotate recall candidates. Filters chain in config order |
| `organizers` | Runs on an operation's result (`status` / `recall` / `update` / `invalidate`) right before it is returned to the agent, so it can give the agent extra guidance — e.g. whether to update memories. Plugins chain in config order; each sees the previous one's output |
| `observers` | Observability: `onMemoryCreated` fires when a memory is created/refreshed, `onMemoryAccessed` when an agent recalls memories. Hooks are best-effort — failures are logged, never fatal |

When the agent needs new information, it:
1. gets truth from *producers*
2. formats truth using *writers*
3. persists truth using *ledgers*

And when the agent recalls memories, it:
1. filters memories using *filters*

Sometimes when instructed, the agent would organize memories using *organizers*, and would leave traces of how it interacts with `agent-memoize` using *observers*.

### Producer plugins

Producer plugins are sources of truth. Each producer either generates the truth directly — for example by exposing an LSP-backed MCP tool — or tells the main agent how to generate it. The generated truth is provided to the main agent, which looks at it and decides what to do next — usually writing or refreshing the entry with `memoize_update`.

**`@naevic/agent-memoize/agent-producer`** (built-in, default) — the default source of truth. Its `memoize_update` guidance tells the main agent to spawn a subagent with the goal to explore the project around the entry's topic, then use that subagent's findings as the truth written to the entry. It also lints `sources` and warns when an entry's sources collectively match more than 20 files, since broad coverage makes the entry stale easily.

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

## Configuring plugins

To configure plugins, edit `.agent-memoize/config.json`. The default plugin configuration:

```json
{
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

The `plugins` field groups plugins by category, and within each category plugins run in the order they are listed. A category you don't configure falls back to its default built-in. A category you do configure runs exactly the plugins you list. For instance, `"writers": []` leaves the writers category empty, and `"writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }]` replaces its default.

The `producers`, `writers`, and `ledgers` categories must not be empty. If any of them ends up empty, startup fails. Precedence: config file < `MEMOIZE_PLUGINS` env (same shape as the config file) < `--plugins <json>` CLI arg.

**How `id` resolves**: ids starting with `@naevic/agent-memoize/` are built-in plugins, resolved internally. Anything else is `import()`ed — an npm package name (resolved first against the server, then against the project `node_modules`), or an absolute path or `file:` URL to a local build for development. A plugin module exports `{ plugin }`, a default plugin object, or a default factory `(options) => plugin`. The config `id` is the module specifier; the plugin itself declares the id it is registered under (e.g. `dashboard` for the `@naevic/agent-memoize-plugin-log-observer` package), which is what appears in logs and in plugin tool names. Plugin id and type are validated at startup (a plugin must be configured under its own category); load or init failures abort the server with a clear message (fail fast).

## Creating a custom plugin

```ts
import type { LedgerPlugin, PluginContext } from "@naevic/agent-memoize";

export const plugin: LedgerPlugin = {
  id: "my-db",
  version: "1.0.0",
  type: "ledger",
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

`Entry` and `Manifest` are the core data contract (`src/types.ts`): producers generate the
truth that entries are written from, writers shape `entry.content`, ledgers store them, and
filters rank them.

### Using local, unpublished plugins

To use a plugin that has not been published to npm (e.g. a development checkout of
`@naevic/agent-memoize-plugin-log-observer`), point the config at its **built** entry file
instead of the package name:

```sh
# from the plugin's checkout: build it first, so dist/ is up to date
npm run build          # in the core checkout, this builds the core and the plugin package
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
      {
        "id": "/path/to/agent-memoize-plugin-log-observer/dist/index.js",
        "options": { "port": 8888 }
      }
    ]
  }
}
```

Notes:

- The `id` may be an absolute path or a `file:` URL (e.g. `file:///home/you/dev/.../dist/index.js`).
- The path must point at the **compiled** output (`dist/index.js`), not the TypeScript source.
- Re-run the plugin's build after changing it — the server `import()`s the file, it does not watch it.
- The config `id` is just the module specifier (a built-in id, an npm package name, or a path);
  the plugin itself declares the id it is registered under (e.g. `dashboard`), which is what
  shows up in logs and plugin tool names.
- Once the plugin is published, just swap the `id` to the package name
  (`@naevic/agent-memoize-plugin-log-observer`) and install it — the companion plugin's
  README shows the published form.
