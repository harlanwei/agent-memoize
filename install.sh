#!/usr/bin/env bash
#
# install.sh — automatic installer for @naevic/agent-memoize (README steps 1-3).
#
# Targets Linux and macOS. Runs as the current user; only elevates (sudo) when
# installing a missing dependency, and only after asking.
#
# Usage: ./install.sh [--local] [--agent claude,codex] [--yes]   (see --help)

set -euo pipefail

# ---------------------------------------------------------------------------
# Basics
# ---------------------------------------------------------------------------

info() { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Automates the README install steps 1-3 for @naevic/agent-memoize:
  1. Ensure Node.js >= 18 is available (asks before installing it), then
     npm-install the server globally
  2. Configure your coding agent(s) as MCP clients
  3. Inject the agent-workflow prompt into AGENTS.md / CLAUDE.md and, on
     request, the global agent prompts (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md,
     ~/.config/opencode/AGENTS.md, ~/.kimi-code/AGENTS.md, ~/.zcode/AGENTS.md)

Options:
  --local          Dev mode: configure agents to run this checkout
                   (node dist/index.js) instead of the npm package; skips the
                   global install and builds dist/ if it is missing
  --agent <list>   Only configure the listed agents (comma-separated; no
                   detection or per-agent prompts):
                   claude,codex,opencode,pi,kimi,zcode
  --yes            Approve every prompt automatically (dependency installs,
                   config writes)
  -h, --help       Show this help

Project-scope files (.mcp.json, opencode.json, .kimi-code/mcp.json,
.zcode/config.json, AGENTS.md) are written in the directory you run the script
from; Codex's config is ~/.codex/config.toml. Existing files are backed up to
*.bak before being edited.
EOF
  exit 0
}

ASSUME_YES=0
LOCAL_MODE=0
AGENT_FILTER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local) LOCAL_MODE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --agent)
      [ "$#" -ge 2 ] || die "--agent requires a value (e.g. --agent claude,codex)"
      AGENT_FILTER="${2//,/ }"    # tolerate comma-separated lists
      shift
      ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see ./install.sh --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(pwd)"

case "$(uname -s)" in
  Darwin) OS="macOS" ;;
  Linux)  OS="Linux" ;;
  *) die "Unsupported OS '$(uname -s)' — the installer targets Linux and macOS." ;;
esac

# Package manager used to install a missing Node.js, if any.
PKG_MGR=""
if [ "$OS" = "macOS" ]; then
  command -v brew >/dev/null 2>&1 && PKG_MGR="brew"
else
  command -v apt-get >/dev/null 2>&1 && PKG_MGR="apt"
  command -v dnf >/dev/null 2>&1 && PKG_MGR="dnf"
  command -v pacman >/dev/null 2>&1 && PKG_MGR="pacman"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

confirm() {
  # $1 = prompt text. Returns 0 (yes) or 1 (no). --yes answers yes to all.
  local prompt="$1" answer
  if [ "$ASSUME_YES" -eq 1 ]; then
    printf '%s [Y/n] (--yes)\n' "$prompt"
    return 0
  fi
  printf '%s [Y/n] ' "$prompt"
  read -r answer
  case "$answer" in
    ""|y|Y|yes|Yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

backup_file() {
  # $1 = path; make a one-time .bak copy if the file exists.
  local f="$1"
  if [ -f "$f" ] && [ ! -f "$f.bak" ]; then
    cp "$f" "$f.bak"
  fi
}

json_merge() {
  # $1 = file, $2 = dotted key path, $3 = JSON value. Creates the file if
  # missing; preserves every other key. Uses node (verified present in step 1).
  local file="$1" path="$2" value="$3"
  node -e '
    const fs = require("fs");
    const [file, path, value] = process.argv.slice(1);
    let obj = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw !== "") {
        try { obj = JSON.parse(raw); }
        catch (e) {
          console.error("error: " + file + " is not valid JSON (" + e.message + ")");
          process.exit(1);
        }
      }
    }
    const keys = path.split(".");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = JSON.parse(value);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  ' "$file" "$path" "$value"
}

json_validate() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' "$1"
}

