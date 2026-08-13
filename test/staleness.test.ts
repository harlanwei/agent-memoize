import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateEntry } from "../src/service.js";
import { computeStatusForRoot as computeStatus } from "../src/status.js";
import {
  claimLines,
  entryReferencesFile,
  extractTokens,
  findBrokenClaims,
  lineHash,
  normalizeContent,
  normalizeLine,
  storePath,
} from "../src/workspace.js";
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
    expect(tokens.has("Auth")).toBe(true); // 3-char identifiers are now accepted
    expect(tokens.has("uses")).toBe(true); // "uses" is no longer a stopword
    const claims = await claimLines(dir, "a.ts", "Auth login uses jsonwebtoken middleware.");
    // Line 1 (import) is a single-line claim; line 3 opens a block claim spanning 3-5.
    // Line 4 has no matching token (no "jsonwebtoken" there), so no claim.
    expect(claims.map((c) => c.line)).toEqual([1, 3]);
    const block = claims.find((c) => c.kind === "block");
    expect(block).toBeDefined();
    expect(block!.line).toBe(3);
    expect(block!.end).toBe(5);
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

  it("normalizeContent keeps code around block comments when ignoreComments is set", () => {
    const n = normalizeContent(
      "const y = 1; /* open\n   continues */\nfoo(y);\na /* c */ b\n/* pure */ code\n",
      { ignoreComments: true, ext: ".js" },
    );
    expect(n).toBe("const y = 1;\nfoo(y);\na  b\n code");
  });

  it("normalizeContent ignores block markers inside string literals", () => {
    const n = normalizeContent('const s = "/*";\nconst t = "*/";\ncode();\n', {
      ignoreComments: true,
      ext: ".ts",
    });
    expect(n).toBe('const s = "/*";\nconst t = "*/";\ncode();');
  });

  it("extracts 3-character identifier tokens", () => {
    const tokens = extractTokens("The foo helper does work.");
    expect(tokens.has("foo")).toBe(true);
    expect(tokens.has("helper")).toBe(true);
    // "the" and "does" remain non-tokens: "the" is a stopword, "does" is < 3? no, 4 chars but a stopword-adjacent word kept.
  });

  it("word-boundary matching: 'auth' does not match 'authority'", async () => {
    const dir = await tmpDir();
    // File contains "authority" but not the standalone word "auth".
    await write(dir, "a.ts", "export const authority = 'admin';\n");
    const tokens = extractTokens("Describes the auth flow.");
    expect(tokens.has("auth")).toBe(true);
    const claims = await claimLines(dir, "a.ts", "Describes the auth flow.");
    // No claim: "auth" is a substring of "authority" but not a word-boundary match.
    expect(claims).toEqual([]);
  });

  it("path-like tokens still match by substring", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", "// see src/auth/login.ts for details\n");
    const claims = await claimLines(dir, "a.ts", "References src/auth/login.ts module.");
    expect(claims.length).toBeGreaterThan(0);
  });
});

