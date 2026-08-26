import type { Entry, EntryKind, EntryStatus, Manifest, StalenessPolicy } from "./types.js";
import type { z } from "zod";

export type PluginType =
  | "producer"
  | "ledger"
  | "writer"
  | "filter"
  | "organizer"
  | "observer";

export interface PluginConfig {
  id: string;
  options?: Record<string, unknown>;
}

/**
 * The `plugins` field of config.json: one list of configs per category.
 * Keys are plural; `ledgers` is a list of ledger groups — a bare config is a
 * one-ledger group, an array of configs is a group queried together.
 */
export interface PluginConfigGroup {
  producers?: PluginConfig[];
  writers?: PluginConfig[];
  ledgers?: (PluginConfig | PluginConfig[])[];
  filters?: PluginConfig[];
  organizers?: PluginConfig[];
  observers?: PluginConfig[];
}

/** A group of ledgers queried together; the front ledger wins on contradiction. */
export type LedgerGroup = LedgerPlugin[];

export interface PluginRegistryConfig {
  version: 1;
  plugins: PluginConfigGroup;
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
  /** Resolved primary ledger, set before any non-ledger plugin initializes. */
  db: LedgerPlugin;
}

export interface BasePlugin {
  /** Must match the id in the config file. */
  id: string;
  type: PluginType;
  version: string;
  init?(ctx: PluginContext): Promise<void>;
  shutdown?(): Promise<void>;
  /**
   * Prompt snippets injected into the matching MCP tool descriptions while
   * this plugin is enabled — any category can provide them. Keys are the
   * operations of the core tools (memoize_status / memoize_recall /
   * memoize_update / memoize_invalidate); each snippet becomes a
   * "## <Category> guidance (<plugin id>)" section.
   */
  prompts?: Partial<Record<OrganizerOperation, string>>;
}

/**
 * Source of truth for memories. A producer generates the truth a memory is
 * written from, or tells the main agent how to generate it (e.g. by spawning
 * a subagent). It may also register MCP tools that analyze the project (such
 * as LSP-backed tools) and return that truth to the agent.
 */
export interface ProducerPlugin extends BasePlugin {
  type: "producer";
  /** Normalize the truth submitted in an update; return null to reject it. */
  processUpdate?(args: UpdateArgs): Promise<UpdateArgs | null>;
  /** Lint sources at update time; returned strings become warnings. */
  lintSources?(root: string, sources: string[], matched: string[]): Promise<string[]> | string[];
}

/** Persists entries and baselines. Reads merge per ledger group (front ledger wins); writes target the first ledger. */
export interface LedgerPlugin extends BasePlugin {
  type: "ledger";
  listEntries(): Promise<{ entries: Entry[]; invalid: string[] }>;
  readEntry(name: string): Promise<Entry | null>;
  writeEntry(entry: Entry): Promise<void>;
  deleteEntry(name: string): Promise<boolean>;
  loadManifest(): Promise<Manifest>;
  saveManifest(m: Manifest): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Defines the memory representation; the instruction producing it rides on `prompts.update`. */
export interface WriterPlugin extends BasePlugin {
  type: "writer";
  /** Optional output transform; the primary writer may shape recall content. */
  render?(entry: Entry): unknown;
  /** Optional canonicalization of content on write. */
  normalize?(content: string): string;
}

/** Retrieval strategy: gate, rank, drop, or annotate recall candidates. */
export interface FilterPlugin extends BasePlugin {
  type: "filter";
  /** Chain: output of one filter is the input of the next, in config order. */
  filter(query: RecallQuery, candidates: RecallCandidate[]): Promise<RecallCandidate[]>;
}

/** The service operations whose results can be organized. */
export type OrganizerOperation = "status" | "recall" | "update" | "invalidate";

/**
 * Organizer: runs on an operation's result right before it is returned
 * to the agent, so it can give the agent extra guidance (e.g. whether to
 * update/consolidate memories). Plugins chain in config order; each receives
 * the output of the previous one.
 */
export interface OrganizerPlugin extends BasePlugin {
  type: "organizer";
  /**
   * Called with the result of an operation. Return a replacement value
   * (e.g. `{ ...result, extra: ... }`) or `undefined` to keep it unchanged.
   */
  organize(
    operation: OrganizerOperation,
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
export interface ObserverPlugin extends BasePlugin {
  type: "observer";
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
  /** Claim regions that no longer match (present when status is "stale"). */
  brokenClaims?: { path: string; line: number; end?: number; kind?: "line" | "block" }[];
  annotations: Record<string, unknown>;
}

