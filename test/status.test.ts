import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateEntry } from "../src/service.js";
import { computeStatusForRoot as computeStatus } from "../src/status.js";
import { commitAll, gitRepo, tmpDir, write } from "./helpers.js";

const authEntry = {
  name: "modules/auth",
  kind: "file" as const,
  sources: ["src/auth/**"],
  content: "auth module notes",
  author: "test",
};

describe("git mode", () => {
  it("is fresh right after update", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.mode).toBe("git");
  });

  it("detects an uncommitted (dirty) change to a sourced file", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    await write(dir, "src/auth/login.ts", "login v2");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.changedFiles).toContain("src/auth/login.ts");
    expect(s.staleEntries.map((e) => e.name)).toContain("modules/auth");
    expect(s.staleEntries[0].changedSources).toEqual(["src/auth/login.ts"]);
  });

  it("detects a committed change to a sourced file", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    await write(dir, "src/auth/login.ts", "login v2");
    await commitAll(dir, "change login");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries.map((e) => e.name)).toContain("modules/auth");
  });

  it("ignores changes to files outside every entry's sources", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    await write(dir, "src/unrelated.ts", "unrelated");
    await commitAll(dir, "unrelated");
    expect((await computeStatus(dir)).state).toBe("fresh");
  });

  it("never invalidates decision entries on file changes", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, {
      name: "decisions/no-classes",
      kind: "decision",
      content: "user prefers functions",
      author: "test",
    });
    await write(dir, "src/auth/login.ts", "login v2");
    await commitAll(dir, "change");
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
  });

  it("detects a second edit to a file that was already dirty at update time", async () => {
    // head and dirty list are identical before/after the second edit —
    // only the per-file content hash can catch this case.
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await write(dir, "src/auth/login.ts", "v2 dirty");
    await updateEntry(dir, authEntry); // baseline taken while the file is dirty
    expect((await computeStatus(dir)).state).toBe("fresh");
    await write(dir, "src/auth/login.ts", "v3 dirty again");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries.map((e) => e.name)).toContain("modules/auth");
  });

  it("tracks entries independently: updating one does not un-stale another", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    await updateEntry(dir, { ...authEntry, name: "modules/auth-copy" });
    await write(dir, "src/auth/login.ts", "login v2");
    let s = await computeStatus(dir);
    expect(s.staleEntries.map((e) => e.name).sort()).toEqual([
      "modules/auth",
      "modules/auth-copy",
    ]);
    await updateEntry(dir, authEntry); // re-derive only one of them
    s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries.map((e) => e.name)).toEqual(["modules/auth-copy"]);
  });

  it("marks an entry stale when a new file appears inside its sources glob", async () => {
    const dir = await gitRepo();
    await write(dir, "src/auth/login.ts", "login v1");
    await commitAll(dir);
    await updateEntry(dir, authEntry);
    await write(dir, "src/auth/session.ts", "new file"); // untracked
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.changedFiles).toContain("src/auth/session.ts");
  });
});

describe("hash mode (no git)", () => {
  it("detects edits visible via mtime", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", "login v1");
    await updateEntry(dir, authEntry);
    await new Promise((r) => setTimeout(r, 20));
    await write(dir, "src/auth/login.ts", "login v2");
    expect((await computeStatus(dir)).state).toBe("stale");
    expect((await computeStatus(dir)).mode).toBe("hash");
  });

  it("detects content edits hidden behind identical mtime+size", async () => {
    const dir = await tmpDir();
    const rel = "src/auth/login.ts";
    await write(dir, rel, "aaa");
    await updateEntry(dir, authEntry);
    const st = await fs.stat(path.join(dir, rel));
    await write(dir, rel, "bbb"); // same size
    await fs.utimes(path.join(dir, rel), st.atime, st.mtime); // same mtime
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.changedFiles).toContain(rel);
  });

  it("detects deleted sourced files", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", "login v1");
    await updateEntry(dir, authEntry);
    await fs.rm(path.join(dir, "src/auth/login.ts"));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.deletedFiles).toContain("src/auth/login.ts");
  });
});