describe("Change A: normalized claim-line hashes", () => {
  it("normalizeLine collapses internal whitespace and strips trailing semicolons", () => {
    expect(normalizeLine("const   x   =   1;", ".ts")).toBe("const x = 1");
    expect(normalizeLine("foo()  ", ".ts")).toBe("foo()");
  });

  it("normalizeLine strips trailing inline comments", () => {
    expect(normalizeLine("const x = 1  // default", ".ts")).toBe("const x = 1");
    expect(normalizeLine("x = 1 # py comment", ".py")).toBe("x = 1");
  });

  it("lineHash is stable across trailing-comment and whitespace edits", () => {
    const base = lineHash("export function login(user, password) {", ".ts");
    expect(lineHash("export function login(user, password) {  // entrypoint", ".ts")).toBe(base);
    expect(lineHash("export   function   login(user,  password)  {", ".ts")).toBe(base);
    expect(lineHash("export function login(user, password) {;", ".ts")).toBe(base);
  });

  it("a claim line survives a trailing-comment edit (stays fresh/verified)", async () => {
    const dir = await tmpDir();
    // Single-line source with no block so the claim is line-level.
    await write(dir, "src/cfg.ts", "export const timeout = 5000;\n");
    await updateEntry(dir, {
      name: "cfg",
      kind: "file",
      sources: ["src/cfg.ts"],
      content: "The timeout config.",
      author: "test",
    });
    await tick();
    // Add a trailing comment to the claimed line.
    await write(dir, "src/cfg.ts", "export const timeout = 5000; // ms\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
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

describe("ignoreComments", () => {
  const SRC = "const y = 1; /* open\n   continues */\nfoo(y);\n";

  async function setup() {
    const dir = await tmpDir();
    await write(dir, ".agent-memoize/config.json", JSON.stringify({ ignoreComments: true }));
    await write(dir, "src/a.ts", SRC);
    await updateEntry(dir, {
      name: "a",
      kind: "file",
      sources: ["src/a.ts"],
      content: "The a module.",
      author: "test",
    });
    await tick();
    return dir;
  }

  it("treats a comment-only edit as cosmetic", async () => {
    const dir = await setup();
    await write(dir, "src/a.ts", "const y = 1; /* edited\n   continues */\nfoo(y);\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
    expect(s.cosmeticChanges).toContain("src/a.ts");
  });

  it("goes stale when code before an opening block comment changes", async () => {
    const dir = await setup();
    await write(dir, "src/a.ts", "const y = 999; /* open\n   continues */\nfoo(y);\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries[0].changedSources).toContain("src/a.ts");
  });

  it("goes stale when code after a closing block comment changes", async () => {
    const dir = await setup();
    await write(dir, "src/a.ts", "const y = 1; /* open\n   continues */\nfoo(y, 2);\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.staleEntries[0].changedSources).toContain("src/a.ts");
  });
});

describe("Change B: block claim regions", () => {
  it("captures a block claim for a token line that opens a brace block", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", LOGIN_SRC);
    const claims = await claimLines(dir, "a.ts", "The login function signs tokens.");
    const block = claims.find((c) => c.kind === "block");
    expect(block).toBeDefined();
    expect(block!.line).toBe(3);
    expect(block!.end).toBe(5);
  });

  it("block claim survives a body edit that doesn't touch the block's content", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, entry);
    await tick();
    // Insert a comment line above the function — the block moves down but is unchanged.
    await write(dir, "src/auth/login.ts", "// header note\n" + LOGIN_SRC);
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
  });

  it("block claim goes stale when the block's content changes", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, entry);
    await tick();
    // Change a line inside the block body.
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("jwt.sign({ user })", "jwt.sign({ user, role })"));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
  });

  it("does not treat a non-brace line as a block start", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", "const greeting = 'hello'\nexport function f() { return 1 }\n");
    // Token "greeting" is on line 1, which has no '{' → single-line claim, not a block.
    const claims = await claimLines(dir, "a.ts", "The greeting constant.");
    const line1 = claims.find((c) => c.line === 1);
    expect(line1).toBeDefined();
    expect(line1!.kind ?? "line").toBe("line");
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

describe("Change C: new files inside a sources glob", () => {
  it("does NOT stale on an unrelated new file under claim-aware policies", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, { ...entry, sources: ["src/auth/**"] });
    await write(dir, "src/auth/session.ts", "totally unrelated content here\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("fresh");
  });

  it("STALES on a new file the entry references", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, { ...entry, sources: ["src/auth/**"] });
    // New file mentions the entry's token 'login' as a standalone word.
    await write(dir, "src/auth/session.ts", "export const login = true;\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    expect(s.addedFiles).toContain("src/auth/session.ts");
  });

  it("strict policy: any new file stales (old behavior preserved)", async () => {
    process.env.MEMOIZE_STALENESS = "strict";
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, { ...entry, sources: ["src/auth/**"] });
    await write(dir, "src/auth/unrelated.ts", "totally unrelated\n");
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    delete process.env.MEMOIZE_STALENESS;
  });

  it("entryReferencesFile honors word boundaries", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", "export const authority = 1;\n");
    expect(await entryReferencesFile(dir, "a.ts", "Describes auth.")).toBe(false);
    await write(dir, "b.ts", "export const auth = true;\n");
    expect(await entryReferencesFile(dir, "b.ts", "Describes auth.")).toBe(true);
  });
});

describe("Change F: broken claim regions surfaced", () => {
  it("findBrokenClaims returns the specific broken regions", async () => {
    const dir = await tmpDir();
    await write(dir, "a.ts", LOGIN_SRC);
    const claims = await claimLines(dir, "a.ts", "The login function uses jwt.");
    // Mutate the block body.
    await write(dir, "a.ts", LOGIN_SRC.replace("jwt.sign({ user })", "jwt.sign({ user, role })"));
    const broken = await findBrokenClaims(dir, "a.ts", claims);
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.some((b) => b.kind === "block")).toBe(true);
  });

  it("status surfaces brokenClaims on a stale entry", async () => {
    const dir = await tmpDir();
    await write(dir, "src/auth/login.ts", LOGIN_SRC);
    await updateEntry(dir, entry);
    await tick();
    await write(dir, "src/auth/login.ts", LOGIN_SRC.replace("jwt.sign({ user })", "jwt.sign({ user, role })"));
    const s = await computeStatus(dir);
    expect(s.state).toBe("stale");
    const stale0 = s.staleEntries[0];
    expect(stale0.brokenClaims).toBeDefined();
    expect(stale0.brokenClaims!.length).toBeGreaterThan(0);
    expect(stale0.brokenClaims![0].path).toBe("src/auth/login.ts");
  });
});
