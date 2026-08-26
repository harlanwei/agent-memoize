import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BasePlugin,
  FilterPlugin,
  LedgerGroup,
  LedgerPlugin,
  ObserverPlugin,
  OrganizerPlugin,
  PluginConfig,
  PluginConfigGroup,
  PluginContext,
  PluginType,
  ProducerPlugin,
  ToolRegistration,
  WriterPlugin,
} from "../plugin.js";
import { storePath } from "../workspace.js";
import type { StalenessPolicy } from "../types.js";

export type {
  BasePlugin,
  FilterPlugin,
  LedgerGroup,
  LedgerPlugin,
  ObserverPlugin,
  OrganizerPlugin,
  ProducerPlugin,
  WriterPlugin,
};
export type {
  MemoryAccessEvent,
  PluginConfig,
  PluginConfigGroup,
  PluginContext,
  PluginRegistryConfig,
  OrganizerOperation,
  ToolRegistration,
} from "../plugin.js";

/**
 * Builtin modules export a `createPlugin` factory so every config entry gets
 * a fresh plugin instance — builtins keep no state at module scope, and
 * registries for different roots in one process never share it.
 */
interface BuiltinPluginModule {
  createPlugin(): BasePlugin;
}

const BUILTIN_MODULES: Record<string, () => Promise<BuiltinPluginModule>> = {
  "@naevic/agent-memoize/file-ledger": () => import("./builtin/file-ledger.js"),
  "@naevic/agent-memoize/markdown-writer": () => import("./builtin/markdown-writer.js"),
  "@naevic/agent-memoize/stale-filter": () => import("./builtin/stale-filter.js"),
  "@naevic/agent-memoize/agent-producer": () => import("./builtin/agent-producer.js"),
  "@naevic/agent-memoize/dream-organizer": () => import("./builtin/dream-organizer.js"),
};

/**
 * Per-category default built-ins. A category the user does not configure
 * falls back to its entry here; a configured category (even an empty array)
 * is authoritative. The default pipeline — no config at all — is every
 * category below.
 */
const DEFAULT_PLUGINS: PluginConfigGroup = {
  ledgers: [{ id: "@naevic/agent-memoize/file-ledger" }],
  producers: [{ id: "@naevic/agent-memoize/agent-producer" }],
  writers: [{ id: "@naevic/agent-memoize/markdown-writer" }],
  filters: [{ id: "@naevic/agent-memoize/stale-filter" }],
  organizers: [{ id: "@naevic/agent-memoize/dream-organizer" }],
  observers: [],
};

const RESERVED_TOOLS = new Set([
  "memoize_status",
  "memoize_recall",
  "memoize_update",
  "memoize_invalidate",
]);

const STALENESS_POLICIES: StalenessPolicy[] = ["strict", "selective"];

export type PluginLoader = (id: string, options: Record<string, unknown>) => Promise<BasePlugin>;

export interface RegistryOptions {
  root: string;
  /** --plugins CLI override (JSON object keyed by plugin category). */
  cliPlugins?: string;
  /** Injected loader for tests. Defaults to builtins + dynamic import. */
  load?: PluginLoader;
}

export class Registry {
  readonly root: string;
  readonly staleness: StalenessPolicy;
  readonly ignoreComments: boolean;
  producers: ProducerPlugin[] = [];
  /** Ledger groups, in config order; ledgers within a group are queried in parallel. */
  ledgerGroups: LedgerGroup[] = [];
  ledgers: LedgerPlugin[] = [];
  writers: WriterPlugin[] = [];
  filters: FilterPlugin[] = [];
  organizers: OrganizerPlugin[] = [];
  observers: ObserverPlugin[] = [];
  tools: ToolRegistration[] = [];
  /** First ledger of the first group; the write target for update/invalidate. */
  primaryDb!: LedgerPlugin;

  /** Plugins in init order (ledgers first, config order within each category). */
  private readonly initOrder: BasePlugin[] = [];

  private constructor(root: string, staleness: StalenessPolicy, ignoreComments: boolean) {
    this.root = root;
    this.staleness = staleness;
    this.ignoreComments = ignoreComments;
  }

