import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidName,
  matchesAny,
  parseEntry,
  serializeEntry,
  storePath,
  walkTree,
  withLock,
} from "../src/store.js";
import { tmpDir, write } from "./helpers.js";

describe("entry front matter", () => {
  it("roundtrips a file entry", () => {
    const e = {
      name: "modules/auth",
      kind: "file" as const,
      sources: ["src/auth/**"],
      author: "claude-code",
      updated: "2026-01-01T00:00:00.000Z",
      summary: "auth notes",
      content: "# Auth\n\nJWT middleware.",
    };
    const parsed = parseEntry(e.name, serializeEntry(e));
    expect(parsed).toMatchObject({
      name: e.name,
      kind: e.kind,
      sources: e.sources,
      author: e.author,
      updated: e.updated,
      summary: e.summary,
    });
    expect(parsed.content.trim()).toBe(e.content);
  });

  it("roundtrips a decision entry", () => {
    const e = {
      name: "decisions/no-classes",
      kind: "decision" as const,
      sources: [],
      author: "codex",
      updated: "2026-01-01T00:00:00.000Z",
      summary: "prefer functions",
      content: "User prefers plain functions over classes.",
    };
    expect(parseEntry(e.name, serializeEntry(e))).toMatchObject({
      kind: "decision",
      sources: [],
      author: "codex",
    });
  });

  it("rejects missing front matter and file entries without sources", () => {
    expect(() => parseEntry("x", "just markdown")).toThrow();
    expect(() => parseEntry("x", "---\nkind: file\n---\nbody\n")).toThrow();
  });
});

describe("isValidName", () => {
  it("accepts path-like names", () => {
    expect(isValidName("project")).toBe(true);
    expect(isValidName("modules/auth-2_x")).toBe(true);
  });
  it("rejects traversal, dots, uppercase, spaces", () => {
    expect(isValidName("../etc")).toBe(false);
    expect(isValidName("a/../b")).toBe(false);
    expect(isValidName("a b")).toBe(false);
    expect(isValidName("Auth")).toBe(false);
    expect(isValidName("")).toBe(false);
  });
});

describe("walkTree", () => {
  it("skips .git, node_modules and the store", async () => {
    const dir = await tmpDir();
    await write(dir, "src/a.ts", "a");
    await write(dir, ".git/objects/x", "x");
    await write(dir, "node_modules/y/z.js", "z");
    await write(dir, ".agent-memoize/project.md", "p");
    expect(await walkTree(dir)).toEqual(["src/a.ts"]);
  });
});

describe("matchesAny", () => {
  it("matches nested globs and dotfiles", () => {
    expect(matchesAny(["src/auth/**"], "src/auth/deep/login.ts")).toBe(true);
    expect(matchesAny(["src/auth/**"], "src/other.ts")).toBe(false);
    expect(matchesAny([".*rc"], ".eslintrc")).toBe(true);
  });
});

describe("withLock", () => {
  it("reclaims a stale lock and releases after use", async () => {
    const dir = await tmpDir();
    await fs.mkdir(storePath(dir), { recursive: true });
    const lock = path.join(storePath(dir), ".lock");
    await fs.mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    await withLock(dir, async () => {
      /* critical section */
    });
    await expect(fs.stat(lock)).rejects.toThrow();
  });
});
