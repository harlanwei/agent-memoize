import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateEntry } from "../src/service.js";
import { computeStatusForRoot as computeStatus } from "../src/status.js";
import { claimLines, extractTokens, normalizeContent, storePath } from "../src/workspace.js";
import { tmpDir, write } from "./helpers.js";

// File whose content shares tokens with the entry text, so claim regions exist.
const LOGIN_SRC = [
  "import jwt from \"jsonwebtoken\";",
  "",
  "export function login(user, password) {",
  "  return jwt.sign({ user });",
  "}",
].join("\n");

const entry = {
  name: "modules/auth",
  kind: "file" as const,
  sources: ["src/auth/login.ts"],
  content: "Auth login uses jwt middleware.",
  author: "test",
};

async function setup() {
  const dir = await tmpDir();
  await write(dir, "src/auth/login.ts", LOGIN_SRC);
  await updateEntry(dir, entry);
  return dir;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  delete process.env.MEMOIZE_STALENESS;
});

describe("claim extraction", () => {
  it("finds tokens and claim lines in source files", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", LOGIN_SRC);
    const tokens = extractTokens("Auth login uses jsonwebtoken middleware.");
    expect(tokens.has("login")).toBe(true);
    expect(tokens.has("jsonwebtoken")).toBe(true);
    expect(tokens.has("uses")).toBe(false); // stopword
    const claims = await claimLines(dir, "a.ts", "Auth login uses jsonwebtoken middleware.");
    expect(claims.map((c) => c.line)).toEqual([1, 3]);
  });

  it("normalizeContent strips trailing whitespace and blank lines", () => {
    const n = normalizeContent("a  \n\n\nb\t\n", { ignoreComments: false, ext: ".ts" });
    expect(n).toBe("a\nb");
  });

  it("normalizeContent drops comment-only lines when ignoreComments is set", () => {
    const n = normalizeContent("// comment\na\n/* block\nstill\n*/\nb\n# not-a-comment\n", {
      ignoreComments: true,
      ext: ".ts",
    });
    expect(n).toBe("a\nb\n# not-a-comment");
  });
});

describe("staleness matrix (claims policy, default)", () => {
  it("stays fresh on a cosmetic edit (trailing whitespace)", async () => {
    const dir = await setup();
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("});", "});  "));
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.cosmeticChanges).toContain("src/auth/login.ts");
  });

  it("auto re-baselines on a non-claim substantive edit", async () => {
    const dir = await setup();
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC + "\n// unrelated helper note\n");
    let s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.verifiedEntries).toContain("modules/auth");
    // Re-baselined: a second identical run no longer reports verified.
    s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.verifiedEntries).toEqual([]);
  });

  it("stays fresh when lines are inserted (claim lines shift)", async () => {
    const dir = await setup();
    await tick();
    const withHeader = "// session header\n" + LOGIN_SRC;
    await write(dir, "src/auth/login.ts", withHeader);
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.verifiedEntries).toContain("modules/auth");
  });

  it("goes stale on a claim-line edit, with narrowed changedSources", async () => {
    const dir = await setup();
    await write(dir, "src/auth/other.ts", "login helper here\n");
    await updateEntry(dir, { ...entry, sources: ["src/auth/**"] });
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("export function login", "export function loginWith"));
    await write(dir, "src/auth/other.ts", "login helper here\n// unrelated\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries[0].changedSources).toEqual(["src/auth/login.ts"]);
    expect(s.changedFiles).toEqual(["src/auth/login.ts"]);
  });

  it("recovers a renamed explicit source and updates the entry", async () => {
    const dir = await setup();
    await tick();
    await fs.rm(path.join(dir, "src/auth/login.ts"));
    await write(dir, "src/auth/renamed.ts", LOGIN_SRC);
    let s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.verifiedEntries).toContain("modules/auth");
    const m = JSON.parse(
      await fs.readFile(path.join(storePath(dir), "manifest.json"), "utf8"),
    );
    expect(Object.keys(m.entries["modules/auth"].files)).toEqual(["src/auth/renamed.ts"]);
    // entry file on disk carries the renamed source
    const entryText = await fs.readFile(
      path.join(storePath(dir), "modules/auth.md"),
      "utf8",
    );
    expect(entryText).toContain("src/auth/renamed.ts");
  });

  it("suspends an entry whose explicit source vanished without a rename", async () => {
    const dir = await setup();
    await tick();
    await fs.rm(path.join(dir, "src/auth/login.ts"));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.suspendedEntries).toContain("modules/auth");
    expect(s.deletedFiles).toContain("src/auth/login.ts");
  });
});

describe("staleness policies", () => {
  it("strict: any change invalidates (old behavior)", async () => {
    process.env.MEMOIZE_STALENESS = "strict";
    const dir = await setup();
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("});", "});  "));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
  });

  it("cosmetic-only: only claim-line changes invalidate", async () => {
    process.env.MEMOIZE_STALENESS = "cosmetic-only";
    const dir = await setup();
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC + "\n// unrelated helper note\n");
    expect((await computeStatus(dir)).state).toBe("fresh");
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("export function login", "export function loginWith"));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries[0].changedSources).toEqual(["src/auth/login.ts"]);
  });
});

describe("new files inside a sources glob always require attention", () => {
  it("marks the entry stale when a new file appears", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, { ...entry, sources: ["src/auth/**"] });
    await write(dir, "src/auth/session.ts", "new\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.addedFiles).toContain("src/auth/session.ts");
  });
});
