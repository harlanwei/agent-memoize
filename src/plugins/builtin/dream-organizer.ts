import type { OrganizerPlugin, PluginContext } from "../../plugin.js";

const DEFAULT_THRESHOLD = 15;

/**
 * Organizer plugin: when enough stale/suspended memories have accumulated
 * (configurable `threshold`, default 15), the memoize_status result is
 * annotated with a "dreaming" section telling the agent to spawn subagents
 * that verify each memory against its sources and reorganize them into a more
 * concise format.
 */
function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    if (typeof e === "string") return e;
    if (e !== null && typeof e === "object" && "name" in e) {
      return String((e as { name: unknown }).name);
    }
    return String(e);
  });
}

/**
 * A fresh organizer instance per config entry; `threshold` lives in the
 * closure so instances with different options don't share state.
 */
export function createPlugin(): OrganizerPlugin {
  let threshold = DEFAULT_THRESHOLD;

  return {
    id: "@naevic/agent-memoize/dream-organizer",
    version: "1.0.0",
    type: "organizer",

    prompts: {
      status:
        "When a memoize_status result contains a `dreaming` section, enough stale/suspended " +
        "memories have accumulated to be worth reorganizing (a \"dream\"). Spawn subagents and " +
        "assign each a share of the entries listed there; every subagent recalls its entries with " +
        "includeStale=true (stale bodies are withheld by default, and the subagent needs the old " +
        "text to rewrite it), verifies each against its current sources, merges overlapping ones, " +
        "and rewrites them into concise form, then calls memoize_update per entry (kind=file, " +
        "with sources) to refresh baselines. Skip entries that are no longer worth keeping by " +
        "calling memoize_invalidate instead.",
    },

    async init(ctx: PluginContext) {
      const t = ctx.options.threshold;
      threshold = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_THRESHOLD;
    },

    async organize(operation, result) {
      if (operation !== "status") return;
      const s = result as { staleEntries?: unknown; suspendedEntries?: unknown };
      if (!Array.isArray(s?.staleEntries)) return;

      const stale = namesOf(s.staleEntries);
      const suspended = namesOf(s.suspendedEntries);
      const count = stale.length + suspended.length;
      if (count < threshold) return;

      // `dreaming` leads the payload: the rest is a long list of changed files
      // and broken claims that would otherwise bury it.
      return {
        dreaming: {
          count,
          threshold,
          stale,
          suspended,
          guidance:
            `${count} memories need attention (threshold ${threshold}): spawn subagents to dream. ` +
            "Each subagent recalls its entries with includeStale=true, verifies them against their " +
            "current sources, merges overlapping entries, and rewrites them into concise form. " +
            "Then call memoize_update per entry to refresh its baseline.",
        },
        ...(result as object),
      };
    },
  };
}
