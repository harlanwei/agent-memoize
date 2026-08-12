import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../src/plugins/registry.js";
import { recallCtx, updateEntryCtx } from "../src/service.js";
import type { ServiceContext } from "../src/service.js";
import { tmpDir, write } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctxFor(registry: Registry, root: string): ServiceContext {
  return { root, registry };
}

async function writeConfig(root: string, plugins: unknown[], staleness?: string) {
  await write(
    root,
    ".agent-memoize/config.json",
    JSON.stringify({ version: 1, plugins, ...(staleness ? { staleness } : {}) }),
  );
}

function memoryDbPlugin(id = "agent-memoize-memory-db"): any {
  return {
    id,
    version: "1.0.0",
    type: "database",
    entries: new Map<string, any>(),
    manifest: { version: 1, entries: {} },
    async init() {},
    async listEntries() {
      return { entries: [...this.entries.values()], invalid: [] };
    },
    async readEntry(name) {
      return this.entries.get(name) ?? null;
    },
    async writeEntry(e) {
      this.entries.set(e.name, e);
    },
    async deleteEntry(name) {
      return this.entries.delete(name);
    },
    async loadManifest() {
      return this.manifest;
    },
    async saveManifest(m) {
      this.manifest = m;
    },
    async withLock(fn) {
      return fn();
    },
  };
}

import { plugin as filesDb } from "../src/plugins/builtin/db-files.js";
import { plugin as markdownFmt } from "../src/plugins/builtin/format-markdown.js";
import { plugin as coreFilter } from "../src/plugins/builtin/filter-core.js";
import { plugin as agentDs } from "../src/plugins/builtin/datasource-agent.js";

const builtinById: Record<string, any> = {
  files: filesDb,
  markdown: markdownFmt,
  "core-filter": coreFilter,
  agent: agentDs,
};

function loaderFor(plugins: any[]): any {
  return async (id: string) => {
    const p = plugins.find((x) => x.id === id);
    if (p) return p;
    if (builtinById[id]) return builtinById[id];
    throw new Error("missing plugin: " + id);
  };
}

afterEach(() => {
  delete process.env.MEMOIZE_PLUGINS;
  delete process.env.MEMOIZE_STALENESS;
});

describe("registry config", () => {
  it("defaults to the builtin plugin set with no config file", async () => {
    const dir = await tmpDir();
    const r = await Registry.create({ root: dir });
    expect(r.primaryDb.id).toBe("files");
    expect(r.formats[0].id).toBe("markdown");
    expect(r.filters[0].id).toBe("core-filter");
    expect(r.datasources[0].id).toBe("agent");
    expect(r.staleness).toBe("claims");
  });

  it("reads the config file from the store dir", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "files", priority: 100 }]);
    const r = await Registry.create({ root: dir });
    expect(r.databases.map((d) => d.id)).toEqual(["files"]);
    expect(r.formats.map((f) => f.id)).toEqual(["markdown"]);
    expect(r.filters.map((f) => f.id)).toEqual(["core-filter"]);
    expect(r.datasources.map((d) => d.id)).toEqual(["agent"]);
  });

  it("MEMOIZE_PLUGINS env overrides the config file", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "files", priority: 100 }]);
    process.env.MEMOIZE_PLUGINS = JSON.stringify([{ id: "agent", priority: 100 }]);
    const r = await Registry.create({
      root: dir,
      load: loaderFor([{ id: "agent", version: "1", type: "datasource" }]),
    });
    expect(r.datasources.map((d) => d.id)).toEqual(["agent"]);
    expect(r.databases.map((d) => d.id)).toEqual(["files"]);
  });

  it("--plugins CLI override wins over env and config", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "files", priority: 100 }]);
    process.env.MEMOIZE_PLUGINS = JSON.stringify([{ id: "agent", priority: 100 }]);
    const r = await Registry.create({
      root: dir,
      cliPlugins: JSON.stringify([{ id: "core-filter", priority: 100 }]),
      load: loaderFor([{ id: "core-filter", version: "1", type: "filter" }]),
    });
    expect(r.filters.map((f) => f.id)).toEqual(["core-filter"]);
    expect(r.databases.map((d) => d.id)).toEqual(["files"]);
  });

  it("MEMOIZE_STALENESS env overrides the config knob", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [], "strict");
    process.env.MEMOIZE_STALENESS = "cosmetic-only";
    const r = await Registry.create({ root: dir });
    expect(r.staleness).toBe("cosmetic-only");
  });

  it("rejects a broken config file", async () => {
    const dir = await tmpDir();
    await write(dir, ".agent-memoize/config.json", "{ nope");
    await expect(Registry.create({ root: dir })).rejects.toThrow(/config\.json/);
  });

  it("rejects duplicate ids and bad priorities", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [
      { id: "files", priority: 100 },
      { id: "files", priority: 50 },
    ]);
    await expect(Registry.create({ root: dir })).rejects.toThrow(/duplicate/);
    await writeConfig(dir, [{ id: "files", priority: "high" }]);
    await expect(Registry.create({ root: dir })).rejects.toThrow(/priority/);
  });

  it("rejects an unresolvable plugin id (fail fast)", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "no-such-plugin-xyz", priority: 100 }]);
    await expect(Registry.create({ root: dir })).rejects.toThrow(/cannot resolve plugin/);
  });

  it("rejects a plugin whose declared id does not match the config", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "a", priority: 100 }]);
    await expect(
      Registry.create({
        root: dir,
        load: async () => ({ id: "b", version: "1", type: "filter" }),
      }),
    ).rejects.toThrow(/different id/);
  });
});

