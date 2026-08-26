import type { FilterPlugin } from "../../plugin.js";

/**
 * The default recall gate: identity chain element. Staleness gating lives in
 * the recall assembly (stale content is never served); this plugin is the
 * anchor of the filter chain and the documented slot for other filters in
 * the config array to compose around (e.g. a reranker listed before it, or
 * an LLM verifier that flips status from stale to verified listed after it).
 */
export function createPlugin(): FilterPlugin {
  return {
    id: "@naevic/agent-memoize/stale-filter",
    version: "1.0.0",
    type: "filter",
    prompts: {
      recall:
        "Stale or suspended entries are never served as content: recall without " +
        "`topic` lists every entry with its status, and a stale topic returns the " +
        "changed source files to re-read instead. Re-read those files, then refresh " +
        "the entry via memoize_update.",
    },
    async filter(_query, candidates) {
      return candidates;
    },
  };
}
