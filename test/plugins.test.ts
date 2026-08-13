import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../src/plugins/registry.js";
import { invalidateCtx, recallCtx, statusCtx, updateEntryCtx } from "../src/service.js";
import type { ServiceContext } from "../src/service.js";
import { tmpDir, write } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctxFor(registry: Registry, root: string): ServiceContext {
  return { root, registry };
}

async function writeConfig(root: string, plugins: unknown, staleness?: string) {
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
    type: "ledger",
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

import { plugin as filesDb } from "../src/plugins/builtin/file-ledger.js";
import { plugin as markdownFmt } from "../src/plugins/builtin/markdown-writer.js";
import { plugin as stalenessFilter } from "../src/plugins/builtin/stale-filter.js";
import { plugin as agentDs } from "../src/plugins/builtin/agent-producer.js";
import { plugin as dreaming } from "../src/plugins/builtin/dream-organizer.js";

const builtinById: Record<string, any> = {
  "@naevic/agent-memoize/file-ledger": filesDb,
  "@naevic/agent-memoize/markdown-writer": markdownFmt,
  "@naevic/agent-memoize/stale-filter": stalenessFilter,
  "@naevic/agent-memoize/agent-producer": agentDs,
  "@naevic/agent-memoize/dream-organizer": dreaming,
};

/** The three required categories; tests add optional categories on top. */
const REQUIRED: Record<string, unknown[]> = {
  producers: [{ id: "@naevic/agent-memoize/agent-producer" }],
  writers: [{ id: "@naevic/agent-memoize/markdown-writer" }],
  ledgers: [{ id: "@naevic/agent-memoize/file-ledger" }],
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
    expect(r.primaryDb.id).toBe("@naevic/agent-memoize/file-ledger");
    expect(r.writers[0].id).toBe("@naevic/agent-memoize/markdown-writer");
    expect(r.filters[0].id).toBe("@naevic/agent-memoize/stale-filter");
    expect(r.producers[0].id).toBe("@naevic/agent-memoize/agent-producer");
    expect(r.organizers[0].id).toBe("@naevic/agent-memoize/dream-organizer");
    expect(r.staleness).toBe("selective");
  });

  it("reads the config file from the store dir", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, {
      ...REQUIRED,
      filters: [{ id: "@naevic/agent-memoize/stale-filter" }],
      organizers: [{ id: "@naevic/agent-memoize/dream-organizer" }],
      observers: [],
    });
    const r = await Registry.create({ root: dir });
    expect(r.ledgers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/file-ledger"]);
    expect(r.writers.map((f) => f.id)).toEqual(["@naevic/agent-memoize/markdown-writer"]);
    expect(r.filters.map((f) => f.id)).toEqual(["@naevic/agent-memoize/stale-filter"]);
    expect(r.producers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/agent-producer"]);
    expect(r.organizers.map((o) => o.id)).toEqual(["@naevic/agent-memoize/dream-organizer"]);
  });

  it("categories not configured fall back to their default built-in", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { writers: [{ id: "@naevic/agent-memoize/markdown-writer" }] });
    const r = await Registry.create({ root: dir });
    expect(r.writers.map((f) => f.id)).toEqual(["@naevic/agent-memoize/markdown-writer"]);
    expect(r.ledgers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/file-ledger"]);
    expect(r.producers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/agent-producer"]);
    expect(r.filters.map((f) => f.id)).toEqual(["@naevic/agent-memoize/stale-filter"]);
    expect(r.organizers.map((o) => o.id)).toEqual(["@naevic/agent-memoize/dream-organizer"]);
    expect(r.observers).toEqual([]);
  });

  it("an explicitly empty category stays empty", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ...REQUIRED, filters: [], organizers: [], observers: [] });
    const r = await Registry.create({ root: dir });
    expect(r.filters).toEqual([]);
    expect(r.organizers).toEqual([]);
    expect(r.observers).toEqual([]);
  });

  it("rejects a required category that is explicitly empty", async () => {
    const cases: [string, RegExp][] = [
      ["ledgers", /no ledger plugin enabled/],
      ["producers", /no producer plugin enabled/],
      ["writers", /no writer plugin enabled/],
    ];
    for (const [missing, re] of cases) {
      const dir = await tmpDir();
      const cfg: Record<string, unknown> = { ...REQUIRED };
      cfg[missing] = [];
      await writeConfig(dir, cfg);
      await expect(Registry.create({ root: dir })).rejects.toThrow(re);
    }
  });

  it("accepts a mix of single ledgers and ledger groups", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    const c = memoryDbPlugin("ledger-c");
    const d = memoryDbPlugin("ledger-d");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [
        { id: "ledger-a" },
        [{ id: "ledger-b" }, { id: "ledger-c" }],
        { id: "ledger-d" },
      ],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b, c, d]) });
    // a bare entry is a one-ledger group
    expect(r.ledgerGroups.map((g) => g.map((l) => l.id))).toEqual([
      ["ledger-a"],
      ["ledger-b", "ledger-c"],
      ["ledger-d"],
    ]);
    expect(r.primaryDb.id).toBe("ledger-a");
  });

  it("rejects an empty ledger group", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ledgers: [[]] });
    await expect(Registry.create({ root: dir })).rejects.toThrow(/ledger group 0 is empty/);
  });

  it("MEMOIZE_PLUGINS env overrides the config file", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ...REQUIRED });
    process.env.MEMOIZE_PLUGINS = JSON.stringify({ ...REQUIRED });
    const r = await Registry.create({
      root: dir,
      load: loaderFor([
        { id: "@naevic/agent-memoize/agent-producer", version: "1", type: "producer" },
        { id: "@naevic/agent-memoize/markdown-writer", version: "1", type: "writer" },
        { id: "@naevic/agent-memoize/file-ledger", version: "1", type: "ledger" },
      ]),
    });
    expect(r.producers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/agent-producer"]);
    expect(r.ledgers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/file-ledger"]);
  });

  it("--plugins CLI override wins over env and config", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ...REQUIRED });
    process.env.MEMOIZE_PLUGINS = JSON.stringify({ ...REQUIRED });
    const r = await Registry.create({
      root: dir,
      cliPlugins: JSON.stringify({
        ...REQUIRED,
        filters: [{ id: "@naevic/agent-memoize/stale-filter" }],
      }),
      load: loaderFor([
        { id: "@naevic/agent-memoize/stale-filter", version: "1", type: "filter" },
      ]),
    });
    expect(r.filters.map((f) => f.id)).toEqual(["@naevic/agent-memoize/stale-filter"]);
    expect(r.ledgers.map((d) => d.id)).toEqual(["@naevic/agent-memoize/file-ledger"]);
  });

  it("MEMOIZE_STALENESS env overrides the config knob", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ...REQUIRED }, "strict");
    process.env.MEMOIZE_STALENESS = "selective";
    const r = await Registry.create({ root: dir });
    expect(r.staleness).toBe("selective");
  });

  it("rejects an unknown staleness value in the config file", async () => {
    const dir = await tmpDir();
    for (const bad of ["claim", "claims", "cosmetic-only"]) {
      await writeConfig(dir, { ...REQUIRED }, bad);
      await expect(Registry.create({ root: dir })).rejects.toThrow(/must be one of/);
    }
  });

  it("rejects a broken config file", async () => {
    const dir = await tmpDir();
    await write(dir, ".agent-memoize/config.json", "{ nope");
    await expect(Registry.create({ root: dir })).rejects.toThrow(/config\.json/);
  });

  it("rejects duplicate ids", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, {
      ledgers: [
        { id: "@naevic/agent-memoize/file-ledger" },
        { id: "@naevic/agent-memoize/file-ledger" },
      ],
    });
    await expect(Registry.create({ root: dir })).rejects.toThrow(/duplicate/);
  });

  it("rejects an unresolvable plugin id (fail fast)", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { ledgers: [[{ id: "no-such-plugin-xyz" }]] });
    await expect(Registry.create({ root: dir })).rejects.toThrow(/cannot resolve plugin/);
  });

  it("rejects a flat plugins array (plugins must be grouped by category)", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, [{ id: "@naevic/agent-memoize/file-ledger" }]);
    await expect(Registry.create({ root: dir })).rejects.toThrow(
      /must be an object keyed by plugin category/,
    );
  });

  it("rejects a flat plugins array in MEMOIZE_PLUGINS", async () => {
    const dir = await tmpDir();
    process.env.MEMOIZE_PLUGINS = JSON.stringify([
      { id: "@naevic/agent-memoize/file-ledger" },
    ]);
    await expect(Registry.create({ root: dir })).rejects.toThrow(
      /must be an object keyed by plugin category/,
    );
  });

  it("rejects an unknown plugin category", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { storage: [{ id: "x" }] });
    await expect(Registry.create({ root: dir })).rejects.toThrow(
      /unknown plugin category: "storage"/,
    );
  });

  it("rejects a plugin category that is not an array", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, { filters: { id: "x" } });
    await expect(Registry.create({ root: dir })).rejects.toThrow(/must be an array/);
  });

  it("rejects a plugin configured under a category that does not match its type", async () => {
    const dir = await tmpDir();
    const misdirected = { id: "misdirected", version: "1", type: "ledger" };
    await writeConfig(dir, { filters: [{ id: "misdirected" }] });
    await expect(
      Registry.create({ root: dir, load: loaderFor([misdirected]) }),
    ).rejects.toThrow(/declares type "ledger" but is configured under "filter"/);
  });

  it("registers a plugin under its declared id even when the config id is a package name", async () => {
    const dir = await tmpDir();
    await writeConfig(dir, {
      ...REQUIRED,
      filters: [{ id: "@naevic/agent-memoize-plugin-example" }],
    });
    const r = await Registry.create({
      root: dir,
      load: async (id) => {
        if (id === "@naevic/agent-memoize-plugin-example") {
          return {
            id: "example",
            version: "1",
            type: "filter",
            async filter(_q, c) {
              return c;
            },
          };
        }
        if (builtinById[id]) return builtinById[id];
        throw new Error("missing plugin: " + id);
      },
    });
    expect(r.filters.map((f) => f.id)).toEqual(["example"]);
  });
});