node_major() {
  node --version | sed 's/^v//; s/\..*$//'
}

# Echoes: ok | missing | no-npm | too-old
node_status() {
  if ! command -v node >/dev/null 2>&1; then echo "missing"; return 0; fi
  if ! command -v npm >/dev/null 2>&1; then echo "no-npm"; return 0; fi
  local major
  major="$(node_major 2>/dev/null)" || { echo "missing"; return 0; }
  case "$major" in
    ''|*[!0-9]*) echo "missing"; return 0 ;;
  esac
  if [ "$major" -lt 18 ]; then echo "too-old"; return 0; fi
  echo "ok"
}

install_node() {
  case "$OS" in
    macOS)
      [ "$PKG_MGR" = "brew" ] || die "Homebrew is required to install Node.js on macOS. Install it from https://brew.sh, then re-run."
      brew install node
      ;;
    Linux)
      case "$PKG_MGR" in
        apt)    sudo apt-get update && sudo apt-get install -y nodejs npm ;;
        dnf)    sudo dnf install -y nodejs npm ;;
        pacman) sudo pacman -S --noconfirm nodejs npm ;;
        *) die "No supported package manager found (apt-get/dnf/pacman). Install Node.js >= 18 manually, then re-run." ;;
      esac
      ;;
  esac
  hash -r 2>/dev/null || true
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    die "Node.js was installed but 'node'/'npm' are not on PATH. Open a new shell (or fix PATH), then re-run."
  fi
}

step() {
  printf '\n== Step %s/3: %s ==\n' "$1" "$2"
}

# ---------------------------------------------------------------------------
# Step 1 — Node.js runtime + global install
# ---------------------------------------------------------------------------

step 1 "ensure Node.js and install agent-memoize"

status="$(node_status)"
case "$status" in
  ok) info "Node.js $(node --version) found (>= 18 required)." ;;
  too-old)
    info "Node.js $(node --version) is older than the required v18."
    if confirm "Install/upgrade Node.js now?"; then
      install_node
    else
      die "Node.js >= 18 is required. Install it (e.g. via nvm: https://github.com/nvm-sh/nvm), then re-run."
    fi
    ;;
  no-npm)
    info "Node.js is present but npm is missing."
    if confirm "Install Node.js (which bundles npm) now?"; then
      install_node
    else
      die "npm is required. Install Node.js >= 18, then re-run."
    fi
    ;;
  missing)
    info "The agent-memoize server needs Node.js >= 18, which was not found."
    if confirm "Install Node.js now?"; then
      install_node
    else
      die "Node.js is required. Install it (e.g. via nvm: https://github.com/nvm-sh/nvm), then re-run."
    fi
    ;;
esac

# Re-verify after any install attempt.
status="$(node_status)"
case "$status" in
  ok) : ;;
  too-old) die "Installed Node.js is still older than v18. Use nvm (https://github.com/nvm-sh/nvm) for a current version, then re-run." ;;
  *) die "Node.js setup failed — 'node' and 'npm' must be on PATH. Fix and re-run." ;;
esac

# The MCP server entry (JSON + TOML variants) depends on the mode.
if [ "$LOCAL_MODE" -eq 1 ]; then
  SERVER_JS="$SCRIPT_DIR/dist/index.js"
  if [ ! -f "$SERVER_JS" ]; then
    info "dist/index.js not found in this checkout — building it first."
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
      info "  npm install (first run in this checkout)..."
      (cd "$SCRIPT_DIR" && npm install)
    fi
    info "  npm run build..."
    (cd "$SCRIPT_DIR" && npm run build)
    [ -f "$SERVER_JS" ] || die "Build finished but $SERVER_JS is missing."
  fi
  SERVER_COMMAND="node"
  SERVER_ARGS_JSON="[\"$SERVER_JS\"]"
  OPENCODE_COMMAND_JSON="[\"node\",\"$SERVER_JS\"]"
  TOML_ARGS="\"$SERVER_JS\""
  info "Local mode: agents will run: node $SERVER_JS"
