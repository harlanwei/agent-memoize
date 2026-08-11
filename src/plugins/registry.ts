import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BasePlugin,
  DataSourcePlugin,
  DatabasePlugin,
  FilterPlugin,
  FormatPlugin,
  PluginConfig,
  PluginContext,
  PluginType,
  ToolRegistration,
} from "../plugin.js";
import { storePath } from "../workspace.js";
import type { StalenessPolicy } from "../types.js";

export type { BasePlugin, DataSourcePlugin, DatabasePlugin, FilterPlugin, FormatPlugin };
export type { PluginConfig, PluginContext, PluginRegistryConfig, ToolRegistration } from "../plugin.js";

const BUILTIN_MODULES: Record<string, () => Promise<{ plugin: BasePlugin }>> = {
  files: () => import("./builtin/db-files.js"),
  markdown: () => import("./builtin/format-markdown.js"),
  "core-filter": () => import("./builtin/filter-core.js"),
  agent: () => import("./builtin/datasource-agent.js"),
};

const DEFAULT_PLUGINS: PluginConfig[] = [
  { id: "files", priority: 100 },
  { id: "markdown", priority: 100 },
  { id: "core-filter", priority: 100 },
  { id: "agent", priority: 100 },
];

const RESERVED_TOOLS = new Set([
  "memoize_status",
  "memoize_recall",
  "memoize_update",
  "memoize_invalidate",
]);

const STALENESS_POLICIES: StalenessPolicy[] = ["strict", "claims", "cosmetic-only"];

export type PluginLoader = (id: string, options: Record<string, unknown>) => Promise<BasePlugin>;

export interface RegistryOptions {
  root: string;
  /** --plugins CLI override (JSON array of PluginConfig). */
  cliPlugins?: string;
  /** Injected loader for tests. Defaults to builtins + dynamic import. */
  load?: PluginLoader;
}

export class Registry {
  readonly root: string;
  readonly staleness: StalenessPolicy;
  readonly ignoreComments: boolean;
  datasources: DataSourcePlugin[] = [];
  databases: DatabasePlugin[] = [];
  formats: FormatPlugin[] = [];
  filters: FilterPlugin[] = [];
  tools: ToolRegistration[] = [];
  primaryDb!: DatabasePlugin;

  /** Plugins in init order (databases first, priority desc within each type). */
  private readonly initOrder: BasePlugin[] = [];

  private constructor(root: string, staleness: StalenessPolicy, ignoreComments: boolean) {
    this.root = root;
    this.staleness = staleness;
    this.ignoreComments = ignoreComments;
  }

