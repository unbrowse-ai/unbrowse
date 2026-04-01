#!/usr/bin/env bash
# Unbrowse installer — curl -fsSL https://unbrowse.ai/install.sh | bash
set -e

# ─── Colors ───────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN="\033[32m" RED="\033[31m" CYAN="\033[36m" BOLD="\033[1m" RESET="\033[0m"
else
  GREEN="" RED="" CYAN="" RESET="" BOLD=""
fi

info() { printf "${CYAN}[unbrowse]${RESET} %s\n" "$*"; }
fail() { printf "${RED}[unbrowse]${RESET} %s\n" "$*" >&2; exit 1; }
ok()   { printf "${GREEN}[unbrowse]${RESET} %s\n" "$*"; }

# ─── Prerequisites ────────────────────────────────────────────
NPM_OK=0; BUN_OK=0
command -v npm >/dev/null 2>&1 && NPM_OK=1
command -v bun >/dev/null 2>&1 && BUN_OK=1

if [ "$NPM_OK" -eq 0 ] && [ "$BUN_OK" -eq 0 ]; then
  fail "npm or bun is required.
  Install Node.js: https://nodejs.org/ (v18+)
  Install Bun:     https://bun.sh/"
fi

# ─── Install ──────────────────────────────────────────────────
info "Installing unbrowse..."
if [ "$NPM_OK" -eq 1 ]; then
  npm install -g unbrowse@latest
else
  bun install -g unbrowse@latest
fi

# ─── Register skill with agent hosts ─────────────────────────
UNBROWSE_BIN="$(command -v unbrowse 2>/dev/null || true)"
if [ -z "$UNBROWSE_BIN" ]; then
  fail "unbrowse was installed but not found on PATH. Try opening a new terminal."
fi

SKILL_DIR="$(dirname "$(dirname "$UNBROWSE_BIN")")/lib/node_modules/unbrowse"
[ -d "$SKILL_DIR" ] || SKILL_DIR="$(dirname "$(dirname "$UNBROWSE_BIN")")/node_modules/unbrowse"

# Claude Code
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/skills"
  if [ -d "$SKILL_DIR" ]; then
    ln -snf "$SKILL_DIR" "$HOME/.claude/skills/unbrowse"
    ok "Registered with Claude Code"
  fi
fi

# Codex
if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1; then
  mkdir -p "$HOME/.codex/skills"
  if [ -d "$SKILL_DIR" ]; then
    ln -snf "$SKILL_DIR" "$HOME/.codex/skills/unbrowse"
    ok "Registered with Codex"
  fi
fi

# ─── Run setup (Kuri, marketplace registration, server) ──────
info "Running setup..."
exec unbrowse setup "$@"
