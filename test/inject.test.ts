import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_PROMPT_FILES,
  PROMPT_END,
  PROMPT_MARKER,
  PROMPT_START,
  WORKFLOW_PROMPT,
  WRAPPED_PROMPT,
  injectGlobalPrompt,
  injectProjectPrompt,
  installedAgents,
} from "../src/inject.js";
import { sh, tmpDir, write } from "./helpers.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const countMarkers = (content: string) => content.split(PROMPT_MARKER).length - 1;

describe("injectProjectPrompt", () => {
  it("creates AGENTS.md and CLAUDE.md with the wrapped workflow prompt", async () => {
    const dir = await tmpDir();
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: ["AGENTS.md", "CLAUDE.md"], updated: [], skipped: [] });
    for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
      const content = await fs.readFile(path.join(dir, rel), "utf8");
      expect(content).toContain(PROMPT_START);
      expect(content).toContain(PROMPT_END);
      expect(content).toContain(PROMPT_MARKER);
      expect(content).toContain("memoize_status");
    }
  });

  it("is idempotent", async () => {
    const dir = await tmpDir();
    await injectProjectPrompt(dir);
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: [], updated: [], skipped: ["AGENTS.md", "CLAUDE.md"] });
    for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
      expect(countMarkers(await fs.readFile(path.join(dir, rel), "utf8"))).toBe(1);
    }
  });

  it("preserves existing content with a blank-line separator", async () => {
    const dir = await tmpDir();
    await write(dir, "AGENTS.md", "# Project\nrules here\n");
    await injectProjectPrompt(dir);
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(content.startsWith("# Project\nrules here\n\n" + PROMPT_START)).toBe(true);
  });

  it("updates a changed managed block in place", async () => {
    const dir = await tmpDir();
    const stale = `${PROMPT_START}\n## Project memory (agent-memoize MCP)\n\n- Outdated instructions.\n${PROMPT_END}\n`;
    await write(dir, "AGENTS.md", "# Project\n" + stale + "\nkeep me\n");
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: ["CLAUDE.md"], updated: ["AGENTS.md"], skipped: [] });
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(countMarkers(content)).toBe(1);
    expect(content).toContain(WRAPPED_PROMPT);
    expect(content).not.toContain("Outdated instructions");
    expect(content.endsWith("\nkeep me\n")).toBe(true);
  });

  it("wraps a legacy unwrapped block in place", async () => {
    const dir = await tmpDir();
    await write(dir, "AGENTS.md", "# Project\n\n" + WORKFLOW_PROMPT);
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: ["CLAUDE.md"], updated: ["AGENTS.md"], skipped: [] });
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(countMarkers(content)).toBe(1);
    expect(content).toContain(PROMPT_START);
    expect(content).toContain(WRAPPED_PROMPT);
  });

  it("leaves a user-modified legacy block alone", async () => {
    const dir = await tmpDir();
    await write(dir, "AGENTS.md", "## Project memory (agent-memoize MCP)\n\n- Heavily edited by hand.\n");
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: ["CLAUDE.md"], updated: [], skipped: ["AGENTS.md"] });
    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(countMarkers(content)).toBe(1);
    expect(content).not.toContain(PROMPT_START);
  });

  it("appends to an existing CLAUDE.md, preserving its content", async () => {
    const dir = await tmpDir();
    await write(dir, "CLAUDE.md", "claude notes\n");
    const res = await injectProjectPrompt(dir);
    expect(res).toEqual({ written: ["AGENTS.md", "CLAUDE.md"], updated: [], skipped: [] });
    const content = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("claude notes");
    expect(content).toContain(PROMPT_MARKER);
  });
  it("README Step 3 block matches the CLI prompt", async () => {
    const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
    const m = readme.match(/<!-- agent-memoize:start -->\n([\s\S]*?)<!-- agent-memoize:end -->\n/);
    expect(m?.[1]).toBe(WORKFLOW_PROMPT);
  });
});