else
  SERVER_COMMAND="npx"
  SERVER_ARGS_JSON="[\"-y\",\"@naevic/agent-memoize\"]"
  OPENCODE_COMMAND_JSON="[\"npx\",\"-y\",\"@naevic/agent-memoize\"]"
  TOML_ARGS="\"-y\", \"@naevic/agent-memoize\""
fi
SERVER_ENTRY_JSON="{\"command\":\"$SERVER_COMMAND\",\"args\":$SERVER_ARGS_JSON}"

if [ "$LOCAL_MODE" -eq 1 ]; then
  info "Skipping 'npm install -g' (--local mode uses this checkout)."
else
  info "Installing the server globally: npm install -g @naevic/agent-memoize"
  if ! npm install -g @naevic/agent-memoize; then
    if confirm "The global npm install failed (often a permissions issue). Retry with sudo?"; then
      if ! sudo npm install -g @naevic/agent-memoize; then
        die "The global install failed even with sudo. Fix npm permissions (https://docs.npmjs.com/resolving-eacces-permissions-errors) and re-run, or use ./install.sh --local."
      fi
    else
      die "Global install failed. Fix npm permissions (https://docs.npmjs.com/resolving-eacces-permissions-errors) and re-run, or use ./install.sh --local."
    fi
  fi
  if command -v agent-memoize >/dev/null 2>&1; then
    info "Installed: $(command -v agent-memoize)"
  else
    warn "The package installed but the 'agent-memoize' binary is not on PATH. It still works via 'npx -y @naevic/agent-memoize'."
  fi
fi

# ---------------------------------------------------------------------------
# Step 2 — MCP client configuration
# ---------------------------------------------------------------------------

step 2 "configure your coding agent(s) as MCP clients"

setup_claude() {   # Claude Code -> .mcp.json (project scope)
  local file="$PROJECT_ROOT/.mcp.json"
  backup_file "$file"
  json_merge "$file" "mcpServers.agent-memoize" "$SERVER_ENTRY_JSON"
  json_validate "$file"
  info "  Claude Code: $file"
}

setup_codex() {    # Codex -> ~/.codex/config.toml (user scope)
  local dir="$HOME/.codex" file="$HOME/.codex/config.toml"
  mkdir -p "$dir"
  if [ -f "$file" ] && grep -qF "[mcp_servers.agent-memoize]" "$file"; then
    info "  Codex: mcp_servers.agent-memoize already present in $file (skipped)"
    return 0
  fi
  backup_file "$file"
  {
    printf '\n[mcp_servers.agent-memoize]\n'
    printf 'command = "%s"\n' "$SERVER_COMMAND"
    printf 'args = [%s]\n' "$TOML_ARGS"
  } >> "$file"
  info "  Codex: $file"
}

setup_opencode() { # OpenCode -> opencode.json (project scope)
  local file="$PROJECT_ROOT/opencode.json"
  backup_file "$file"
  json_merge "$file" "mcp.servers.agent-memoize" "{\"type\":\"local\",\"command\":$OPENCODE_COMMAND_JSON}"
  json_validate "$file"
  info "  OpenCode: $file"
}

setup_pi() {       # Pi -> pi-mcp-adapter + .mcp.json (project scope)
  if confirm "Pi needs the 'pi-mcp-adapter' extension. Install it now (pi install npm:pi-mcp-adapter)?"; then
    if ! pi install npm:pi-mcp-adapter; then
      warn "pi-mcp-adapter install failed — run 'pi install npm:pi-mcp-adapter' later; Pi will not load MCP servers without it."
    fi
  else
    warn "Skipping pi-mcp-adapter; Pi will not load MCP servers without it."
  fi
  local file="$PROJECT_ROOT/.mcp.json"
  backup_file "$file"
  json_merge "$file" "mcpServers.agent-memoize" "$SERVER_ENTRY_JSON"
  json_validate "$file"
  info "  Pi: $file"
}

setup_kimi() {     # Kimi Code -> .kimi-code/mcp.json (project scope)
  local file="$PROJECT_ROOT/.kimi-code/mcp.json"
  mkdir -p "$PROJECT_ROOT/.kimi-code"
  backup_file "$file"
  json_merge "$file" "mcpServers.agent-memoize" "$SERVER_ENTRY_JSON"
  json_validate "$file"
  info "  Kimi Code: $file"
}

