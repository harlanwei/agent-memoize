/**
 * Public surface of @naevic/agent-memoize for plugin authors. The package
 * default export is this module (types + small helpers); the CLI entry point
 * is dist/index.js and is never imported by consumers.
 */
export type {
  BasePlugin,
  FilterPlugin,
  LedgerPlugin,
  ObserverPlugin,
  OrganizerPlugin,
  PluginConfig,
  PluginConfigGroup,
  PluginContext,
  PluginRegistryConfig,
  OrganizerOperation,
  MemoryAccessEvent,
  ProducerPlugin,
  RecallCandidate,
  RecallQuery,
  ToolHandler,
  ToolRegistration,
  UpdateArgs,
  WriterPlugin,
} from "./plugin.js";
export type { Entry, EntryBaseline, EntryKind, EntryMeta, EntryStatus, FileFingerprint, Manifest, StalenessPolicy, StatusResult } from "./types.js";

export { STORE_DIR, storePath } from "./workspace.js";
export { entryFilePath, emptyManifest, parseEntry, serializeEntry } from "./plugins/builtin/file-ledger.js";
