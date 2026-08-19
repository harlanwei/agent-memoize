import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sh, tmpDir, write } from "./helpers.js";

const installPath = fileURLToPath(new URL("../install.sh", import.meta.url));

describe("automatic installer", () => {
  it("configures explicitly listed agents at user scope without prompts", async () => {
    const home = await tmpDir();
    const project = await tmpDir();
    const bin = await tmpDir();
    await write(bin, "pi", "#!/bin/sh\nexit 0\n");
    await fs.chmod(path.join(bin, "pi"), 0o755);

    const { stdout } = await sh(
      "bash",
      [
        installPath,
        "--local",
        "--agent",
        "claude,codex,opencode,pi,kimi,zcode",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          KIMI_CODE_HOME: "",
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(stdout).toContain("== Done ==");
    expect(await fs.readdir(project)).toEqual([]);

    const claude = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
    expect(claude.mcpServers["agent-memoize"]).toBeDefined();
    expect(await fs.readFile(path.join(home, ".codex/config.toml"), "utf8")).toContain(
      "[mcp_servers.agent-memoize]",
    );
    const opencode = JSON.parse(
      await fs.readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(opencode.mcp["agent-memoize"]).toBeDefined();
    const pi = JSON.parse(
      await fs.readFile(path.join(home, ".config/mcp/mcp.json"), "utf8"),
    );
    expect(pi.mcpServers["agent-memoize"]).toBeDefined();
    const kimi = JSON.parse(
      await fs.readFile(path.join(home, ".kimi-code/mcp.json"), "utf8"),
    );
    expect(kimi.mcpServers["agent-memoize"]).toBeDefined();
    const zcode = JSON.parse(
      await fs.readFile(path.join(home, ".zcode/cli/config.json"), "utf8"),
    );
    expect(zcode.mcp.servers["agent-memoize"]).toBeDefined();

    for (const rel of [
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".config/opencode/AGENTS.md",
      ".pi/agent/AGENTS.md",
      ".kimi-code/AGENTS.md",
      ".zcode/AGENTS.md",
    ]) {
      expect(await fs.readFile(path.join(home, rel), "utf8")).toContain(
        "## Project memory (agent-memoize MCP)",
      );
    }
  });
});
