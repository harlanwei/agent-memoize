[English](plugins.md) | 中文

# 插件

你可以通过配置插件来定制 `agent-memoize` 的工作方式。服务器是一条插件流水线：每项能力都由某个已启用的插件提供。内置插件随 `@naevic/agent-memoize` 包一起发布，使用 `@naevic/agent-memoize/` 前缀的 id；第三方插件以 npm 包的形式加载。

插件分为六个类别：

| 类别 | 作用 |
| --- | --- |
| `producers` | 事实来源（sources of truth）：生成记忆所依据的事实（truth），或告诉主 agent 如何生成，并把结果交给主 agent；也可以注册额外的 MCP 工具（例如基于 LSP 的分析） |
| `writers` | 定义记忆的表示形式，并把用于产出该形式的 agent 指令注入到 `memoize_update` 的描述中。配置中的第一个 writer 是主写入器：它的 `render` 决定召回内容的形态，其余 writer 只做标注 |
| `ledgers` | 持久化条目和基线。ledger 按组组织——召回按顺序尝试各组（组内并行查询，排在前面的胜出）；写入只进入第一个 ledger |
| `filters` | 检索策略：对召回候选进行把关、排序、丢弃或标注。多个 filter 按配置顺序串联 |
| `organizers` | 在操作结果（`status` / `recall` / `update` / `invalidate`）返回给 agent 之前对其进行处理，以便给 agent 额外指引——例如是否应更新记忆。插件按配置顺序串联，每个插件都能看到上一个插件的输出 |
| `observers` | 可观测性：记忆被创建/刷新时触发 `onMemoryCreated`，agent 召回记忆时触发 `onMemoryAccessed`。钩子是尽力而为的——失败只记录日志，绝不导致致命错误 |

当 agent 需要新信息时：
1. 从 *producers* 获取事实（truth）
2. 使用 *writers* 格式化事实
3. 使用 *ledgers* 持久化事实

当 agent 召回记忆时：
1. 使用 *filters* 过滤记忆

有时，在收到指示时，agent 会使用 *organizers* 整理记忆，并通过 *observers* 留下它与 `agent-memoize` 交互的痕迹。

### Producer 插件

Producer 插件是事实来源（sources of truth）。每个 producer 要么直接生成 truth——例如通过暴露一个基于 LSP 的 MCP 工具——要么告诉主 agent 如何生成。生成的 truth 会提供给主 agent，由主 agent 查看后决定下一步——通常是用 `memoize_update` 写入或刷新条目。

**`@naevic/agent-memoize/agent-producer`**（内置，默认）——默认的事实来源。它在 `memoize_update` 的指引中要求主 agent 派生子 agent，目标是围绕条目主题探索项目，并把子 agent 的发现作为写入该条目的 truth。它还会检查 `sources`；当一个条目的 sources 合计匹配超过 20 个文件时给出提示，因为覆盖范围过大会让条目容易过期。

### Writer 插件

**`@naevic/agent-memoize/markdown-writer`**（内置，默认）——自由格式 markdown + 重新验证指引。

### Ledger 插件

**`@naevic/agent-memoize/file-ledger`**（内置，默认）——把条目持久化为 `.agent-memoize/` 下的 markdown 文件，外加一个由机器管理的 `manifest.json`。

ledger 按**组**组织——每个 `ledgers` 条目可以是单个 ledger 或一个 ledger 数组，所以 `"ledgers": [ ledger1, [ledger2, ledger3], ledger4 ]` 定义了三组：`[ledger1]`、`[ledger2, ledger3]`、`[ledger4]`。召回按顺序尝试各组，停在第一个经 filter 链过滤后仍有所需信息的组：组内的 ledger 并行查询、按条目名合并，因此同一组内两个 ledger 内容矛盾时，排在前面的那个胜出；如果该组的候选全部被 filter 过滤掉，则继续尝试下一组。写入（`memoize_update` / `memoize_invalidate`）只进入第一组的第一个 ledger；把记忆移植到其他 ledger 是 organizer 的职责。

### Filter 插件

**`@naevic/agent-memoize/stale-filter`**（内置，默认）——过期（staleness）把关的锚点：召回时绝不会返回过期内容，这个插件就是其他 filter 围绕其组合的链路位置。

### Organizer 插件

**`@naevic/agent-memoize/dream-organizer`**（内置，默认）——当过期/挂起的记忆累积到可配置的数量（默认 15 条）时，`memoize_status` 会额外返回一个 `dreaming` 部分，指示 agent 派生子 agent，对照这些记忆的当前源文件逐一验证，并把它们重组成更精简的形式。它开箱即用；如需调整阈值，可以通过 options 配置：

```json
{
  "version": 1,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [
      { "id": "@naevic/agent-memoize/dream-organizer", "options": { "threshold": 15 } }
    ],
    "observers": []
  }
}
```

### Observer 插件

**`@naevic/agent-memoize-plugin-log-observer`**——记录每一次记忆创建/刷新和每一次召回访问，并启动一个 HTTP 仪表盘用于查看这些日志。默认情况下不启用任何 observer 插件。

```sh
npm install -g @naevic/agent-memoize-plugin-log-observer
```

```json
{
  "version": 1,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [{ "id": "@naevic/agent-memoize/dream-organizer" }],
    "observers": [
      { "id": "@naevic/agent-memoize-plugin-log-observer", "options": { "port": 8888 } }
    ]
  }
}
```

