import type { Entry, EntryKind, EntryStatus, Manifest, StalenessPolicy } from "./types.js";
import type { z } from "zod";

export type PluginType =
  | "datasource"
  | "database"
  | "format"
  | "filter"
  | "postprocessing"
  | "debugging";

export interface PluginConfig {
  id: string;
  priority: number;
  options?: Record<string, unknown>;
}

export interface PluginRegistryConfig {
  version: 1;
  plugins: PluginConfig[];
  staleness?: StalenessPolicy;
  ignoreComments?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolRegistration {
  /** Fully namespaced MCP tool name (memoize_<pluginId>_<name>). */
  name: string;
  description?: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: ToolHandler;
}

export interface PluginContext {
  root: string;
  /** The options for THIS plugin from the config file. */
  options: Record<string, unknown>;
  /** Register an extra MCP tool; namespaced to the plugin by the registry. */
  registerTool(
    name: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: ToolHandler,
    description?: string,
  ): void;
  log(level: "debug" | "info" | "warn" | "error", msg: string): void;
  /** Resolved primary database, set before any non-database plugin initializes. */
  db: DatabasePlugin;
}

export interface BasePlugin {
  /** Must match the id in the config file. */
  id: string;
  type: PluginType;
  version: string;
  init?(ctx: PluginContext): Promise<void>;
  shutdown?(): Promise<void>;
}

/** Produces and normalizes the raw input that becomes a memory. */
export interface DataSourcePlugin extends BasePlugin {
  type: "datasource";
  /** Normalize/validate raw update input; return null to reject it. */
  processUpdate?(args: UpdateArgs): Promise<UpdateArgs | null>;
  /** Text appended to the memoize_update tool description. */
  describeUpdate?(): string;
  /** Lint sources at update time; returned strings become warnings. */
  lintSources?(root: string, sources: string[], matched: string[]): Promise<string[]> | string[];
}

/** Persists entries and baselines. First enabled database is primary, rest mirror writes. */
export interface DatabasePlugin extends BasePlugin {
  type: "database";
  listEntries(): Promise<{ entries: Entry[]; invalid: string[] }>;
  readEntry(name: string): Promise<Entry | null>;
  writeEntry(entry: Entry): Promise<void>;
  deleteEntry(name: string): Promise<boolean>;
  loadManifest(): Promise<Manifest>;
  saveManifest(m: Manifest): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Defines the memory representation and the agent instruction that produces it. */
export interface FormatPlugin extends BasePlugin {
  type: "format";
  /** Agent instruction: how to process input data into this format. */
  prompt: string;
  /** Optional output transform; the primary format may shape recall content. */
  render?(entry: Entry): unknown;
  /** Optional canonicalization of content on write. */
  normalize?(content: string): string;
}

/** Retrieval strategy: gate, rank, drop, or annotate recall candidates. */
export interface FilterPlugin extends BasePlugin {
  type: "filter";
  /** Chain: output of one filter is the input of the next, in priority order. */
  filter(query: RecallQuery, candidates: RecallCandidate[]): Promise<RecallCandidate[]>;
}

/** The service operations whose results can be post-processed. */
export type PostprocessOperation = "status" | "recall" | "update" | "invalidate";

/**
 * Post-processing: runs on an operation's result right before it is returned
 * to the agent, so it can give the agent extra guidance (e.g. whether to
 * update/consolidate memories). Plugins chain in priority order; each receives
 * the output of the previous one.
 */
export interface PostprocessPlugin extends BasePlugin {
  type: "postprocessing";
  /**
   * Called with the result of an operation. Return a replacement value
   * (e.g. `{ ...result, extra: ... }`) or `undefined` to keep it unchanged.
   */
  postprocess(
    operation: PostprocessOperation,
    result: unknown,
  ): Promise<unknown | void> | unknown | void;
}

/** A memory lookup performed by an agent via memoize_recall. */
export interface MemoryAccessEvent {
  /** MCP client that performed the recall (clientInfo.name). */
  accessor: string;
  /** The requested topic, when the recall was topic-scoped. */
  topic?: string;
  /** What was looked up. "missing" when the topic names no entry. */
  entries: { name: string; status: EntryStatus | "missing" }[];
}

/** Observability: see how memories are created and how agents access them. */
export interface DebuggingPlugin extends BasePlugin {
  type: "debugging";
  /** Called after a memory entry is created or refreshed. Best-effort: failures are logged, not fatal. */
  onMemoryCreated?(entry: Entry, operation: "create" | "refresh", accessor: string): Promise<void> | void;
  /** Called when an agent recalls memories. Best-effort: failures are logged, not fatal. */
  onMemoryAccessed?(access: MemoryAccessEvent): Promise<void> | void;
}

export interface UpdateArgs {
  name: string;
  content: string;
  kind: EntryKind;
  sources?: string[];
  summary?: string;
  author: string;
}

export interface RecallQuery {
  topic?: string;
}

export interface RecallCandidate {
  entry: Entry;
  status: EntryStatus;
  changedSources: string[];
  annotations: Record<string, unknown>;
}

