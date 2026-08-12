## Creating a plugin

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
      "id": "/path/to/agent-memoize-plugin-dreaming/dist/index.js",
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