describe("priority and lifecycle", () => {
  it("runs higher-priority plugins first within a type", async () => {
    const dir = await tmpDir();
    const order: string[] = [];
    const mk = (id: string, priority: number) => ({
      id,
      version: "1",
      type: "filter",
      async filter() {
        order.push(id);
        return arguments[1];
      },
    });
    await writeConfig(dir, [
      { id: "f-low", priority: 50 },
      { id: "f-high", priority: 200 },
    ]);
    const r = await Registry.create({ root: dir, load: loaderFor([mk("f-low", 50), mk("f-high", 200)]) });
    expect(r.filters.map((f) => f.id)).toEqual(["f-high", "core-filter", "f-low"]);
  });

  it("initializes databases first, then sources, formats, filters; shutdown is reverse", async () => {
    const dir = await tmpDir();
    const order: string[] = [];
    const mk = (id: string, type: string, priority: number): any => ({
      id,
      version: "1",
      type,
      async init() {
        order.push("init:" + id);
      },
      async shutdown() {
        order.push("shutdown:" + id);
      },
      async filter() {
        return arguments[1];
      },
    });
    await writeConfig(dir, [
      { id: "db", priority: 100 },
      { id: "ds", priority: 100 },
      { id: "fmt", priority: 100 },
      { id: "flt", priority: 100 },
    ]);
    const r = await Registry.create({
      root: dir,
      load: loaderFor([
        mk("db", "database", 100),
        mk("ds", "datasource", 100),
        mk("fmt", "format", 100),
        mk("flt", "filter", 100),
      ]),
    });
    expect(order).toEqual(["init:db", "init:ds", "init:fmt", "init:flt"]);
    await r.shutdown();
    expect(order.slice(4)).toEqual([
      "shutdown:flt",
      "shutdown:fmt",
      "shutdown:ds",
      "shutdown:db",
    ]);
  });

  it("gives plugins a namespaced tool registration surface", async () => {
    const dir = await tmpDir();
    const withTool = {
      id: "stats",
      version: "1",
      type: "filter",
      async init(ctx: any) {
        ctx.registerTool(
          "snapshot",
          { quiet: { optional: true } },
          async () => ({ snap: true }),
          "Takes a snapshot",
        );
      },
      async filter() {
        return arguments[1];
      },
    };
    await writeConfig(dir, [{ id: "stats", priority: 100 }]);
    const r = await Registry.create({ root: dir, load: loaderFor([withTool]) });
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].name).toBe("memoize_stats_snapshot");
    expect(r.tools[0].description).toBe("Takes a snapshot");
  });

  it("rejects duplicate tool registration from a plugin", async () => {
    const dir = await tmpDir();
    const dup = {
      id: "p1",
      version: "1",
      type: "filter",
      async init(ctx: any) {
        ctx.registerTool("same", {}, async () => ({}));
        ctx.registerTool("same", {}, async () => ({}));
      },
      async filter() {
        return arguments[1];
      },
    };
    await writeConfig(dir, [{ id: "p1", priority: 100 }]);
    await expect(
      Registry.create({ root: dir, load: loaderFor([dup]) }),
    ).rejects.toThrow(/collision/);
  });
});