  static async create(opts: RegistryOptions): Promise<Registry> {
    const file = await readConfigFile(opts.root);
    const plugins =
      parsePluginList(opts.cliPlugins, process.env.MEMOIZE_PLUGINS) ??
      file.plugins ??
      DEFAULT_PLUGINS;
    const staleness = parseStaleness(process.env.MEMOIZE_STALENESS) ?? file.staleness ?? "claims";
    const ignoreComments = file.ignoreComments ?? false;
    validatePluginList(plugins);
    const loader = opts.load ?? defaultLoader(opts.root);
    const registry = new Registry(opts.root, staleness, ignoreComments);

    // Load every configured plugin (type comes from the plugin itself),
    // then fill missing types with the defaults so behavior never degrades.
    const loaded = new Map<string, BasePlugin>();
    const priority = new Map<string, number>();
    for (const cfg of plugins) {
      const p = await loadOne(cfg.id, cfg.options ?? {}, loader);
      loaded.set(cfg.id, p);
      priority.set(cfg.id, cfg.priority);
    }
    for (const def of DEFAULT_PLUGINS) {
      if (loaded.has(def.id)) continue;
      const p = await loadOne(def.id, def.options ?? {}, loader);
      loaded.set(def.id, p);
      priority.set(def.id, def.priority);
    }
    const byType = new Map<PluginType, BasePlugin[]>();
    for (const type of TYPES) byType.set(type, []);
    for (const p of loaded.values()) byType.get(p.type)?.push(p);
    for (const type of TYPES) {
      const sorted = byType
        .get(type)!
        .sort((a, b) => priority.get(b.id)! - priority.get(a.id)!);
      if (type === "database") {
        registry.databases = sorted as DatabasePlugin[];
        if (registry.databases.length === 0) {
          throw new Error("no database plugin enabled (default: files)");
        }
        registry.primaryDb = registry.databases[0];
      } else if (type === "datasource") registry.datasources = sorted as DataSourcePlugin[];
      else if (type === "format") registry.formats = sorted as FormatPlugin[];
      else registry.filters = sorted as FilterPlugin[];
    }

    // Databases init first so ctx.db is set before other plugins run.
    const ordered = [
      ...registry.databases,
      ...registry.datasources,
      ...registry.formats,
      ...registry.filters,
    ];
    registry.initOrder.push(...ordered);
    for (const plugin of ordered) {
      const cfg = plugins.find((c) => c.id === plugin.id);
      await plugin.init?.(registry.ctxFor(plugin, cfg?.options ?? {}));
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

async function readConfigFile(root: string): Promise<{
  plugins?: PluginConfig[];
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
    plugins?: PluginConfig[];
    staleness?: StalenessPolicy;
    ignoreComments?: boolean;
  } = {};
  if (Array.isArray(obj.plugins)) out.plugins = obj.plugins as PluginConfig[];
  if (typeof obj.staleness === "string") out.staleness = obj.staleness as StalenessPolicy;
  if (typeof obj.ignoreComments === "boolean") out.ignoreComments = obj.ignoreComments;
  return out;
}

function parsePluginList(
  cliPlugins: string | undefined,
  envPlugins: string | undefined,
): PluginConfig[] | null {
  const raw = cliPlugins ?? envPlugins;
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("--plugins/MEMOIZE_PLUGINS must be a JSON array of { id, priority, options? }");
  }
  if (!Array.isArray(parsed)) throw new Error("--plugins/MEMOIZE_PLUGINS must be a JSON array");
  return parsed as PluginConfig[];
}

function parseStaleness(v: string | undefined): StalenessPolicy | null {
  if (v === undefined) return null;
  if (!STALENESS_POLICIES.includes(v as StalenessPolicy)) {
    throw new Error(`MEMOIZE_STALENESS must be one of: ${STALENESS_POLICIES.join(", ")}`);
  }
  return v as StalenessPolicy;
}

function validatePluginList(plugins: PluginConfig[]): void {
  const seen = new Set<string>();
  for (const cfg of plugins) {
    if (
      typeof cfg !== "object" ||
      cfg === null ||
      typeof cfg.id !== "string" ||
      cfg.id === ""
    ) {
      throw new Error(`invalid plugin entry: ${JSON.stringify(cfg)}`);
    }
    if (typeof cfg.priority !== "number" || !Number.isFinite(cfg.priority)) {
      throw new Error(`plugin "${cfg.id}": priority must be a finite number`);
    }
    if (seen.has(cfg.id)) throw new Error(`duplicate plugin id: "${cfg.id}"`);
    seen.add(cfg.id);
  }
}

/** Group configs by type; built-in ids are known, external ids classify after load. */
const TYPES: PluginType[] = ["datasource", "database", "format", "filter"];

async function loadOne(
  id: string,
  options: Record<string, unknown>,
  loader: PluginLoader,
): Promise<BasePlugin> {
  const p = await loader(id, options);
  const pathLike = id.startsWith("/") || id.startsWith("file:");
  if (!pathLike && p.id !== id) {
    throw new Error(`plugin "${id}" declares a different id: ${p.id}`);
  }
  return p;
}

// ---------- loading ----------

function defaultLoader(root: string): PluginLoader {
  return async (id, options) => {
    const builtin = BUILTIN_MODULES[id];
    if (builtin) return (await builtin()).plugin;
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
