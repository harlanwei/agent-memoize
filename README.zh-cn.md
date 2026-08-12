# @naevic/agent-memoize

[English](README.md) | 中文

`@naevic/agent-memoize` 是一个 MCP 服务器，为编程 AI agent 提供项目级记忆功能。

![`agent-memoize` 派上用场的示例](docs/static/introduction.png)

## 背景

每次编程 agent 新开会话都要重新分析项目，白白浪费上下文不说，对于大型项目来说还会耗费大量时间。而且，除非你明确让它把你的选择记下来，agent 不会记住你过往的决定。

`agent-memoize` 的思路很简单：为它们提供一个小巧、持久的记忆库。agent 阅读代码时按主题写下笔记，下次会话直接读取这些笔记，不必重新扫描代码库。记忆库是**共享**的，连接到该项目的每个 agent 读写同一份记忆，且每条记忆都会记录是哪个 agent 写的。

难处理的是 *过期* 问题：你（或一次 `git pull`、另一个 agent）都可能在 agent 不知情的情况下改动项目。`agent-memoize` 用代码解决这个问题，而不是靠提示词里的文字约定：

- 每条记忆都声明它派生自哪些文件。
- 会话开始时，MCP 服务器会做一次开销很低的检查，精确报告哪些文件发生了变化、哪些记忆已过期。
- 过期记忆绝不会被提供给 agent：MCP 服务器会返回变更的源文件，让 agent 重新阅读，所以最坏情况只是回退到 agent 的默认行为。
- 记录用户决策的记忆永远不会因文件变更而失效，只有用户自己推翻它才会。

记忆内容严格按需进入 agent 的上下文，且工具输出很精简，不使用记忆库时几乎不占用上下文。

## 快速开始（macOS、Linux、WSL）

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/harlanwei/agent-memoize/main/install.sh)
```

非 WSL 环境下的 Windows 用户需要手动安装。

## 安装

### 自动安装（macOS、Linux、WSL）

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/harlanwei/agent-memoize/main/install.sh)
```

安装完成后，`agent-memoize` 会自动对所有项目启用。

| 可选参数 | 作用 |
| --- | --- |
| `--agent claude,codex` | 只配置列出的 agent（不做探测，不弹询问） |
| `--yes` | 自动确认所有提示 |

### 手动安装（macOS、Linux、Windows）

<details>
<summary>展开</summary>

### 第 1 步：把它安装到你的电脑上

```sh
npm install -g @naevic/agent-memoize
```

### 第 2 步：把你的编程 agent 配置为 MCP 客户端

**Claude Code** —— 项目中的 `.mcp.json`（用户级配置则用 `~/.claude.json`）：

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

**Codex** —— `~/.codex/config.toml`：

```toml
[mcp_servers.agent-memoize]
command = "npx"
args = ["-y", "@naevic/agent-memoize"]
```

**OpenCode** —— 项目根目录的 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "agent-memoize": {
        "type": "local",
        "command": ["npx", "-y", "@naevic/agent-memoize"]
      }
    }
  }
}
```

也可以用 CLI 添加：`opencode mcp add agent-memoize -- npx -y @naevic/agent-memoize`。

**Pi coding agent** —— 先安装 `pi-mcp-adapter` 扩展，然后重启 Pi：

```sh
pi install npm:pi-mcp-adapter
```

没有它，Pi 不会加载任何 MCP 服务器。安装后，该适配器会自动读取标准 MCP 配置文件，因此 Claude Code 的项目配置可以直接使用——项目中的 `.mcp.json`（用户级配置则用 `~/.config/mcp/mcp.json`）：

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

**DeepSeek Harness** ——（待补充）

**Kimi Code** —— `~/.kimi-code/mcp.json`（用户级）或 `<project>/.kimi-code/mcp.json`（项目级）：

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "npx",
      "args": ["-y", "@naevic/agent-memoize"]
    }
  }
}
```

也可以用 CLI 添加：`kimi mcp add agent-memoize -- npx -y @naevic/agent-memoize`。

**ZCode** —— 在工作区配置 `<project>/.zcode/config.json` 中声明：

```json
{
  "mcp": {
    "servers": {
      "agent-memoize": {
        "command": "npx",
        "args": ["-y", "@naevic/agent-memoize"]
      }
    }
  }
}
```