  static async create(opts: RegistryOptions): Promise<Registry> {
    const file = await readConfigFile(opts.root);
    const configured =
      parsePluginList(opts.cliPlugins, process.env.MEMOIZE_PLUGINS) ?? file.plugins ?? {};
    const staleness =
      parseStaleness(process.env.MEMOIZE_STALENESS, "MEMOIZE_STALENESS") ??
      file.staleness ??
      "selective";
    const ignoreComments = file.ignoreComments ?? false;
    validatePluginGroup(configured);
    // A category the user did not configure falls back to its default
    // built-in; a configured category runs exactly the listed plugins.
    const plugins = withDefaultBuiltins(configured);
    const loader = opts.load ?? defaultLoader(opts.root);
    const registry = new Registry(opts.root, staleness, ignoreComments);

    // Load every plugin in category order (ledgers first, so init order is
    // deterministic), checking that each plugin's declared type matches the
    // category it is configured under. Ledgers keep their group structure;
    // within each category (and within each group), config order is
    // preserved: if A is listed before B, A runs first.
    const cfgByPlugin = new Map<BasePlugin, PluginConfig>();
    const loadCfg = async (type: PluginType, cfg: PluginConfig): Promise<BasePlugin> => {
      const p = await loadOne(cfg.id, cfg.options ?? {}, loader);
      if (p.type !== type) {
        throw new Error(
          `plugin "${cfg.id}" declares type "${p.type}" but is configured under "${type}"`,
        );
      }
      cfgByPlugin.set(p, cfg);
      return p;
    };
    const loadCategory = async <P extends BasePlugin>(
      type: PluginType,
      configs: PluginConfig[] = [],
    ): Promise<P[]> => {
      const out: P[] = [];
      for (const cfg of configs) out.push(await loadCfg(type, cfg) as P);
      return out;
    };

    const ledgerGroups: LedgerPlugin[][] = [];
    for (const entry of plugins.ledgers ?? []) {
      const groupCfgs = Array.isArray(entry) ? entry : [entry];
      const group: LedgerPlugin[] = [];
      for (const cfg of groupCfgs) group.push((await loadCfg("ledger", cfg)) as LedgerPlugin);
      ledgerGroups.push(group);
    }
    registry.ledgerGroups = ledgerGroups;
    registry.ledgers = ledgerGroups.flat();
    if (registry.ledgers.length === 0) {
      throw new Error("no ledger plugin enabled (default: @naevic/agent-memoize/file-ledger)");
    }
    registry.primaryDb = registry.ledgers[0];

    registry.producers = await loadCategory<ProducerPlugin>("producer", plugins.producers);
    registry.writers = await loadCategory<WriterPlugin>("writer", plugins.writers);
    registry.filters = await loadCategory<FilterPlugin>("filter", plugins.filters);
    registry.organizers = await loadCategory<OrganizerPlugin>("organizer", plugins.organizers);
    registry.observers = await loadCategory<ObserverPlugin>("observer", plugins.observers);

    if (registry.producers.length === 0) {
      throw new Error("no producer plugin enabled (default: @naevic/agent-memoize/agent-producer)");
    }
    if (registry.writers.length === 0) {
      throw new Error("no writer plugin enabled (default: @naevic/agent-memoize/markdown-writer)");
    }

    // Ledgers init first so ctx.db is set before other plugins run.
    const ordered = [
      ...registry.ledgers,
      ...registry.producers,
      ...registry.writers,
      ...registry.filters,
      ...registry.organizers,
      ...registry.observers,
    ];
    registry.initOrder.push(...ordered);
    for (const plugin of ordered) {
      await plugin.init?.(registry.ctxFor(plugin, cfgByPlugin.get(plugin)?.options ?? {}));
    }
    return registry;
  }

