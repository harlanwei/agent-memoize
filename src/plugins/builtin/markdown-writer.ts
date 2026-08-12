import type { WriterPlugin } from "../../plugin.js";

export const plugin: WriterPlugin = {
  id: "@naevic/agent-memoize/markdown-writer",
  version: "1.0.0",
  type: "writer",
  prompt:
    "Write the entry body as free-form Markdown: plain prose, short sections, " +
    "code snippets where useful. The first line becomes the index summary when " +
    "no summary is given. Prefer precise source paths over wide globs so " +
    "memories stay fresh. After project files change, if the changed lines do " +
    "not contradict this memory, call memoize_update again with unchanged " +
    "content to refresh its baseline instead of rewriting it.",
};