打开 `http://127.0.0.1:8888` 即可查看活动流（每 2 秒自动刷新）。原始日志可从 `/api/logs` 获取；同时也会以 JSONL 形式追加写入 `.agent-memoize/logs/dashboard.jsonl`——该 JSONL 文件是共享的事实来源，仪表盘每次轮询都会读取它的新增内容。启动时，仪表盘会从该文件回放最近的 `maxLogs` 条记录，因此以往 agent 会话的历史仍然可见。

**多个 agent 共用同一个项目**：当另一个 agent 的会话已经在为同一项目提供仪表盘时（通过探测所配置端口 `/api/logs` 返回的 `project` 字段来判定），新实例不会再启动第二个 HTTP 服务器——它会切换为仅记录日志模式，把记录追加到共享的 JSONL 文件，运行中的仪表盘会在约 2 秒内拾取到它们。如果端口被无关服务占用，仪表盘则会回退到随机端口，并在日志中打印新的 URL。

每条日志记录都带有一个 `accessor` 字段，标识执行该操作的 MCP 客户端（例如 `claude-code`、`codex`），显示在仪表盘的 agent 列中。

**信任模型**：插件以完整的用户权限运行，与 MCP 服务器本身完全一样。只启用你信任的包。插件注册的工具会以 `memoize_<pluginId>_<name>` 为命名空间，因此绝不会遮蔽核心工具。

## 配置插件

编辑 `.agent-memoize/config.json` 即可配置插件。默认插件配置如下：

```json
{
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [{ "id": "@naevic/agent-memoize/dream-organizer" }],
    "observers": []
  }
}
```

`plugins` 字段按类别对插件分组；每个类别内部，插件按列出的顺序运行。未配置的类别会回退到它的默认内置插件。已配置的类别则只运行你列出的插件。例如，`"writers": []` 会让 writers 类别保持为空，而 `"writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }]` 会替换它的默认插件。

`producers`、`writers` 和 `ledgers` 三个类别不能为空：其中任何一个最终为空，启动都会失败。优先级：配置文件 < `MEMOIZE_PLUGINS` 环境变量（与配置文件形状相同）< `--plugins <json>` CLI 参数。

**`id` 如何解析**：以 `@naevic/agent-memoize/` 开头的 id 是内置插件，在内部解析。其余一律通过 `import()` 加载——可以是 npm 包名（先相对于服务器解析，再相对于项目的 `node_modules` 解析），也可以是本地构建产物的绝对路径或 `file:` URL（用于开发）。插件模块可以导出 `{ plugin }`、默认导出一个插件对象，或默认导出一个工厂函数 `(options) => plugin`。配置中的 `id` 只是模块说明符（specifier）；插件自身声明它注册时使用的 id（例如 `@naevic/agent-memoize-plugin-log-observer` 包声明为 `dashboard`），这个 id 会出现在日志和插件工具名中。插件的 id 和类型在启动时校验（插件必须配置在它所属的类别下）；加载或初始化失败会让服务器带着明确的错误信息中止（快速失败）。

## 创建自定义插件

```ts
import type { LedgerPlugin, PluginContext } from "@naevic/agent-memoize";

export const plugin: LedgerPlugin = {
  id: "my-db",
  version: "1.0.0",
  type: "ledger",
  async init(ctx: PluginContext) {
    // ctx.root、ctx.options、ctx.registerTool、ctx.log、ctx.db
  },
  async listEntries() { /* -> { entries, invalid } */ },
  async readEntry(name) { /* -> Entry | null */ },
  async writeEntry(entry) { /* ... */ },
  async deleteEntry(name) { /* -> boolean */ },
  async loadManifest() { /* -> Manifest */ },
  async saveManifest(m) { /* ... */ },
  async withLock(fn) { /* -> fn() */ },
};
```

`Entry` 和 `Manifest` 是核心数据契约（`src/types.ts`）：producers 生成写入条目所依据的 truth，writers 塑造 `entry.content`，ledgers 存储条目，filters 对它们排序。

### 使用未发布的本地插件

要使用尚未发布到 npm 的插件（例如 `@naevic/agent-memoize-plugin-log-observer` 的开发版本），请把配置中的 id 指向它的**构建产物**入口文件，而不是包名：

```sh
# 在插件的仓库中：先构建，确保 dist/ 是最新的
npm run build          # 在核心仓库中运行会同时构建核心与插件包
```

```json
{
  "version": 1,
  "plugins": {
    "producers": [{ "id": "@naevic/agent-memoize/agent-producer" }],
    "writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }],
    "ledgers": [{ "id": "@naevic/agent-memoize/file-ledger" }],
    "filters": [{ "id": "@naevic/agent-memoize/stale-filter" }],
    "organizers": [{ "id": "@naevic/agent-memoize/dream-organizer" }],
    "observers": [
      {
        "id": "/path/to/agent-memoize-plugin-log-observer/dist/index.js",
        "options": { "port": 8888 }
      }
    ]
  }
}
```

注意事项：

- `id` 可以是绝对路径或 `file:` URL（例如 `file:///home/you/dev/.../dist/index.js`）。
- 路径必须指向**编译后**的产物（`dist/index.js`），而不是 TypeScript 源码。
- 修改插件后要重新构建——服务器通过 `import()` 加载该文件，不会监听文件变化。
- 配置中的 `id` 只是模块说明符（specifier）（内置 id、npm 包名或路径）；插件自身声明它注册时使用的 id（例如 `dashboard`），这个 id 会出现在日志和插件工具名中。
- 插件发布后，只需把 `id` 换成包名（`@naevic/agent-memoize-plugin-log-observer`）并安装——配套插件的 README 中给出了发布后的配置形式。
