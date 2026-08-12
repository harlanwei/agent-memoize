import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../src/plugins/registry.js";
import { invalidateCtx, recallCtx, statusCtx, updateEntryCtx } from "../src/service.js";
import type { ServiceContext } from "../src/service.js";
import { tmpDir, write } from "./helpers.js";
import { plugin as filesDb } from "../src/plugins/builtin/db-files.js";
import { plugin as markdownFmt } from "../src/plugins/builtin/format-markdown.js";
import { plugin as coreFilter } from "../src/plugins/builtin/filter-core.js";
import { plugin as agentDs } from "../src/plugins/builtin/datasource-agent.js";
import { plugin as dreaming } from "../packages/agent-memoize-plugin-dreaming/src/index.js";
import {
  logs as dashboardLogs,
  plugin as dashboard,
  url as dashboardUrl,
} from "../packages/agent-memoize-plugin-dashboard/src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function writeConfig(root: string, plugins: unknown[], staleness = "strict") {
  await write(
    root,
    ".agent-memoize/config.json",
    JSON.stringify({ version: 1, plugins, staleness }),
  );
}

const defaultPlugins = [
  { id: "files" },
  { id: "markdown" },
  { id: "core-filter" },
  { id: "agent" },
];

function ctxFor(registry: Registry, root: string): ServiceContext {
  return { root, registry };
}

async function makeRegistry(
  root: string,
  extras: any[],
  opts?: { staleness?: string; plugins?: unknown[] },
): Promise<Registry> {
  const cfg =
    opts?.plugins ?? [...defaultPlugins, ...extras.map((p) => ({ id: p.id }))];
  await writeConfig(root, cfg as unknown[], opts?.staleness ?? "strict");
  return Registry.create({ root, load: loaderFor(extras) });
}

afterEach(async () => {
  delete process.env.MEMOIZE_PLUGINS;
  delete process.env.MEMOIZE_STALENESS;
});

describe("postprocessing plugin type", () => {
  it("runs in config order and annotates the status result", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const order: string[] = [];
    const mk = (id: string, tag: string) => ({
      id,
      version: "1",
      type: "postprocessing",
      async postprocess(op: string, result: any) {
        order.push(id);
        return { ...result, [tag]: `${op}:${id}` };
      },
    });
    await writeConfig(dir, [
      ...defaultPlugins,
      { id: "pp-high" },
      { id: "pp-low" },
    ]);
    const r = await Registry.create({
      root: dir,
      load: loaderFor([mk("pp-high", "high"), mk("pp-low", "low")]),
    });
    expect(r.postprocessors.map((p) => p.id)).toEqual(["pp-high", "pp-low"]);
    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "file",
      sources: ["a.txt"],
      content: "x",
      author: "t",
    });
    order.length = 0;
    const st = (await statusCtx(ctxFor(r, dir))) as any;
    expect(order).toEqual(["pp-high", "pp-low"]);
    expect(st.low).toBe("status:pp-low");
    expect(st.high).toBe("status:pp-high");
  });

  it("chains output: each plugin sees the previous plugin's result", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const seen: string[] = [];
    const mk = (id: string, tag: string) => ({
      id,
      version: "1",
      type: "postprocessing",
      async postprocess(_op: string, result: any) {
        seen.push(`${id}:${result[tag]}`);
        return { ...result, [tag]: id };
      },
    });
    const r = await makeRegistry(dir, [mk("a", "ok"), mk("b", "ok")]);
    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "file",
      sources: ["a.txt"],
      content: "x",
      author: "t",
    });
    expect(seen).toEqual(["a:true", "b:a"]);
  });

  it("a plugin can replace the result entirely", async () => {
    const dir = await tmpDir();
    const replacer = {
      id: "replacer",
      version: "1",
      type: "postprocessing",
      async postprocess() {
        return { replaced: true };
      },
    };
    const r = await makeRegistry(dir, [replacer]);
    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    });
    const rec = (await recallCtx(ctxFor(r, dir))) as any;
    expect(rec).toEqual({ replaced: true });
  });

  it("postprocesses update and invalidate results too", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const tags: string[] = [];
    const annotate = {
      id: "annotate",
      version: "1",
      type: "postprocessing",
      async postprocess(op: string, result: any) {
        tags.push(op);
        return { ...result, note: op };
      },
    };
    const r = await makeRegistry(dir, [annotate]);
    const upd = (await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "file",
      sources: ["a.txt"],
      content: "x",
      author: "t",
    })) as any;
    expect(upd).toMatchObject({ ok: true, note: "update" });
    const inv = (await invalidateCtx(ctxFor(r, dir), "m", true)) as any;
    expect(inv).toMatchObject({ ok: true, removed: ["m"], note: "invalidate" });
    expect(tags).toEqual(["update", "invalidate"]);
  });

  it("returns undefined to leave the result unchanged", async () => {
    const dir = await tmpDir();
    const inert = {
      id: "inert",
      version: "1",
      type: "postprocessing",
      async postprocess() {},
    };
    const r = await makeRegistry(dir, [inert]);
    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    });
    const rec = (await recallCtx(ctxFor(r, dir), "m")) as any;
    expect(rec.content).toBe("x\n");
    expect(rec.note).toBeUndefined();
  });
});

