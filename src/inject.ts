import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * The agent-workflow prompt injected into AGENTS.md / CLAUDE.md (README
 * "Step 3"). Single source of truth — both the `--inject` CLI command and the
 * automatic installer use it.
 */
export const PROMPT_MARKER = "## Project memory (agent-memoize MCP)";

export const WORKFLOW_PROMPT = `## Project memory (agent-memoize MCP)

- At session start, call \`memoize_status\` once. If entries are stale, re-read only the listed
  files — do not rescan the project. \`verified\` entries are already fresh (auto re-baselined);
  \`suspended\` entries need their sources fixed via \`memoize_update\`.
- Before exploring the codebase, call \`memoize_recall\`. Recall a topic before reading the files
  it describes; if the memory is fresh and sufficient, skip reading them.
- After editing files, call \`memoize_update\` for each affected entry (kind="file", with
  \`sources\`). Create entries as you learn the project: architecture, conventions, gotchas.
  Producer plugins are sources of truth — follow the producer guidance in the
  \`memoize_update\` tool description.
- Record user decisions and preferences with \`memoize_update\` (kind="decision", no sources).
- Memory guides navigation only: always read a file before editing it, even if memory
  describes it.
`;

/**
 * Managed-region delimiters: the prompt is injected between them so that a
 * later `--inject` can find and update the block in place (or you can remove
 * it in one piece).
 */
export const PROMPT_START = "<!-- agent-memoize:start -->";
export const PROMPT_END = "<!-- agent-memoize:end -->";

export const WRAPPED_PROMPT = `${PROMPT_START}
${WORKFLOW_PROMPT}${PROMPT_END}
`;

/** Relative (to the user's home) global prompt file per supported agent. */
export const GLOBAL_PROMPT_FILES: Record<string, string> = {
  claude: ".claude/CLAUDE.md",
  codex: ".codex/AGENTS.md",
  opencode: ".config/opencode/AGENTS.md",
  pi: ".pi/agent/AGENTS.md",
  kimi: ".kimi-code/AGENTS.md",
  zcode: ".zcode/AGENTS.md",
};

/**
 * Agents with a global prompt file that are currently installed (an
 * executable of that name on PATH). Used by `--inject global`. `pathEnv` is
 * parameterized for tests.
 */
export async function installedAgents(pathEnv: string = process.env.PATH ?? ""): Promise<string[]> {
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  for (const name of Object.keys(GLOBAL_PROMPT_FILES)) {
    for (const dir of dirs) {
      try {
        await fs.access(path.join(dir, name), fs.constants.X_OK);
        found.push(name);
        break;
      } catch {
        // not executable here — keep looking
      }
    }
  }
  return found;
}

export type InjectAction = "written" | "updated" | "skipped";

export interface InjectResult {
  /** Files the prompt was freshly written to (project-relative names). */
  written: string[];
  /** Files whose existing prompt block was replaced (prompt changed). */
  updated: string[];
  /** Files that already contained the prompt and were left untouched. */
  skipped: string[];
}

/**
 * Ensures filePath contains WRAPPED_PROMPT exactly once, creating or updating
 * the managed region as needed. Legacy unwrapped blocks (copy-pasted from an
 * older README) are wrapped in place when their text still matches exactly.
 */
async function upsertBlock(filePath: string): Promise<InjectAction> {
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const startIdx = content.indexOf(PROMPT_START);
  const endIdx = content.indexOf(PROMPT_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Managed region present — replace it when the prompt text changed.
    const region = content.slice(startIdx, endIdx + PROMPT_END.length);
    if (region + "\n" === WRAPPED_PROMPT) return "skipped";
    const next =
      content.slice(0, startIdx) + WRAPPED_PROMPT + content.slice(endIdx + PROMPT_END.length);
    await fs.writeFile(filePath, next, "utf8");
    return "updated";
  }

  if (content.includes(PROMPT_MARKER)) {
    // Legacy unwrapped block. Wrap it in place; if the user edited it so the
    // exact text no longer matches, leave it alone rather than duplicating.
    const legacyIdx = content.indexOf(WORKFLOW_PROMPT);
    if (legacyIdx !== -1) {
      const next =
        content.slice(0, legacyIdx) + WRAPPED_PROMPT + content.slice(legacyIdx + WORKFLOW_PROMPT.length);
      await fs.writeFile(filePath, next, "utf8");
      return "updated";
    }
    return "skipped";
  }

  const sep = content.length > 0 ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, sep + WRAPPED_PROMPT, "utf8");
  return "written";
}

/**
 * Injects the workflow prompt into the current project: AGENTS.md and
 * CLAUDE.md are both created if missing, so every agent that reads either
 * file picks up the workflow.
 */
export async function injectProjectPrompt(root: string): Promise<InjectResult> {
  const result: InjectResult = { written: [], updated: [], skipped: [] };
  for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
    result[await upsertBlock(path.join(root, rel))].push(rel);
  }
  return result;
}

/**
 * Injects the workflow prompt into an agent's global prompt file (e.g.
 * ~/.claude/CLAUDE.md). `homeDir` is parameterized for tests.
 */
export async function injectGlobalPrompt(
  agent: string,
  homeDir: string = os.homedir(),
): Promise<{ file: string; action: InjectAction }> {
  const rel = GLOBAL_PROMPT_FILES[agent];
  if (!rel) {
    throw new Error(
      `unknown agent "${agent}" (supported: ${Object.keys(GLOBAL_PROMPT_FILES).join(", ")})`,
    );
  }
  const filePath = path.join(homeDir, rel);
  return { file: filePath, action: await upsertBlock(filePath) };
}