setup_zcode() {    # ZCode -> .zcode/config.json (project scope; mcp.servers nesting)
  local file="$PROJECT_ROOT/.zcode/config.json"
  mkdir -p "$PROJECT_ROOT/.zcode"
  backup_file "$file"
  json_merge "$file" "mcp.servers.agent-memoize" "$SERVER_ENTRY_JSON"
  json_validate "$file"
  info "  ZCode: $file"
}

ALL_AGENTS="claude codex opencode pi kimi zcode"
AGENTS=""
if [ -n "$AGENT_FILTER" ]; then
  AGENTS="$AGENT_FILTER"
else
  for a in $ALL_AGENTS; do
    if command -v "$a" >/dev/null 2>&1; then
      AGENTS="$AGENTS $a"
    fi
  done
  if [ -z "$AGENTS" ]; then
    info "No supported coding agents found on PATH (claude, codex, opencode, pi, kimi, zcode)."
    info "Install one and re-run, or pass --agent claude,codex to configure anyway."
  fi
fi

CONFIGURED=""
for a in $AGENTS; do
  if [ -n "$AGENT_FILTER" ] || confirm "Configure $a as an MCP client for agent-memoize?"; then
    case "$a" in
      claude|codex|opencode|pi|kimi|zcode)
        "setup_$a"
        CONFIGURED="$CONFIGURED $a"
        ;;
      *)
        warn "Unknown agent '$a' (supported: claude, codex, opencode, pi, kimi, zcode)"
        ;;
    esac
  else
    info "  Skipped $a."
  fi
done

# ---------------------------------------------------------------------------
# Step 3 — inform the coding agent about the workflow
# ---------------------------------------------------------------------------

step 3 "inform your coding agent about the workflow"

# The server CLI owns the prompt text: `--inject` writes it to the current
# project (AGENTS.md, plus CLAUDE.md when present); `--inject --global` writes
# it to the global agent prompts.
if [ "$LOCAL_MODE" -eq 1 ]; then
  INJECT_CMD=(node "$SERVER_JS")
elif command -v agent-memoize >/dev/null 2>&1; then
  INJECT_CMD=(agent-memoize)
else
  INJECT_CMD=(npx -y @naevic/agent-memoize)
fi

run_inject() {
  if ! "${INJECT_CMD[@]}" "$@"; then
    warn "prompt injection failed: ${INJECT_CMD[*]} $*"
    return 1
  fi
  return 0
}

if confirm "Add the agent workflow block to AGENTS.md and CLAUDE.md (created if missing)?"; then
  run_inject --inject || true
fi

# Global prompts: one file per agent, in the user's home directory.
for a in $CONFIGURED; do
  rel=""
  case "$a" in
    claude)   rel=".claude/CLAUDE.md" ;;
    codex)    rel=".codex/AGENTS.md" ;;
    opencode) rel=".config/opencode/AGENTS.md" ;;
    kimi)     rel=".kimi-code/AGENTS.md" ;;
    zcode)    rel=".zcode/AGENTS.md" ;;
    *) warn "No global prompt file known for $a (skipped)." ;;
  esac
  [ -n "$rel" ] || continue
  if confirm "Inject the workflow prompt into the global prompts for $a (~/$rel)?"; then
    run_inject --inject "global:$a" || true
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '\n== Done ==\n'
if [ "$LOCAL_MODE" -eq 1 ]; then
  info "  Server: this checkout ($SERVER_JS). Rebuild with 'npm run build' after changing src/."
else
  if command -v agent-memoize >/dev/null 2>&1; then
    info "  Server: @naevic/agent-memoize installed globally ($(command -v agent-memoize))."
  else
    info "  Server: @naevic/agent-memoize installed globally (via npx -y)."
  fi
fi
if [ -n "$CONFIGURED" ]; then
  info "  Agents configured:$CONFIGURED"
else
  info "  No agents configured."
fi
info "  Next: restart your coding agent(s) so they load the MCP server, then call"
info "  memoize_status once at the start of your next session."