  private ctxFor(plugin: BasePlugin, options: Record<string, unknown>): PluginContext {
    const registry = this;
    return {
      root: this.root,
      options,
      db: this.primaryDb,
      log(level, msg) {
        console.error(`[memoize:${plugin.id}] ${level}: ${msg}`);
      },
      registerTool(name, schema, handler, description) {
        const full = `memoize_${plugin.id}_${name}`;
        if (!/^[a-z0-9_-]+$/.test(name)) {
          throw new Error(`invalid tool name "${name}" from plugin "${plugin.id}"`);
        }
        if (RESERVED_TOOLS.has(full) || registry.tools.some((t) => t.name === full)) {
          throw new Error(`tool name collision: "${full}" (plugin "${plugin.id}")`);
        }
        registry.tools.push({ name: full, schema, handler, description });
      },
    };
  }

  async shutdown(): Promise<void> {
    for (const plugin of [...this.initOrder].reverse()) {
      try {
        await plugin.shutdown?.();
      } catch (e) {
        console.error(`[memoize] shutdown of ${plugin.id} failed: ${String(e)}`);
      }
    }
  }
}

// ---------- config loading ----------

/** Config keys as documented (writers before ledgers); used in error messages. */
const DOC_KEYS = ["producers", "writers", "ledgers", "filters", "organizers", "observers"];

const PLUGINS_SHAPE = `an object keyed by plugin category (${DOC_KEYS.join(", ")})`;

async function readConfigFile(root: string): Promise<{
  plugins?: PluginConfigGroup;
  staleness?: StalenessPolicy;
  ignoreComments?: boolean;
}> {
  const p = path.join(storePath(root), "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${p}: ${String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid .agent-memoize/config.json: not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("invalid .agent-memoize/config.json: expected an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) {
    throw new Error(`unsupported config version: ${String(obj.version)}`);
  }
  const out: {
    plugins?: PluginConfigGroup;
    staleness?: StalenessPolicy;
    ignoreComments?: boolean;
  } = {};
  if (obj.plugins !== undefined) {
    if (typeof obj.plugins !== "object" || obj.plugins === null || Array.isArray(obj.plugins)) {
      throw new Error(
        `invalid .agent-memoize/config.json: plugins must be ${PLUGINS_SHAPE}`,
      );
    }
    out.plugins = obj.plugins as PluginConfigGroup;
  }
  if (typeof obj.staleness === "string") {
    out.staleness = parseStaleness(obj.staleness, "staleness in .agent-memoize/config.json")!;
  }
  if (typeof obj.ignoreComments === "boolean") out.ignoreComments = obj.ignoreComments;
  return out;
}

function parsePluginList(
  cliPlugins: string | undefined,
  envPlugins: string | undefined,
): PluginConfigGroup | null {
  const raw = cliPlugins ?? envPlugins;
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `--plugins/MEMOIZE_PLUGINS must be JSON of the form { "producer": [{ "id": "..." }], ... }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--plugins/MEMOIZE_PLUGINS must be ${PLUGINS_SHAPE}`);
  }
  return parsed as PluginConfigGroup;
}

function parseStaleness(v: string | undefined, source: string): StalenessPolicy | null {
  if (v === undefined) return null;
  if (!STALENESS_POLICIES.includes(v as StalenessPolicy)) {
    throw new Error(`${source} must be one of: ${STALENESS_POLICIES.join(", ")}`);
  }
  return v as StalenessPolicy;
}

function validatePluginGroup(group: PluginConfigGroup): void {
  const seen = new Set<string>();
  const checkEntry = (cfg: PluginConfig): void => {
    if (
      typeof cfg !== "object" ||
      cfg === null ||
      typeof cfg.id !== "string" ||
      cfg.id === ""
    ) {
      throw new Error(`invalid plugin entry: ${JSON.stringify(cfg)}`);
    }
    if (seen.has(cfg.id)) throw new Error(`duplicate plugin id: "${cfg.id}"`);
    seen.add(cfg.id);
  };
  for (const key of Object.keys(group)) {
    if (!(DOC_KEYS as string[]).includes(key)) {
      throw new Error(`unknown plugin category: "${key}"`);
    }
    const list = (group as Record<string, unknown>)[key];
    if (!Array.isArray(list)) {
      throw new Error(`plugin category "${key}" must be an array`);
    }
    if (key === "ledgers") {
      // Each element is either a plugin entry (a one-ledger group) or a
      // non-empty array of entries (a group queried together).
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (Array.isArray(entry)) {
          if (entry.length === 0) throw new Error(`ledger group ${i} is empty`);
          for (const cfg of entry) checkEntry(cfg as PluginConfig);
        } else {
          checkEntry(entry as PluginConfig);
        }
      }
    } else {
      for (const cfg of list) checkEntry(cfg as PluginConfig);
    }
  }
}

