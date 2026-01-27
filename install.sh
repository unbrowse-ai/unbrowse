#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Unbrowse Installer
#
# 1. Patches clawdbot's Playwright capture to include request/response headers
# 2. Registers unbrowse extension in clawdbot config
# 3. Sets up encrypted credential vault
# 4. Restarts gateway to pick up changes
# ─────────────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[unbrowse]${NC} $*"; }
warn()  { echo -e "${YELLOW}[unbrowse]${NC} $*"; }
error() { echo -e "${RED}[unbrowse]${NC} $*"; }

CLAWDBOT_DIR="${CLAWDBOT_DIR:-$(npm root -g 2>/dev/null)/clawdbot}"
if [ ! -d "$CLAWDBOT_DIR" ]; then
  CLAWDBOT_DIR="/opt/homebrew/lib/node_modules/clawdbot"
fi
if [ ! -d "$CLAWDBOT_DIR" ]; then
  error "clawdbot not found. Install it first: npm i -g clawdbot"
  exit 1
fi

PW_SESSION="$CLAWDBOT_DIR/dist/browser/pw-session.js"
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"
VAULT_DIR="$HOME/.clawdbot/unbrowse"
EXTENSION_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "\n${BOLD}Unbrowse Installer${NC}\n"
info "clawdbot: $CLAWDBOT_DIR"
info "extension: $EXTENSION_DIR"
info "config: $CONFIG_FILE"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Patch clawdbot to capture request + response headers
# ─────────────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}Step 1: Patch Playwright header capture${NC}"

if [ ! -f "$PW_SESSION" ]; then
  error "pw-session.js not found at $PW_SESSION"
  exit 1
fi

# Check if already patched
if grep -q "req\.headers()" "$PW_SESSION"; then
  info "Already patched — headers capture present"
else
  # Backup original
  cp "$PW_SESSION" "${PW_SESSION}.bak"
  info "Backed up: ${PW_SESSION}.bak"

  # Patch request handler: add headers capture
  # Original:  resourceType: req.resourceType(),
  # Patched:   resourceType: req.resourceType(), headers: req.headers(),
  sed -i '' 's/resourceType: req\.resourceType(),/resourceType: req.resourceType(), headers: req.headers(),/' "$PW_SESSION"

  # Patch response handler: add response headers
  # Original:  rec.ok = resp.ok();
  # After:     rec.ok = resp.ok(); rec.responseHeaders = resp.headers();
  sed -i '' 's/rec\.ok = resp\.ok();/rec.ok = resp.ok(); rec.responseHeaders = resp.headers();/' "$PW_SESSION"

  if grep -q "req\.headers()" "$PW_SESSION"; then
    info "Patched: request headers now captured"
  else
    error "Patch failed — restoring backup"
    cp "${PW_SESSION}.bak" "$PW_SESSION"
    exit 1
  fi

  if grep -q "resp\.headers()" "$PW_SESSION"; then
    info "Patched: response headers now captured"
  else
    warn "Response headers patch may need manual review"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Set up credential vault
# ─────────────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}Step 2: Set up credential vault${NC}"

mkdir -p "$VAULT_DIR"

# Generate vault encryption key and store in macOS Keychain
if security find-generic-password -s "unbrowse-vault" -a "$USER" -w >/dev/null 2>&1; then
  info "Vault key exists in Keychain"
else
  VAULT_KEY=$(openssl rand -hex 32)
  security add-generic-password -s "unbrowse-vault" -a "$USER" -w "$VAULT_KEY" -T ""
  info "Vault key generated and stored in macOS Keychain"
fi

# Create vault DB if it doesn't exist
if [ ! -f "$VAULT_DIR/vault.db" ]; then
  # Initialize SQLite vault with schema
  sqlite3 "$VAULT_DIR/vault.db" <<'SQL'
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL UNIQUE,
  base_url TEXT,
  auth_method TEXT,
  headers_enc TEXT,     -- encrypted JSON of auth headers
  cookies_enc TEXT,     -- encrypted JSON of cookies
  extra_enc TEXT,       -- encrypted JSON of additional auth info
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,      -- optional expiry for tokens
  notes TEXT
);

CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO vault_meta (key, value) VALUES ('version', '1');
INSERT OR IGNORE INTO vault_meta (key, value) VALUES ('cipher', 'aes-256-gcm');
SQL
  info "Vault DB created: $VAULT_DIR/vault.db"
else
  info "Vault DB exists"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Register extension in clawdbot config
# ─────────────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}Step 3: Register extension${NC}"

if [ ! -f "$CONFIG_FILE" ]; then
  error "clawdbot config not found: $CONFIG_FILE"
  exit 1
fi

# Check if already registered
if grep -q "unbrowse" "$CONFIG_FILE"; then
  info "Extension already registered in config"
else
  # Use node to safely modify JSON
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));

    // Add to plugin paths
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
    if (!cfg.plugins.load.paths.includes('$EXTENSION_DIR')) {
      cfg.plugins.load.paths.push('$EXTENSION_DIR');
    }

    // Add plugin entry
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    if (!cfg.plugins.entries.unbrowse) {
      cfg.plugins.entries.unbrowse = {
        enabled: true,
        config: {
          autoDiscover: true
        }
      };
    }

    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
  "
  info "Extension registered in $CONFIG_FILE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Restart gateway
# ─────────────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}Step 4: Restart gateway${NC}"

if command -v clawdbot >/dev/null 2>&1; then
  if launchctl list 2>/dev/null | grep -q clawdbot; then
    info "Restarting gateway via LaunchAgent..."
    LABEL=$(launchctl list | grep clawdbot | awk '{print $3}')
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
    info "Gateway restarted"
  else
    warn "Gateway not running as LaunchAgent. Restart manually: clawdbot gateway install"
  fi
else
  warn "clawdbot CLI not found. Restart gateway manually."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}${GREEN}Unbrowse installed!${NC}\n"
echo "  Vault:     $VAULT_DIR/vault.db"
echo "  Extension: $EXTENSION_DIR"
echo "  Config:    $CONFIG_FILE"
echo ""
echo "  Tools available after gateway restart:"
echo "    unbrowse_learn    — HAR file → skill"
echo "    unbrowse_capture  — live browser → skill"
echo "    unbrowse_auth     — extract auth from browser"
echo "    unbrowse_replay   — test endpoints"
echo "    unbrowse_stealth  — cloud stealth browser"
echo "    unbrowse_skills   — list discovered skills"
echo ""
echo "  Vault CLI:"
echo "    unbrowse vault list"
echo "    unbrowse vault get <service>"
echo "    unbrowse vault export <service>"
echo ""