describe("datasource, format and filter plugins", () => {
  it("datasource processUpdate can transform and reject input", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const ds = {
      id: "shouter",
      version: "1",
      type: "datasource",
      async processUpdate(args: any) {
        return { ...args, content: args.content.toUpperCase() };
      },
    };
    const reject = {
      id: "rejecter",
      version: "1",
      type: "datasource",
      async processUpdate() {
        return null;
      },
    };
    await writeConfig(dir, [{ id: "shouter", priority: 100 }]);
    const r = await Registry.create({ root: dir, load: loaderFor([ds]) });
    const res = await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "file",
      sources: ["a.txt"],
      content: "notes here",
      author: "t",
    });
    expect(res.ok).toBe(true);
    const stored = await r.primaryDb.readEntry("m");
    expect(stored!.content).toBe("NOTES HERE\n");

    await writeConfig(dir, [{ id: "rejecter", priority: 100 }]);
    const r2 = await Registry.create({ root: dir, load: loaderFor([reject]) });
    await expect(
      updateEntryCtx(ctxFor(r2, dir), {
        name: "m",
        kind: "decision",
        content: "x",
        author: "t",
      }),
    ).rejects.toThrow(/rejected/);
  });

  it("primary format render shapes recall content; secondary formats annotate", async () => {
    const dir = await tmpDir();
    const primary = {
      id: "fmt-a",
      version: "1",
      type: "format",
      prompt: "produce format a",
      render(entry: any) {
        return "RENDERED: " + entry.content;
      },
    };
    const secondary = {
      id: "fmt-b",
      version: "1",
      type: "format",
      prompt: "produce annotation b",
      render(entry: any) {
        return { wordCount: entry.content.split(" ").length };
      },
    };
    await writeConfig(dir, [
      { id: "fmt-b", priority: 100 },
      { id: "fmt-a", priority: 200 },
    ]);
    const r = await Registry.create({ root: dir, load: loaderFor([primary, secondary]) });
    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "one two three",
      author: "t",
    });
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("RENDERED: one two three\n");
    expect(rec.format).toEqual({ "fmt-b": { wordCount: 3 } });
  });

  it("filters run in priority order and can drop and annotate candidates", async () => {
    const dir = await tmpDir();
    const order: string[] = [];
    const drop = {
      id: "dropper",
      version: "1",
      type: "filter",
      async filter(_q: any, candidates: any[]) {
        order.push("dropper");
        return candidates.filter((c) => c.entry.name !== "keep-me-out");
      },
    };
    const annotate = {
      id: "ranker",
      version: "1",
      type: "filter",
      async filter(_q: any, candidates: any[]) {
        order.push("ranker");
        return candidates.map((c) => ({
          ...c,
          annotations: { ...c.annotations, score: 42 },
        }));
      },
    };
    await writeConfig(dir, [
      { id: "dropper", priority: 100 },
      { id: "ranker", priority: 300 },
    ]);
    const r = await Registry.create({ root: dir, load: loaderFor([drop, annotate]) });
    await updateEntryCtx(ctxFor(r, dir), { name: "keep-me-out", kind: "decision", content: "x", author: "t" });
    await updateEntryCtx(ctxFor(r, dir), { name: "keep", kind: "decision", content: "y", author: "t" });
    const idx = (await recallCtx(ctxFor(r, dir))) as any;
    expect(order).toEqual(["ranker", "dropper"]);
    expect(idx.entries.map((e: any) => e.name)).toEqual(["keep"]);
    expect(idx.entries[0].score).toBe(42);
  });

  it("database mirrors receive writes; a failing mirror only warns", async () => {
    const dir = await tmpDir();
    const mem = memoryDbPlugin();
    const broken = {
      id: "broken-mirror",
      version: "1",
      type: "database",
      async writeEntry() {
        throw new Error("disk full");
      },
      async deleteEntry() {
        return false;
      },
      async listEntries() {
        return { entries: [], invalid: [] };
      },
      async readEntry() {
        return null;
      },
      async loadManifest() {
        return { version: 1, entries: {} };
      },
      async saveManifest() {},
      async withLock(fn: any) {
        return fn();
      },
    };
    await writeConfig(dir, [
      { id: "agent-memoize-memory-db", priority: 200 },
      { id: "files", priority: 100 },
      { id: "broken-mirror", priority: 50 },
    ]);
    const r = await Registry.create({
      root: dir,
      load: loaderFor([mem, broken]),
    });
    expect(r.databases.map((d) => d.id)).toEqual([
      "agent-memoize-memory-db",
      "files",
      "broken-mirror",
    ]);
    const res = (await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    })) as any;
    expect(mem.entries.has("m")).toBe(true);
    expect(await r.primaryDb.readEntry("m")).not.toBeNull();
    // files mirror got the entry too
    expect((await r.databases[1].listEntries()).entries.map((e: any) => e.name)).toEqual(["m"]);
    expect(res.warnings).toEqual([expect.stringContaining("broken-mirror")]);
  });
});

