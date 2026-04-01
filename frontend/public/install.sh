#!/usr/bin/env bash
# Unbrowse installer — curl -fsSL https://unbrowse.ai/install.sh | bash
set -e

# ─── Colors ───────────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN="\033[32m" RED="\033[31m" CYAN="\033[36m" RESET="\033[0m"
else
  GREEN="" RED="" CYAN="" RESET=""
fi

info() { printf "${CYAN}[unbrowse]${RESET} %s\n" "$*"; }
fail() { printf "${RED}[unbrowse]${RESET} %s\n" "$*" >&2; exit 1; }
ok()   { printf "${GREEN}[unbrowse]${RESET} %s\n" "$*"; }

# ─── Prerequisites ────────────────────────────────────────────
command -v npm >/dev/null 2>&1 || command -v bun >/dev/null 2>&1 || \
  fail "npm or bun is required.
  Install Node.js: https://nodejs.org/ (v18+)
  Install Bun:     https://bun.sh/"

# ─── Install CLI ──────────────────────────────────────────────
info "Installing unbrowse..."
npm install -g unbrowse@latest 2>/dev/null || bun install -g unbrowse@latest

# ─── Register skill (non-interactive) ────────────────────────
info "Registering skill..."
npx -y skills add unbrowse-ai/unbrowse --yes

# ─── Start server (auto-registers with marketplace) ──────────
info "Starting server..."
unbrowse health --pretty
ok "Done! Try: unbrowse resolve --intent \"get trending\" --url \"https://google.com\" --pretty"