describe("dreaming plugin", () => {
  it("stays quiet below the threshold (default 15)", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const r = await makeRegistry(dir, [dreaming]);
    const ctx = ctxFor(r, dir);
    await updateEntryCtx(ctx, {
      name: "m1",
      kind: "file",
      sources: ["a.txt"],
      content: "c1",
      author: "t",
    });
    await updateEntryCtx(ctx, {
      name: "m2",
      kind: "file",
      sources: ["a.txt"],
      content: "c2",
      author: "t",
    });
    let st = (await statusCtx(ctx)) as any;
    expect(st.dreaming).toBeUndefined();
    await write(dir, "a.txt", "changed\n");
    st = (await statusCtx(ctx)) as any;
    expect(st.dreaming).toBeUndefined();
    expect(st.staleEntries).toHaveLength(2);
  });

  it("annotates status with a dreaming plan once stale memories reach the threshold", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const r = await makeRegistry(dir, [dreaming], {
      plugins: [
        ...defaultPlugins,
        { id: "dreaming", options: { threshold: 2 } },
      ],
    });
    for (const n of ["m1", "m2"]) {
      await updateEntryCtx(ctxFor(r, dir), {
        name: n,
        kind: "file",
        sources: ["a.txt"],
        content: "c-" + n,
        author: "t",
      });
    }
    await write(dir, "a.txt", "changed\n");
    const st = (await statusCtx(ctxFor(r, dir))) as any;
    expect(st.dreaming).toEqual({
      count: 2,
      threshold: 2,
      stale: ["m1", "m2"],
      suspended: [],
      guidance: expect.stringContaining("spawn subagents"),
    });
  });

  it("counts suspended memories and leaves other operations untouched", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const r = await makeRegistry(dir, [dreaming], {
      plugins: [
        ...defaultPlugins,
        { id: "dreaming", options: { threshold: 1 } },
      ],
    });
    const ctx = ctxFor(r, dir);
    await updateEntryCtx(ctx, {
      name: "gone",
      kind: "file",
      sources: ["a.txt"],
      content: "c",
      author: "t",
    });
    await fs.rm(path.join(dir, "a.txt"));
    const st = (await statusCtx(ctx)) as any;
    expect(st.suspendedEntries).toEqual(["gone"]);
    expect(st.dreaming).toMatchObject({ count: 1, suspended: ["gone"] });

    const rec = (await recallCtx(ctx, "gone")) as any;
    expect(rec.dreaming).toBeUndefined();
    const upd = (await updateEntryCtx(ctx, {
      name: "gone",
      kind: "file",
      sources: ["a.txt"],
      content: "c2",
      author: "t",
    })) as any;
    expect(upd.dreaming).toBeUndefined();
  });
});