describe("dynamic import of external plugins", () => {
  const memoryDbSource = [
    "export const plugin = {",
    "  id: \"agent-memoize-memory-db\", version: \"1.0.0\", type: \"database\",",
    "  entries: new Map(), manifest: { version: 1, entries: {} },",
    "  async init(ctx) { this.root = ctx.root; },",
    "  async listEntries() { return { entries: [...this.entries.values()], invalid: [] }; },",
    "  async readEntry(name) { return this.entries.get(name) ?? null; },",
    "  async writeEntry(e) { this.entries.set(e.name, e); },",
    "  async deleteEntry(name) { return this.entries.delete(name); },",
    "  async loadManifest() { return this.manifest; },",
    "  async saveManifest(m) { this.manifest = m; },",
    "  async withLock(fn) { return fn(); },",
    "};",
  ].join("\n");

  it("resolves an npm package from the project node_modules", async () => {
    const dir = await tmpDir();
    await write(dir, "package.json", "{}");
    const pkg = path.join(dir, "node_modules", "agent-memoize-memory-db");
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, "package.json"), "{\"type\":\"module\"}\n");
    await fs.writeFile(path.join(pkg, "index.js"), memoryDbSource);
    await writeConfig(dir, [{ id: "agent-memoize-memory-db", priority: 200 }]);
    const r = await Registry.create({ root: dir });
    expect(r.primaryDb.id).toBe("agent-memoize-memory-db");
    const res = await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    });
    expect(res.ok).toBe(true);
    expect(await r.primaryDb.readEntry("m")).not.toBeNull();
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("x");
  });

  it("loads an external module by absolute path (local dev)", async () => {
    const dir = await tmpDir();
    const mod = path.join(dir, "memory-db.mjs");
    await fs.writeFile(mod, memoryDbSource);
    await writeConfig(dir, [{ id: mod, priority: 100 }]);
    const r = await Registry.create({ root: dir });
    expect(r.primaryDb.id).toBe("agent-memoize-memory-db");
  });

  it("passes options to a plugin loaded by absolute path", async () => {
    const dir = await tmpDir();
    let seen: unknown;
    const mod = path.join(dir, "opt-plugin.mjs");
    await fs.writeFile(
      mod,
      "export const plugin = { id: \"opt-plugin\", version: \"1\", type: \"filter\", async init(ctx) { seen = ctx.options; }, async filter(_q, c) { return c; } };",
    );
    await writeConfig(dir, [{ id: mod, priority: 100, options: { threshold: 7 } }]);
    const r = await Registry.create({ root: dir, load: async (id) => {
      if (builtinById[id]) return builtinById[id];
      const m = (await import(id)) as { plugin: any };
      return { ...m.plugin, init: async (ctx: any) => { seen = ctx.options; } };
    } });
    expect(seen).toEqual({ threshold: 7 });
    expect(r.filters[0].id).toBe("opt-plugin");
  });
});
