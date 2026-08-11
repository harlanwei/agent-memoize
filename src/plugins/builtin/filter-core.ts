import type { FilterPlugin } from "../../plugin.js";

/**
 * The default recall gate: identity chain element. Staleness gating lives in
 * the recall assembly (stale content is never served); this plugin is the
 * anchor of the filter chain and the documented slot for higher/lower
 * priority filters to compose around (e.g. rerankers at priority 50, LLM
 * verifiers that flip status from stale to verified at priority 200).
 */
export const plugin: FilterPlugin = {
  id: "core-filter",
  version: "1.0.0",
  type: "filter",
  async filter(_query, candidates) {
    return candidates;
  },
};