ZCode 也接受 `<project>/.agents/mcp.json` 中标准的 `mcpServers` 结构，还可以通过 MCP Servers 页面上的 Import 按钮，从 Claude Code、Codex 或 OpenCode 的配置中导入已有服务器。

**从本地仓库检出运行**（开发）：

```json
{
  "mcpServers": {
    "agent-memoize": {
      "command": "node",
      "args": ["/path/to/agent-memoize/dist/index.js"]
    }
  }
}
```

### 第 3 步：让编程 agent 知晓这套工作流

把下面这段内容添加到项目的 `AGENTS.md`（大多数编码 agent 都会读，包括 Codex、OpenCode、 Pi、ZCode 和 Kimi Code）或 `CLAUDE.md`（Claude Code）中，让 agent 采用这套工作流：

```markdown
<!-- agent-memoize:start -->
## Project memory (agent-memoize MCP)

- At session start, call `memoize_status` once. If entries are stale, re-read only the listed
  files — do not rescan the project. `verified` entries are already fresh (auto re-baselined);
  `suspended` entries need their sources fixed via `memoize_update`.
- Before exploring the codebase, call `memoize_recall`. Recall a topic before reading the files
  it describes; if the memory is fresh and sufficient, skip reading them.
- After editing files, call `memoize_update` for each affected entry (kind="file", with
  `sources`). Create entries as you learn the project: architecture, conventions, gotchas.
- Record user decisions and preferences with `memoize_update` (kind="decision", no sources).
- Memory guides navigation only: always read a file before editing it, even if memory
  describes it.
<!-- agent-memoize:end -->
```

或者，更好的做法是用 CLI 直接注入：

```sh
agent-memoize --inject                       # 当前项目：AGENTS.md 和 CLAUDE.md
                                             # （缺失时会自动创建）
agent-memoize --inject global                # PATH 上已安装的每个受支持 agent 的全局提示词
agent-memoize --inject global:claude,codex   # ……或只注入列出的 agent
```
</details>

## 配置

`.agent-memoize/config.json`：

```json
{
  "version": 1,
  "staleness": "claims",
  "ignoreComments": false,
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

`plugins` 字段按类别对插件分组，上面的六个键就是六个类别；每个类别内部，插件按列出的顺序运行。未配置的类别会回退到它的默认内置插件——上面的示例就是完整的默认流水线，完全不配置时也是如此。已配置的类别则只运行你列出的插件：`"writers": []` 会让 writers 类别保持为空，而 `"writers": [{ "id": "@naevic/agent-memoize/markdown-writer" }]` 会替换它的默认插件。`producers`、`writers` 和 `ledgers` 三个类别是必需的：其中任何一个最终为空，启动就会失败。优先级：配置文件 < `MEMOIZE_PLUGINS` 环境变量（与配置文件形状相同）< `--plugins <json>` CLI 参数。

**`id` 如何解析**：以 `@naevic/agent-memoize/` 开头的 id 是内置插件，在内部解析。其余一律通过 `import()` 加载——可以是 npm 包名（先相对于服务器解析，再相对于项目的 `node_modules` 解析），也可以是本地构建产物的绝对路径或 `file:` URL（用于开发）。插件模块可以导出 `{ plugin }`、默认导出一个插件对象，或默认导出一个工厂函数 `(options) => plugin`。配置中的 `id` 只是模块说明符（specifier）；插件自身声明它注册时使用的 id（例如 `@naevic/agent-memoize-plugin-log-observer` 包声明为 `dashboard`），这个 id 会出现在日志和插件工具名中。插件的 id 和类型在启动时校验（插件必须配置在它所属的类别下）；加载或初始化失败会让服务器带着明确的错误信息中止（快速失败）。

## 插件

服务器是一条插件流水线：每项能力都由某个已启用的插件提供，因此各项功能可以非互斥地组合，并在各自的类别内按照列出的顺序运行（靠前的先执行）。内置插件随 `@naevic/agent-memoize` 包一起发布，使用 `@naevic/agent-memoize/` 前缀的 id；第三方插件以 npm 包的形式加载。

| 类别 | 作用 |
| --- | --- |
| `producers` | 产生并规范化成为记忆的原始输入；也可以注册额外的 MCP 工具（例如语言服务器类的数据源） |
| `writers` | 定义记忆的表示形式，并把用于产出该形式的 agent 指令注入到 `memoize_update` 的描述中。配置中的第一个 writer 是主写入器：它的 `render` 决定召回内容的形态，其余 writer 只做标注 |
| `ledgers` | 持久化条目和基线。ledger 按组组织——召回按顺序尝试各组（组内并行查询，排在前面的胜出）；写入只进入第一个 ledger |
| `filters` | 检索策略：对召回候选进行把关、排序、丢弃或标注。多个 filter 按配置顺序串联 |
| `organizers` | 在操作结果（`status` / `recall` / `update` / `invalidate`）返回给 agent 之前对其进行处理，以便给 agent 额外指引——例如是否应更新记忆。插件按配置顺序串联，每个插件都能看到上一个插件的输出 |
| `observers` | 可观测性：记忆被创建/刷新时触发 `onMemoryCreated`，agent 召回记忆时触发 `onMemoryAccessed`。钩子是尽力而为的——失败只记录日志，绝不导致致命错误 |

### Producer 插件

**`@naevic/agent-memoize/agent-producer`**（内置，默认）——校验 `memoize_update` 输入、打上来源标签、对过宽的 `sources` glob 做 lint 检查。

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

## 工作原理

### 工具

| 工具 | 用途 |
| --- | --- |
| `memoize_status()` | 会话开始时的检查。返回 `{ state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries }`。`state`：`empty` / `fresh` / `stale`。 |
| `memoize_recall(topic?)` | 不带 topic：返回条目索引（名称、摘要、每条目的 `status`：`fresh` / `verified` / `stale` / `suspended`——不含内容）。带 topic：若条目为 fresh 或 verified 则返回条目内容，否则返回需要重读的变更源文件（已收窄到真正导致该记忆失效的文件）。 |
| `memoize_update(name, content, kind, sources?, summary?, author?)` | 创建/刷新条目，并重建其指纹基线。`kind="file"` 必须提供 `sources`（项目相对路径/glob）。 |
| `memoize_invalidate(name?, confirm)` | 删除单个条目；省略 `name` 时删除整个记忆库。必须传 `confirm=true`——记忆库是共享的。 |

每条目的 `author` 默认为 MCP 客户端的名称（来自协议握手），因此你能看出某条记忆是哪个编码 agent 写的。

### 存储格式

```
.agent-memoize/
  manifest.json        # 每条目的指纹（由机器管理；请勿手动编辑）
  project.md           # 一个条目
  modules/auth.md      # 嵌套名称映射到子目录
  decisions/...