describe("injectGlobalPrompt", () => {
  it("writes the agent's global prompt file under homeDir", async () => {
    const home = await tmpDir();
    const res = await injectGlobalPrompt("claude", home);
    expect(res.action).toBe("written");
    expect(res.file).toBe(path.join(home, GLOBAL_PROMPT_FILES.claude));
    expect(await fs.readFile(res.file, "utf8")).toContain(PROMPT_MARKER);
  });

  it("is idempotent", async () => {
    const home = await tmpDir();
    await injectGlobalPrompt("codex", home);
    const res = await injectGlobalPrompt("codex", home);
    expect(res.action).toBe("skipped");
    const content = await fs.readFile(path.join(home, GLOBAL_PROMPT_FILES.codex), "utf8");
    expect(countMarkers(content)).toBe(1);
  });

  it("rejects unknown agents", async () => {
    await expect(injectGlobalPrompt("bogus", await tmpDir())).rejects.toThrow(/unknown agent/);
  });
});

describe("installedAgents", () => {
  it("detects agents with an executable on PATH", async () => {
    const bin = await tmpDir();
    for (const name of ["claude", "codex", "opencode"]) {
      await write(bin, name, "#!/bin/sh\n");
    }
    await fs.chmod(path.join(bin, "claude"), 0o755);
    await fs.chmod(path.join(bin, "codex"), 0o755);
    // opencode stays non-executable; kimi/zcode are absent.
    expect(await installedAgents(bin)).toEqual(["claude", "codex"]);
  });

  it("returns an empty list for an empty PATH", async () => {
    expect(await installedAgents("")).toEqual([]);
  });
});

describe("agent-memoize --inject (CLI)", () => {
  it("injects into the project and exits 0", async () => {
    const dir = await tmpDir();
    await sh(process.execPath, [serverPath, "--inject", "--root", dir]);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain(PROMPT_MARKER);
  });

  it("is idempotent across runs", async () => {
    const dir = await tmpDir();
    await sh(process.execPath, [serverPath, "--inject", "--root", dir]);
    const { stdout } = await sh(process.execPath, [serverPath, "--inject", "--root", dir]);
    expect(stdout).toContain("AGENTS.md: already contains the workflow prompt (skipped)");
    expect(countMarkers(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8"))).toBe(1);
  });

  it("injects into a global agent prompt (HOME-scoped)", async () => {
    const home = await tmpDir();
    await sh(process.execPath, [serverPath, "--inject", "global:claude"], {
      env: { ...process.env, HOME: home },
    });
    const file = path.join(home, GLOBAL_PROMPT_FILES.claude);
    expect(await fs.readFile(file, "utf8")).toContain(PROMPT_MARKER);
  });

  it("--inject global injects only agents installed on PATH", async () => {
    const bin = await tmpDir();
    for (const name of ["claude", "codex"]) {
      await write(bin, name, "#!/bin/sh\n");
      await fs.chmod(path.join(bin, name), 0o755);
    }
    const home = await tmpDir();
    await sh(process.execPath, [serverPath, "--inject", "global"], {
      env: { ...process.env, HOME: home, PATH: bin },
    });
    for (const name of ["claude", "codex"]) {
      const file = path.join(home, GLOBAL_PROMPT_FILES[name]);
      expect(await fs.readFile(file, "utf8")).toContain(PROMPT_MARKER);
    }
    await expect(fs.access(path.join(home, GLOBAL_PROMPT_FILES.opencode))).rejects.toThrow();
    await expect(fs.access(path.join(home, GLOBAL_PROMPT_FILES.zcode))).rejects.toThrow();
  });

  it("fails for unknown agents", async () => {
    await expect(
      sh(process.execPath, [serverPath, "--inject", "global:bogus"], {
        env: { ...process.env, HOME: await tmpDir() },
      }),
    ).rejects.toThrow(/unknown agent/);
  });

  it("rejects an empty agent list", async () => {
    await expect(sh(process.execPath, [serverPath, "--inject", "global:"])).rejects.toThrow(
      /requires at least one agent/,
    );
  });

  it("rejects unknown flags", async () => {
    await expect(sh(process.execPath, [serverPath, "--global"])).rejects.toThrow(
      /unknown argument/,
    );
  });
});