describe("debugging plugin type", () => {
  it("fires onMemoryCreated with create vs refresh", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const events: { entry: any; op: string; accessor: string }[] = [];
    const watcher = {
      id: "watcher",
      version: "1",
      type: "debugging",
      async onMemoryCreated(entry: any, op: string, accessor: string) {
        events.push({ entry, op, accessor });
      },
    };
    const r = await makeRegistry(dir, [watcher]);
    const ctx = ctxFor(r, dir);
    await updateEntryCtx(ctx, { name: "m", kind: "file", sources: ["a.txt"], content: "v1", author: "t" });
    await updateEntryCtx(
      { ...ctx, accessor: "claude-code" },
      { name: "m", kind: "file", sources: ["a.txt"], content: "v2", author: "claude-code" },
    );
    expect(events.map((e) => e.op)).toEqual(["create", "refresh"]);
    expect(events[0].accessor).toBe("unknown");
    expect(events[1].accessor).toBe("claude-code");
    expect(events[0].entry).toMatchObject({ name: "m", author: "t", content: "v1" });
  });

  it("fires onMemoryAccessed for index, topic and missing lookups", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const accesses: any[] = [];
    const watcher = {
      id: "watcher",
      version: "1",
      type: "debugging",
      async onMemoryAccessed(access: any) {
        accesses.push(access);
      },
    };
    const r = await makeRegistry(dir, [watcher]);
    const ctx = ctxFor(r, dir);
    await updateEntryCtx(ctx, { name: "m", kind: "file", sources: ["a.txt"], content: "v", author: "t" });

    const idx = (await recallCtx(ctx)) as any;
    expect(idx.entries).toHaveLength(1);
    const topic = (await recallCtx(ctx, "m")) as any;
    expect(topic.content).toBe("v\n");
    const missing = (await recallCtx(ctx, "nope")) as any;
    expect(missing.error).toMatch(/no entry/);

    expect(accesses).toEqual([
      { accessor: "unknown", entries: [{ name: "m", status: "fresh" }] },
      { accessor: "unknown", topic: "m", entries: [{ name: "m", status: "fresh" }] },
      { accessor: "unknown", topic: "nope", entries: [{ name: "nope", status: "missing" }] },
    ]);
  });

  it("a failing debugging hook never breaks the operation", async () => {
    const dir = await tmpDir();
    const broken = {
      id: "broken",
      version: "1",
      type: "debugging",
      async onMemoryCreated() {
        throw new Error("boom");
      },
    };
    const r = await makeRegistry(dir, [broken]);
    const res = (await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "decision",
      content: "x",
      author: "t",
    })) as any;
    expect(res.ok).toBe(true);
  });
});

