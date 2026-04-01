#!/usr/bin/env bash
# Unbrowse installer — curl -fsSL https://unbrowse.ai/install.sh | bash
set -e

REPO="https://github.com/unbrowse-ai/unbrowse.git"
INSTALL_DIR="${UNBROWSE_DIR:-$HOME/.claude/skills/unbrowse}"

# ─── Colors ───────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN="\033[32m" RED="\033[31m" CYAN="\033[36m" BOLD="\033[1m" RESET="\033[0m"
else
  GREEN="" RED="" CYAN="" BOLD="" RESET=""
fi

info() { printf "${CYAN}[unbrowse]${RESET} %s\n" "$*"; }
fail() { printf "${RED}[unbrowse]${RESET} %s\n" "$*" >&2; exit 1; }
ok()   { printf "${GREEN}[unbrowse]${RESET} %s\n" "$*"; }

# ─── Prerequisites ────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git is required. Install it: https://git-scm.com/"

BUN_OK=0; NODE_OK=0
command -v bun  >/dev/null 2>&1 && BUN_OK=1
command -v node >/dev/null 2>&1 && NODE_OK=1

if [ "$BUN_OK" -eq 0 ] && [ "$NODE_OK" -eq 0 ]; then
  fail "Node.js (v18+) or Bun is required.
  Install Node.js: https://nodejs.org/
  Install Bun:     https://bun.sh/"
fi

# ─── Clone or update ──────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || git -C "$INSTALL_DIR" fetch origin && git -C "$INSTALL_DIR" reset --hard origin/HEAD
else
  info "Installing to $INSTALL_DIR..."
  git clone --single-branch --depth 1 "$REPO" "$INSTALL_DIR"
fi

# ─── Run setup ────────────────────────────────────────────────
exec "$INSTALL_DIR/setup" "$@"
