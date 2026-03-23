#!/usr/bin/env bash
set -euo pipefail

SELF_URL="https://www.unbrowse.ai/install.sh"
MCP_PACKAGE="@unbrowse/mcp-server"
MCP_NAME="unbrowse"
UNBROWSE_BIN_DEFAULT="${UNBROWSE_BIN:-unbrowse}"

DRY_RUN=0
INSTALL_CLI=1
UPGRADE_CLI=0
FORCE_ALL=0

declare -a REQUESTED_HOSTS=()
declare -a INSTALLED_HOSTS=()
declare -a SKIPPED_HOSTS=()

usage() {
  cat <<'EOF'
Install Unbrowse into supported agent hosts.

Usage:
  install-agent-integrations.sh [options]

Options:
  --all                 Install into all supported hosts
  --cursor              Install MCP into Cursor (~/.cursor/mcp.json)
  --windsurf            Install MCP into Windsurf (~/.codeium/windsurf/mcp_config.json)
  --claude-code         Install MCP into Claude Code via `claude mcp add`
  --claude-desktop      Install MCP into Claude Desktop config
  --codex               Install MCP into Codex via `codex mcp add`
  --openclaw            Install the native OpenClaw plugin via `openclaw plugins install`
  --no-cli              Do not install/upgrade the `unbrowse` CLI
  --upgrade-cli         Force `npm install -g unbrowse@latest`
  --dry-run             Print actions without changing anything
  -h, --help            Show help

Default behavior:
  Detect installed hosts and wire Unbrowse into the ones found.

Examples:
  bash <(curl -fsSL https://www.unbrowse.ai/install.sh)
  bash <(curl -fsSL https://www.unbrowse.ai/install.sh) --all
  bash <(curl -fsSL https://www.unbrowse.ai/install.sh) --cursor --codex
EOF
}

log() {
  printf '[unbrowse-install] %s\n' "$*"
}

warn() {
  printf '[unbrowse-install] WARN: %s\n' "$*" >&2
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

append_host() {
  local host="$1"
  local existing
  for existing in "${REQUESTED_HOSTS[@]-}"; do
    [[ "$existing" == "$host" ]] && return 0
  done
  REQUESTED_HOSTS+=("$host")
}

detect_macos_app() {
  local app_name="$1"
  [[ -d "/Applications/${app_name}.app" ]] || [[ -d "$HOME/Applications/${app_name}.app" ]]
}

detect_cursor() {
  [[ -d "$HOME/.cursor" ]] || detect_macos_app "Cursor"
}

detect_windsurf() {
  [[ -d "$HOME/.codeium/windsurf" ]] || [[ -f "$HOME/.codeium/mcp_config.json" ]] || detect_macos_app "Windsurf"
}

detect_claude_desktop() {
  [[ -f "$HOME/Library/Application Support/Claude/claude_desktop_config.json" ]] || \
  [[ -f "$HOME/.config/Claude/claude_desktop_config.json" ]] || \
  detect_macos_app "Claude"
}

detect_openclaw() {
  has_cmd openclaw
}

detect_hosts() {
  detect_cursor && append_host "cursor"
  detect_windsurf && append_host "windsurf"
  has_cmd claude && append_host "claude-code"
  detect_claude_desktop && append_host "claude-desktop"
  has_cmd codex && append_host "codex"
  detect_openclaw && append_host "openclaw"
}

ensure_cli() {
  [[ "$INSTALL_CLI" -eq 1 ]] || return 0
  has_cmd npm || {
    warn "npm not found; cannot install the unbrowse CLI automatically."
    return 1
  }

  if [[ "$UPGRADE_CLI" -eq 1 ]] || ! has_cmd unbrowse; then
    local spec="unbrowse"
    [[ "$UPGRADE_CLI" -eq 1 ]] && spec="unbrowse@latest"
    log "Installing CLI: npm install -g ${spec}"
    run_cmd npm install -g "$spec"
  else
    log "CLI already present: $(command -v unbrowse)"
  fi
}

upsert_mcp_json() {
  local target="$1"
  local dir
  dir="$(dirname "$target")"
  run_cmd mkdir -p "$dir"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "Would update ${target}"
    return 0
  fi
  if [[ -f "$target" ]]; then
    cp "$target" "${target}.bak"
  fi
  TARGET_JSON="$target" MCP_NAME="$MCP_NAME" MCP_PACKAGE="$MCP_PACKAGE" UNBROWSE_BIN_VALUE="$UNBROWSE_BIN_DEFAULT" node <<'NODE'
const fs = require("fs");
const file = process.env.TARGET_JSON;
const name = process.env.MCP_NAME;
const pkg = process.env.MCP_PACKAGE;
const unbrowseBin = process.env.UNBROWSE_BIN_VALUE || "unbrowse";

let data = {};
if (fs.existsSync(file)) {
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Failed to parse ${file}: ${error.message}`);
    process.exit(1);
  }
}
if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
if (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) {
  data.mcpServers = {};
}
data.mcpServers[name] = {
  command: "npx",
  args: ["-y", pkg],
  env: {
    UNBROWSE_BIN: unbrowseBin,
  },
};
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
NODE
}

install_cursor() {
  upsert_mcp_json "$HOME/.cursor/mcp.json"
  INSTALLED_HOSTS+=("cursor")
}

install_windsurf() {
  local target="$HOME/.codeium/windsurf/mcp_config.json"
  if [[ -f "$HOME/.codeium/mcp_config.json" && ! -d "$HOME/.codeium/windsurf" ]]; then
    target="$HOME/.codeium/mcp_config.json"
  fi
  upsert_mcp_json "$target"
  INSTALLED_HOSTS+=("windsurf")
}

install_claude_desktop() {
  local target
  if [[ "$(uname -s)" == "Darwin" ]]; then
    target="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  else
    target="$HOME/.config/Claude/claude_desktop_config.json"
  fi
  upsert_mcp_json "$target"
  INSTALLED_HOSTS+=("claude-desktop")
}

install_claude_code() {
  if ! has_cmd claude; then
    warn "Claude Code CLI not found; skipping claude-code."
    SKIPPED_HOSTS+=("claude-code")
    return 0
  fi
  run_cmd claude mcp remove --scope user "$MCP_NAME" >/dev/null 2>&1 || true
  run_cmd claude mcp add --scope user --transport stdio -e "UNBROWSE_BIN=${UNBROWSE_BIN_DEFAULT}" "$MCP_NAME" -- npx -y "$MCP_PACKAGE"
  INSTALLED_HOSTS+=("claude-code")
}

install_codex() {
  if ! has_cmd codex; then
    warn "Codex CLI not found; skipping codex."
    SKIPPED_HOSTS+=("codex")
    return 0
  fi
  run_cmd codex mcp remove "$MCP_NAME" >/dev/null 2>&1 || true
  run_cmd codex mcp add --env "UNBROWSE_BIN=${UNBROWSE_BIN_DEFAULT}" "$MCP_NAME" -- npx -y "$MCP_PACKAGE"
  INSTALLED_HOSTS+=("codex")
}

install_openclaw() {
  has_cmd openclaw || {
    warn "OpenClaw CLI not found; skipping openclaw."
    SKIPPED_HOSTS+=("openclaw")
    return 0
  }
  run_cmd openclaw plugins install unbrowse-openclaw
  run_cmd openclaw config set plugins.entries.unbrowse-openclaw.enabled true --strict-json
  run_cmd openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
  run_cmd openclaw config set plugins.entries.unbrowse-openclaw.config.preferInBootstrap true --strict-json
  run_cmd openclaw gateway restart
  INSTALLED_HOSTS+=("openclaw")
}

install_host() {
  case "$1" in
    cursor) install_cursor ;;
    windsurf) install_windsurf ;;
    claude-code) install_claude_code ;;
    claude-desktop) install_claude_desktop ;;
    codex) install_codex ;;
    openclaw) install_openclaw ;;
    *)
      warn "Unknown host: $1"
      SKIPPED_HOSTS+=("$1")
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) FORCE_ALL=1 ;;
    --cursor) append_host "cursor" ;;
    --windsurf) append_host "windsurf" ;;
    --claude-code) append_host "claude-code" ;;
    --claude-desktop) append_host "claude-desktop" ;;
    --codex) append_host "codex" ;;
    --openclaw) append_host "openclaw" ;;
    --no-cli) INSTALL_CLI=0 ;;
    --upgrade-cli) UPGRADE_CLI=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      warn "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ "$FORCE_ALL" -eq 1 ]]; then
  for host in cursor windsurf claude-code claude-desktop codex openclaw; do
    append_host "$host"
  done
fi

if [[ "${#REQUESTED_HOSTS[@]}" -eq 0 ]]; then
  detect_hosts
fi

if [[ "${#REQUESTED_HOSTS[@]}" -eq 0 ]]; then
  warn "No supported hosts detected."
  warn "Use --all or explicit flags like --cursor --codex."
  warn "Installer URL: ${SELF_URL}"
  exit 1
fi

ensure_cli || true

log "Installing into: ${REQUESTED_HOSTS[*]}"
for host in "${REQUESTED_HOSTS[@]}"; do
  install_host "$host"
done

if [[ "${#INSTALLED_HOSTS[@]}" -gt 0 ]]; then
  log "Installed: ${INSTALLED_HOSTS[*]}"
fi
if [[ "${#SKIPPED_HOSTS[@]}" -gt 0 ]]; then
  warn "Skipped: ${SKIPPED_HOSTS[*]}"
fi

log "Next step: restart any open agent apps so they reload MCP/skill config."
