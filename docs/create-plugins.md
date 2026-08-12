## Creating a plugin

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

`Entry` and `Manifest` are the core data contract (`src/types.ts`): producers produce them,
writers shape `entry.content`, ledgers store them, filters rank them.

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