/**
 * Merge per category: an unconfigured category falls back to its default
 * built-in (if any); a configured category — even an empty array — is
 * authoritative.
 */
function withDefaultBuiltins(configured: PluginConfigGroup): PluginConfigGroup {
  return {
    producers: configured.producers ?? DEFAULT_PLUGINS.producers ?? [],
    writers: configured.writers ?? DEFAULT_PLUGINS.writers ?? [],
    ledgers: configured.ledgers ?? DEFAULT_PLUGINS.ledgers ?? [],
    filters: configured.filters ?? DEFAULT_PLUGINS.filters ?? [],
    organizers: configured.organizers ?? DEFAULT_PLUGINS.organizers ?? [],
    observers: configured.observers ?? DEFAULT_PLUGINS.observers ?? [],
  };
}

async function loadOne(
  id: string,
  options: Record<string, unknown>,
  loader: PluginLoader,
): Promise<BasePlugin> {
  const p = await loader(id, options);
  if (!p || typeof p.id !== "string" || p.id === "") {
    throw new Error(`plugin "${id}" does not declare an id`);
  }
  return p;
}

// ---------- loading ----------

function defaultLoader(root: string): PluginLoader {
  return async (id, options) => {
    const builtin = BUILTIN_MODULES[id];
    if (builtin) return (await builtin()).createPlugin();
    return loadExternal(id, options, root);
  };
}

async function loadExternal(
  id: string,
  options: Record<string, unknown>,
  root: string,
): Promise<BasePlugin> {
  const spec = resolveSpecifier(id, root);
  const mod: unknown = await import(spec);
  const m = mod as Record<string, unknown>;
  let exported = m.plugin ?? m.default;
  if (typeof exported === "function") exported = await exported(options);
  if (!exported || typeof exported !== "object") {
    throw new Error(`plugin "${id}" must export { plugin } or a default plugin object/factory`);
  }
  return exported as BasePlugin;
}

function resolveSpecifier(id: string, root: string): string {
  if (id.startsWith("/") || id.startsWith("file:")) return id;
  const serverRequire = createRequire(import.meta.url);
  try {
    return serverRequire.resolve(id);
  } catch {
    // fall through to project resolution
  }
  try {
    const projectRequire = createRequire(path.join(root, "package.json"));
    return projectRequire.resolve(id);
  } catch {
    throw new Error(
      `cannot resolve plugin "${id}": not found in the server or the project (node_modules)`,
    );
  }
}

// ---------- prompt snippet injection ----------

/** Core tools whose descriptions plugins can append guidance to via `prompts`. */
export const PROMPT_TARGETS = ["status", "recall", "update", "invalidate"] as const;

/**
 * Group the `prompts` snippets of every enabled plugin (any category) by
 * target tool, preserving init order (ledgers first). Each snippet becomes a
 * "## <Category> guidance (<plugin id>)" section of that tool's description.
 */
export function toolPromptSections(plugins: BasePlugin[]): Record<
  (typeof PROMPT_TARGETS)[number],
  string[]
> {
  const sections = {
    status: [],
    recall: [],
    update: [],
    invalidate: [],
  } as Record<(typeof PROMPT_TARGETS)[number], string[]>;
  const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  for (const p of plugins) {
    if (!p.prompts) continue;
    for (const op of PROMPT_TARGETS) {
      const text = p.prompts[op];
      if (text) sections[op].push(`## ${label(p.type)} guidance (${p.id})\n${text}`);
    }
  }
  return sections;
}

// ---------- per-root default registry (used by service/status entry points) ----------

const registryCache = new Map<string, Promise<Registry>>();

export function getRegistry(root: string): Promise<Registry> {
  let p = registryCache.get(root);
  if (!p) {
    p = Registry.create({ root });
    registryCache.set(root, p);
  }
  return p;
}
