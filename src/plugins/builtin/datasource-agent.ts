import type { DataSourcePlugin } from "../../plugin.js";

const WIDE_GLOB_THRESHOLD = 20;

export const plugin: DataSourcePlugin = {
  id: "agent",
  version: "1.0.0",
  type: "datasource",

  describeUpdate() {
    return (
      "Provenance: kind=file entries are agent-generated facts derived from " +
      "the listed sources; kind=decision entries record user input " +
      "(decisions/preferences) and are never invalidated by file changes. " +
      "Prefer precise paths over wide globs (src/auth/login.ts over " +
      "src/auth/**) to keep memories fresh."
    );
  },

  async lintSources(_root, sources, matched) {
    if (matched.length > WIDE_GLOB_THRESHOLD) {
      return [
        "sources matched " +
          matched.length +
          " files; a wide glob makes this entry stale easily — prefer precise paths",
      ];
    }
    return sources.length === 0 ? [] : [];
  },
};
