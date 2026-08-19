import type { ProducerPlugin } from "../../plugin.js";

const WIDE_GLOB_THRESHOLD = 20;

/**
 * Default producer: the built-in source of truth for agent-generated
 * memories. It tells the main agent how to produce the truth for an entry —
 * spawn a subagent with the goal to explore the project around the entry's
 * topic — and lints `sources` so wide globs don't make entries stale easily.
 */
export function createPlugin(): ProducerPlugin {
  return {
    id: "@naevic/agent-memoize/agent-producer",
    version: "1.0.0",
    type: "producer",

    describeUpdate() {
      return (
        "Source of truth: kind=file memories must be produced from the project, " +
        "not assumed. Before calling memoize_update for a kind=file entry, spawn a " +
        "subagent with the goal to explore the project around this entry's topic and " +
        "report what it finds; use that report as the truth you pass as `content`. " +
        "kind=decision entries are sourced from the user's decisions/preferences and " +
        "are never invalidated by file changes. " +
        "Prefer precise paths over wide globs (src/auth/login.ts over " +
        "src/auth/**) to keep memories fresh."
      );
    },

    async lintSources(_root, _sources, matched) {
      if (matched.length > WIDE_GLOB_THRESHOLD) {
        return [
          "sources matched " +
            matched.length +
            " files; a wide glob makes this entry stale easily — prefer precise paths",
        ];
      }
      return [];
    },
  };
}
