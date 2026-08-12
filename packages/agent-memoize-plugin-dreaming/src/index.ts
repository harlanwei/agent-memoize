import type { PluginContext, PostprocessPlugin } from "@naevic/agent-memoize";

const DEFAULT_THRESHOLD = 15;

/**
 * Postprocessing plugin: when enough stale/suspended memories have accumulated
 * (configurable `threshold`, default 15), the memoize_status result is
 * annotated with a "dreaming" section telling the agent to spawn subagents
 * that verify each memory against its sources and reorganize them into a more
 * concise format.
 */
let threshold = DEFAULT_THRESHOLD;

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

export const plugin: PostprocessPlugin = {
  id: "dreaming",
  version: "1.0.0",
  type: "postprocessing",

  async init(ctx: PluginContext) {
    const t = ctx.options.threshold;
    threshold = typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_THRESHOLD;
  },

  async postprocess(operation, result) {
    if (operation !== "status") return;
    const s = result as { staleEntries?: unknown; suspendedEntries?: unknown };
    if (!Array.isArray(s?.staleEntries)) return;

    const stale = namesOf(s.staleEntries);
    const suspended = namesOf(s.suspendedEntries);
    const count = stale.length + suspended.length;
    if (count < threshold) return;

    return {
      ...(result as object),
      dreaming: {
        count,
        threshold,
        stale,
        suspended,
        guidance:
          `${count} memories need attention (threshold ${threshold}): spawn subagents to dream. ` +
          "Each subagent verifies the memories it is assigned against their current sources, " +
          "merges overlapping entries, and rewrites them into concise form. Then call " +
          "memoize_update per entry to refresh its baseline.",
      },
    };
  },
};
