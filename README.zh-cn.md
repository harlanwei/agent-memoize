# @naevic/agent-memoize

[English](README.md) | 中文

`@naevic/agent-memoize` 是一个 MCP 服务器，为编程 AI agent 提供项目级记忆功能。

![`agent-memoize` 派上用场的示例](docs/static/introduction.png)

## 背景

编程 agent 经常在每个会话中浪费上下文重新分析同一个项目，对于大型项目来说尤其耗时。而且，除非你明确要求，agent 不会记住你过去的选择。

`agent-memoize` 的思路很简单：为它们提供一个小巧、持久的记忆库。agent 阅读代码时按主题写下笔记，下次会话直接召回这些笔记，而不用重新扫描代码库。记忆库是**共享**的——连接到该项目的每个 agent 都读写同一份记忆，并且每条记忆都会记录是哪个 agent 写的。

难点在于过期问题：你（或一次 `git pull`、另一个 agent）都可能在某个 agent 不知情的情况下改动项目。`agent-memoize` 在代码层面解决这个问题，而不是靠提示词里的文字约定：

- 每条记忆都会声明它派生自哪些文件。
- 会话开始时，MCP 服务器会做一次开销很低的检查，报告哪些记忆源文件发生了变化、哪些记忆已过期。
- 过期记忆绝不会被提供给 agent：MCP 服务器会返回变更的源文件，让 agent 重新阅读，所以最坏情况只是回退到 agent 的默认行为。
- 记录用户决策的记忆永远不会因文件变更而失效，只有用户自己推翻它才会失效。

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

安装完成后，`agent-memoize` 会写入用户级配置，并自动对所有项目启用。

| 可选参数 | 作用 |
| --- | --- |
| `--agent claude,codex` | 只配置列出的 agent（不做探测，也不弹出 agent 选择询问） |
| `--yes` | 自动确认所有提示 |

### 手动安装（macOS、Linux、Windows）

<details>
<summary>展开</summary>

### 第 1 步：安装 npm 包

```sh
npm install -g @naevic/agent-memoize
```

### 第 2 步：连接你的编程 agent 到 MCP 服务器上

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

**OpenCode** —— 用户级 `~/.config/opencode/opencode.json`，或项目根目录的 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-memoize": {
      "type": "local",
      "command": ["npx", "-y", "@naevic/agent-memoize"]
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

**ZCode** —— 用户级 `~/.zcode/cli/config.json`，或工作区级 `<project>/.zcode/config.json`：

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

**DeepSeek Harness (DSH)** —— 现下不提供官方支持。DSH 使用一套单独的插件系统，且仍在早期开发阶段。如果你必须使用 DSH，可以借助其他插件将 MCP 集成到 DSH。请自行承担相关风险。

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

### 第 3 步：让编程 agent 使用记忆工作流

把下面这段内容添加到项目的 `AGENTS.md`（大多数编程 agent 都会读，包括 Codex、OpenCode、Pi、ZCode 和 Kimi Code）或 `CLAUDE.md`（Claude Code）中，让 agent 采用这套工作流：

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
  Producer plugins are sources of truth — follow the producer guidance in the
  `memoize_update` tool description.
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

默认配置对大多数场景已经够用。如果需要更精细地控制 MCP 服务器的行为，请编辑 `.agent-memoize/config.json`：

```json
{
  "version": 1,
  "staleness": "selective", // `selective`（默认）：只有选中行的变更
                            // 才会影响记忆的过期状态。
                            // `strict`：相关文件的变更会影响记忆的过期状态，
                            // 无论这些变更是否发生在选中的行上。
  "ignoreComments": false   // `false`（默认）：注释的变更会影响记忆的过期状态。
                            // `true`：注释的变更不会影响记忆的过期状态。
                            // 编程 agent 有时会在注释里记录它们的改动，
                            // 因此不建议设为 `true`。
}
```

`agent-memoize` 提供插件支持，每项能力都由插件提供。不过，使用自定义插件可能给流水线带来不必要的复杂性。**除非你经验非常丰富，否则强烈建议不要使用自定义插件。**

## 工作原理

### 工具

| 工具 | 用途 |
| --- | --- |
| `memoize_status()` | 会话开始时对记忆源文件的检查。返回 `{ state, mode, changedFiles, addedFiles, deletedFiles, cosmeticChanges, verifiedEntries, suspendedEntries, staleEntries, invalidEntries, truncated }`。文件数组有数量上限；`truncated=true` 表示仍有更多变更。`state`：`empty` / `fresh` / `stale`。 |
| `memoize_recall(topic?)` | 不带 topic：返回条目索引（名称、摘要、每条目的 `status`：`fresh` / `verified` / `stale` / `suspended`——不含内容）。带 topic：若条目为 fresh 或 verified 则返回条目内容，否则返回需要重读的变更源文件（已收窄到真正导致该记忆失效的文件）。 |
| `memoize_update(name, content, kind, sources?, summary?, author?)` | 创建/刷新条目，并重建其指纹基线。`kind="file"` 必须提供 `sources`（项目相对路径/glob）。 |
| `memoize_invalidate(name?, confirm)` | 删除单个条目；省略 `name` 时删除整个记忆库。必须传 `confirm=true`——记忆库是共享的。 |

每条目的 `author` 默认为 MCP 客户端的名称（来自协议握手），因此你能看出某条记忆是哪个编程 agent 写的。

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
- 仅有表面改动的源文件变更会在 `cosmeticChanges` 中报告。

只有 `sources` 与变更文件存在交集的条目才会被处理。更新某个条目绝不会清除其他条目的过期状态。写入是原子的，并由短生命周期锁保护，因此多个 agent 可以安全地共享记忆库。

## 开发

```sh
npm install
npm run build     # tsc → dist/
npm test          # 先构建，再运行单元测试 + 基于 stdio 的 MCP 集成测试
```

发布：`npm publish`（`prepublishOnly` 会运行构建 + 测试；只有 `dist/` 会随包发布）。
