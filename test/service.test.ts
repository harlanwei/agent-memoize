import { describe, expect, it } from "vitest";
import { invalidate, recall, updateEntry } from "../src/service.js";
import { loadManifest } from "./helpers.js";
import { tmpDir, write } from "./helpers.js";

const decision = {
  name: "decisions/small-prs",
  kind: "decision" as const,
  content: "user prefers small PRs",
  author: "test",
};

describe("updateEntry validation", () => {
  it("rejects invalid names, missing sources, and sources on decisions", async () => {
    const dir = await tmpDir();
    await expect(
      updateEntry(dir, { ...decision, name: "../evil" }),
    ).rejects.toThrow(/invalid entry name/);
    await expect(
      updateEntry(dir, { name: "a", kind: "file", content: "x", author: "t" }),
    ).rejects.toThrow(/sources/);
    await expect(
      updateEntry(dir, { ...decision, sources: ["a.ts"] }),
    ).rejects.toThrow(/no sources/);
  });

  it("warns when sources match no files", async () => {
    const dir = await tmpDir();
    const r = await updateEntry(dir, {
      name: "modules/ghost",
      kind: "file",
      sources: ["nope/**"],
      content: "x",
      author: "t",
    });
    expect(r.warning).toMatch(/matched no files/);
  });
});

describe("recall", () => {
  it("returns an index without content when no topic is given", async () => {
    const dir = await tmpDir();
    await updateEntry(dir, {
      ...decision,
      content: "user prefers small PRs\n\nVerbose rationale that must stay out of the index.",
    });
    const r = (await recall(dir)) as any;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      name: "decisions/small-prs",
      kind: "decision",
      stale: false,
    });
    expect(JSON.stringify(r)).not.toContain("Verbose rationale");
  });

  it("returns content when fresh, changedSources when stale", async () => {
    const dir = await tmpDir();
    await write(dir, "a.txt", "v1");
    await updateEntry(dir, {
      name: "a",
      kind: "file",
      sources: ["a.txt"],
      content: "notes about a",
      author: "t",
    });
    const fresh = (await recall(dir, "a")) as any;
    expect(fresh.stale).toBe(false);
    expect(fresh.content).toContain("notes about a");

    await new Promise((r) => setTimeout(r, 20));
    await write(dir, "a.txt", "v2");
    const stale = (await recall(dir, "a")) as any;
    expect(stale.stale).toBe(true);
    expect(stale.changedSources).toEqual(["a.txt"]);
    expect(stale.content).toBeUndefined();
  });

  it("reports unknown topics with the available list", async () => {
    const dir = await tmpDir();
    await updateEntry(dir, decision);
    const r = (await recall(dir, "nope")) as any;
    expect(r.error).toContain("nope");
    expect(r.available).toEqual(["decisions/small-prs"]);
  });

  it("returns empty state on a store-less project", async () => {
    const dir = await tmpDir();
    expect(await recall(dir)).toEqual({ state: "empty", entries: [] });
  });
});

describe("invalidate", () => {
  it("refuses without confirm=true", async () => {
    const dir = await tmpDir();
    await updateEntry(dir, decision);
    const r = await invalidate(dir, undefined, false);
    expect(r.ok).toBe(false);
    expect(((await recall(dir)) as any).entries).toHaveLength(1);
  });

  it("deletes one entry and prunes its baseline", async () => {
    const dir = await tmpDir();
    await updateEntry(dir, decision);
    await updateEntry(dir, { ...decision, name: "decisions/another", content: "y" });
    const r = await invalidate(dir, "decisions/small-prs", true);
    expect(r).toEqual({ ok: true, removed: ["decisions/small-prs"] });
    const idx = (await recall(dir)) as any;
    expect(idx.entries.map((e: any) => e.name)).toEqual(["decisions/another"]);
    expect((await loadManifest(dir)).entries["decisions/small-prs"]).toBeUndefined();
  });

  it("wipes all entries when no name is given", async () => {
    const dir = await tmpDir();
    await updateEntry(dir, decision);
    await updateEntry(dir, { ...decision, name: "decisions/another", content: "y" });
    const r = await invalidate(dir, undefined, true);
    expect(r.ok).toBe(true);
    expect((r as any).removed.sort()).toEqual(["decisions/another", "decisions/small-prs"]);
    expect(await recall(dir)).toEqual({ state: "empty", entries: [] });
  });
});