describe("ordering and lifecycle", () => {
  it("runs plugins in config-array order within a category", async () => {
    const dir = await tmpDir();
    const mk = (id: string) => ({
      id,
      version: "1",
      type: "filter",
      async filter() {
        return arguments[1];
      },
    });
    await writeConfig(dir, {
      ...REQUIRED,
      filters: [{ id: "f-first" }, { id: "f-second" }],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([mk("f-first"), mk("f-second")]) });
    // Config order is preserved within a category; no built-in is appended.
    expect(r.filters.map((f) => f.id)).toEqual(["f-first", "f-second"]);
  });

  it("initializes ledgers first, then producers, writers, filters; shutdown is reverse", async () => {
    const dir = await tmpDir();
    const order: string[] = [];
    const mk = (id: string, type: string): any => ({
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
    await writeConfig(dir, {
      ledgers: [[{ id: "db" }]],
      producers: [{ id: "ds" }],
      writers: [{ id: "fmt" }],
      filters: [{ id: "flt" }],
    });
    const r = await Registry.create({
      root: dir,
      load: loaderFor([
        mk("db", "ledger"),
        mk("ds", "producer"),
        mk("fmt", "writer"),
        mk("flt", "filter"),
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
    await writeConfig(dir, { ...REQUIRED, filters: [{ id: "stats" }] });
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
    await writeConfig(dir, { ...REQUIRED, filters: [{ id: "p1" }] });
    await expect(
      Registry.create({ root: dir, load: loaderFor([dup]) }),
    ).rejects.toThrow(/collision/);
  });
});

describe("producer, writer and filter plugins", () => {
  it("datasource processUpdate can transform and reject input", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const ds = {
      id: "shouter",
      version: "1",
      type: "producer",
      async processUpdate(args: any) {
        return { ...args, content: args.content.toUpperCase() };
      },
    };
    const reject = {
      id: "rejecter",
      version: "1",
      type: "producer",
      async processUpdate() {
        return null;
      },
    };
    await writeConfig(dir, { ...REQUIRED, producers: [{ id: "shouter" }] });
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

    await writeConfig(dir, { ...REQUIRED, producers: [{ id: "rejecter" }] });
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

  it("primary writer render shapes recall content; secondary writers annotate", async () => {
    const dir = await tmpDir();
    const primary = {
      id: "fmt-a",
      version: "1",
      type: "writer",
      prompt: "produce format a",
      render(entry: any) {
        return "RENDERED: " + entry.content;
      },
    };
    const secondary = {
      id: "fmt-b",
      version: "1",
      type: "writer",
      prompt: "produce annotation b",
      render(entry: any) {
        return { wordCount: entry.content.split(" ").length };
      },
    };
    await writeConfig(dir, { ...REQUIRED, writers: [{ id: "fmt-a" }, { id: "fmt-b" }] });
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

  it("filters run in config order and can drop and annotate candidates", async () => {
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
    await writeConfig(dir, { ...REQUIRED, filters: [{ id: "ranker" }, { id: "dropper" }] });
    const r = await Registry.create({ root: dir, load: loaderFor([drop, annotate]) });
    await updateEntryCtx(ctxFor(r, dir), { name: "keep-me-out", kind: "decision", content: "x", author: "t" });
    await updateEntryCtx(ctxFor(r, dir), { name: "keep", kind: "decision", content: "y", author: "t" });
    const idx = (await recallCtx(ctxFor(r, dir))) as any;
    expect(order).toEqual(["ranker", "dropper"]);
    expect(idx.entries.map((e: any) => e.name)).toEqual(["keep"]);
    expect(idx.entries[0].score).toBe(42);
  });

  it("writes go only to the first ledger; ledgers keep their group structure", async () => {
    const dir = await tmpDir();
    const mem = memoryDbPlugin();
    const second = memoryDbPlugin("second-ledger");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "agent-memoize-memory-db" }], [{ id: "second-ledger" }]],
    });
    const r = await Registry.create({
      root: dir,
      load: loaderFor([mem, second]),
    });
    expect(r.ledgers.map((d) => d.id)).toEqual([
      "agent-memoize-memory-db",
      "second-ledger",
    ]);
    expect(r.ledgerGroups.map((g) => g.map((l) => l.id))).toEqual([
      ["agent-memoize-memory-db"],
      ["second-ledger"],
    ]);
    const res = (await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    })) as any;
    expect(res.ok).toBe(true);
    expect(mem.entries.has("m")).toBe(true);
    expect(await r.primaryDb.readEntry("m")).not.toBeNull();
    // the other group's ledger received nothing
    expect(second.entries.has("m")).toBe(false);
    expect(res.warnings).toBeUndefined();
    await invalidateCtx(ctxFor(r, dir), "m", true);
    expect(mem.entries.has("m")).toBe(false);
  });
});

describe("dynamic import of external plugins", () => {
  const memoryDbSource = [
    "export const plugin = {",
    "  id: \"agent-memoize-memory-db\", version: \"1.0.0\", type: \"ledger\",",
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
    await writeConfig(dir, { ...REQUIRED, ledgers: [[{ id: "agent-memoize-memory-db" }]] });
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
    await writeConfig(dir, { ...REQUIRED, ledgers: [[{ id: mod }]] });
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
    await writeConfig(dir, { ...REQUIRED, filters: [{ id: mod, options: { threshold: 7 } }] });
    const r = await Registry.create({ root: dir, load: async (id) => {
      if (builtinById[id]) return builtinById[id];
      const m = (await import(id)) as { plugin: any };
      return { ...m.plugin, init: async (ctx: any) => { seen = ctx.options; } };
    } });
    expect(seen).toEqual({ threshold: 7 });
    expect(r.filters[0].id).toBe("opt-plugin");
  });
});

describe("ledger groups", () => {
  function seed(db: any, name: string, content: string): void {
    db.entries.set(name, {
      name,
      kind: "decision",
      sources: [],
      author: "t",
      updated: "",
      summary: "",
      content,
    });
  }

  it("front ledger wins when a group's ledgers contradict", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    seed(a, "m", "FROM-A");
    seed(b, "m", "FROM-B");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "ledger-a" }, { id: "ledger-b" }]],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b]) });
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("FROM-A");
  });

  it("continues to the next group when the first lacks the topic", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    seed(a, "x", "X");
    seed(b, "m", "FROM-B");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "ledger-a" }], [{ id: "ledger-b" }]],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b]) });
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("FROM-B");
  });

  it("continues to the next group when the filter drops the first group's candidate", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    seed(a, "m", "FROM-A");
    seed(b, "m", "FROM-B");
    const dropper = {
      id: "dropper",
      version: "1",
      type: "filter",
      async filter(_q: any, candidates: any[]) {
        return candidates.filter((c: any) => c.entry.content !== "FROM-A");
      },
    };
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "ledger-a" }], [{ id: "ledger-b" }]],
      filters: [{ id: "dropper" }],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b, dropper]) });
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("FROM-B");
  });

  it("index recall returns the first group with surviving candidates", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    seed(a, "x", "X");
    seed(b, "y", "Y");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "ledger-a" }], [{ id: "ledger-b" }]],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b]) });
    const idx = (await recallCtx(ctxFor(r, dir))) as any;
    expect(idx.entries.map((e: any) => e.name)).toEqual(["x"]);
  });

  it("status merges staleness across ledgers", async () => {
    const dir = await tmpDir();
    const a = memoryDbPlugin("ledger-a");
    const b = memoryDbPlugin("ledger-b");
    await writeConfig(dir, {
      ...REQUIRED,
      ledgers: [[{ id: "ledger-a" }], [{ id: "ledger-b" }]],
    });
    const r = await Registry.create({ root: dir, load: loaderFor([a, b]) });
    await updateEntryCtx(ctxFor(r, dir), {
      name: "k",
      kind: "decision",
      content: "ok",
      author: "t",
    });
    // a suspended entry living only in the second ledger
    b.entries.set("gone", {
      name: "gone",
      kind: "file",
      sources: ["nope/**"],
      author: "t",
      updated: "",
      summary: "",
      content: "x",
    });
    const st = (await statusCtx(ctxFor(r, dir))) as any;
    expect(st.state).toBe("stale");
    expect(st.suspendedEntries).toEqual(["gone"]);
  });
});