```

条目是带 YAML front matter 的 Markdown——人类可读、便于 diff，无论提交进 git 还是加入 gitignore 都没问题：

```markdown
---
kind: file                    # "file"（派生自代码）| "decision"（来自对话）
sources:
  - src/auth/**               # kind=file 时必填
author: claude-code
updated: 2026-08-06T03:18:57.000Z
summary: 认证流程在 src/auth/login.ts 中使用 JWT 中间件
---
自由格式的 markdown……
```

在安全的前提下，恢复是自动的：

- 文件变了、但其中记忆声明依赖的行（claim lines）仍然完好的，会被**自动重建基线**——记忆保持新鲜，`memoize_status` 会把它列在 `verifiedEntries` 下（召回时视为新鲜）。
- 显式声明的源文件消失、但目录树中其他位置存在内容完全相同的文件时，视为**重命名**：条目的 sources 会自动更新。
- 源文件消失且找不到重命名（或 sources 匹配不到任何文件）时，条目进入**挂起**状态：需要 agent 处理，但不会再永远卡在过期状态。
- 仅有表面改动的变更会在 `cosmeticChanges` 中报告，任何变化都不会对 agent 隐瞒。

只有 `sources` 与变更文件存在交集的条目才会被处理。更新某个条目绝不会清除其他条目的过期状态。写入是原子的，并由短生命周期锁保护，因此多个 agent 可以安全地共享记忆库。配置项：`.agent-memoize/config.json` 中的 `staleness`（或 `MEMOIZE_STALENESS` 环境变量）： `strict` | `claims` | `cosmetic-only`，默认 `claims`。`ignoreComments: true` 还会在计算规范化哈希时，按语言额外剥离整行注释。

## 开发

```sh
npm install
npm run build     # tsc → dist/
npm test          # 先构建，再运行单元测试 + 基于 stdio 的 MCP 集成测试
```

发布：`npm publish`（`prepublishOnly` 会运行构建 + 测试；只有 `dist/` 会随包发布）。