describe("dashboard plugin", () => {
  afterEach(async () => {
    if (dashboardUrl()) {
      await dashboard.shutdown?.();
    }
  });

  it("logs memory creation and access, and serves them over HTTP", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const r = await makeRegistry(dir, [dashboard], {
      plugins: [
        ...defaultPlugins,
        { id: "dashboard", options: { port: 0, maxLogs: 10 } },
      ],
    });
    const ctx = ctxFor(r, dir);
    const base = dashboardUrl();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await (await fetch(base + "/")).text();
    expect(page).toContain("agent-memoize activity");
    // The page's inline script must be valid JavaScript (it broke once: unescaped
    // quotes in the served HTML made Firefox throw "unexpected token: identifier").
    const script = page.slice(page.indexOf("<script>") + 8, page.indexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();

    await updateEntryCtx(ctx, { name: "m", kind: "file", sources: ["a.txt"], content: "v", author: "t" });
    await recallCtx(ctx, "m");

    const api = (await (await fetch(base + "/api/logs")).json()) as any;
    expect(api.project).toBe(dir);
    expect(api.logs.map((l: any) => l.event)).toEqual(["memory.created", "memory.accessed"]);
    expect(api.logs[0].id).toBe(`${process.pid}.1`);
    expect(api.logs[0].data).toMatchObject({
      operation: "create",
      accessor: "unknown",
      entry: { name: "m" },
    });
    expect(api.logs[1].data).toMatchObject({ accessor: "unknown", topic: "m", entries: [{ name: "m", status: "fresh" }] });
    expect(dashboardLogs()).toHaveLength(2);

    await sleep(100);
    const file = path.join(dir, ".agent-memoize", "logs", "dashboard.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("memory.created");

    await r.shutdown();
    expect(dashboardUrl()).toBe("");
  });

  it("loads history from the JSONL file on startup, continuing ids", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const logPath = path.join(dir, ".agent-memoize", "logs", "dashboard.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ id: 1, ts: "2026-08-12T00:00:00.000Z", event: "memory.created", data: { operation: "create", entry: { name: "old" } } }),
        JSON.stringify({ id: 2, ts: "2026-08-12T00:00:01.000Z", event: "memory.accessed", data: { topic: "old", entries: [{ name: "old", status: "fresh" }] } }),
        "this line is corrupt from a crash\n",
      ].join("\n"),
    );

    const r = await makeRegistry(dir, [dashboard], {
      plugins: [
        ...defaultPlugins,
        { id: "dashboard", options: { port: 0 } },
      ],
    });
    const base = dashboardUrl();

    const api = (await (await fetch(base + "/api/logs")).json()) as any;
    expect(api.logs.map((l: any) => l.event)).toEqual(["memory.created", "memory.accessed"]);
    expect(api.logs[1].data.topic).toBe("old");

    await updateEntryCtx(ctxFor(r, dir), {
      name: "m",
      kind: "file",
      sources: ["a.txt"],
      content: "v",
      author: "t",
    });
    const api2 = (await (await fetch(base + "/api/logs")).json()) as any;
    expect(api2.logs).toHaveLength(3);
    expect(api2.logs[2].id).toBe(`${process.pid}.1`);
    expect(api2.logs[2].data.entry.name).toBe("m");

    await r.shutdown();
  });

  it("picks up records appended to the JSONL by another process", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const r = await makeRegistry(dir, [dashboard], {
      plugins: [
        ...defaultPlugins,
        { id: "dashboard", options: { port: 0 } },
      ],
    });
    const base = dashboardUrl();
    expect(await apiEmpty(base)).toBe(true);

    const logPath = path.join(dir, ".agent-memoize", "logs", "dashboard.jsonl");
    await fs.appendFile(
      logPath,
      JSON.stringify({
        id: "99999.1",
        ts: "2026-08-12T00:00:00.000Z",
        event: "memory.created",
        data: { operation: "create", accessor: "codex", entry: { name: "from-another-agent" } },
      }) + "\n",
    );

    const api = (await (await fetch(base + "/api/logs")).json()) as any;
    expect(api.logs).toHaveLength(1);
    expect(api.logs[0].id).toBe("99999.1");
    expect(api.logs[0].data.accessor).toBe("codex");

    await r.shutdown();
  });

  it("sibling instance: shares the port, logs anyway, and the running dashboard shows it", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "hello\n");
    const mkConfig = (port: number) => [
      ...defaultPlugins,
      { id: "dashboard", options: { port } },
    ];
    const rA = await makeRegistry(dir, [dashboard], { plugins: mkConfig(0) });
    const baseA = dashboardUrl();
    const portA = Number(new URL(baseA).port);

    const rB = await makeRegistry(dir, [dashboard], { plugins: mkConfig(portA) });
    expect(dashboardUrl()).toBe(baseA); // no second HTTP instance

    await updateEntryCtx(
      { root: dir, registry: rB, accessor: "codex" },
      { name: "m", kind: "file", sources: ["a.txt"], content: "v", author: "codex" },
    );
    await sleep(100);

    const api = (await (await fetch(baseA + "/api/logs")).json()) as any;
    expect(api.project).toBe(dir);
    const created = api.logs.filter((l: any) => l.event === "memory.created");
    expect(created).toHaveLength(1);
    expect(created[0].data).toMatchObject({ operation: "create", accessor: "codex", entry: { name: "m" } });

    const file = path.join(dir, ".agent-memoize", "logs", "dashboard.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]).data.accessor).toBe("codex");

    await rA.shutdown();
    await rB.shutdown();
  });
});

async function apiEmpty(base: string): Promise<boolean> {
  const api = (await (await fetch(base + "/api/logs")).json()) as any;
  return api.logs.length === 0;
}
