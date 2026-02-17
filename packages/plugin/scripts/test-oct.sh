#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Repo root is two levels up from packages/plugin/.
REPO_ROOT="$(cd "${PLUGIN_ROOT}/../.." && pwd)"

export OCT_LIB_DIR="${REPO_ROOT}/third_party/openclaw-test-suite/lib"
export PATH="${REPO_ROOT}/third_party/openclaw-test-suite/bin:${PATH}"

export OCT_PLUGIN_ID="unbrowse-openclaw"
export OCT_PLUGIN_DIR="${PLUGIN_ROOT}"
# Default: existing gateway (service-managed).
export OCT_GATEWAY_URL="${OCT_GATEWAY_URL:-http://127.0.0.1:18789}"
export OCT_GATEWAY_TOKEN="${OCT_GATEWAY_TOKEN:-}"

MODE="${OCT_MODE:-local}"

if [ "$MODE" = "docker" ] || [ "${OCT_CAN_START_GATEWAY:-}" = "1" ]; then
  export OCT_CAN_START_GATEWAY=1
  export OCT_GATEWAY_TOKEN="${OCT_GATEWAY_TOKEN:-oct_test_token_$(date +%s)}"
  export OPENCLAW_GATEWAY_TOKEN="$OCT_GATEWAY_TOKEN"
  export OCT_SKILLS_DIR="${OCT_SKILLS_DIR:-${HOME}/.openclaw-dev/skills}"
  export OPENCLAW_SKILLS_DIR="${OCT_SKILLS_DIR}"

  # Generate an ephemeral Solana keypair for signed marketplace requests.
  eval "$(node --input-type=module -e 'import {Keypair} from "@solana/web3.js"; import bs58 from "bs58"; const kp=Keypair.generate(); console.log(`export UNBROWSE_CREATOR_WALLET=${kp.publicKey.toBase58()}`); console.log(`export UNBROWSE_SOLANA_PRIVATE_KEY=${bs58.encode(kp.secretKey)}`);')"

  # Install this plugin into OpenClaw so `gateway run` loads it.
  # Note: OCT lifecycle uses `openclaw ... --dev gateway run ...`, so install into the dev profile too.
  DEV_EXT_DIR="${HOME}/.openclaw-dev/extensions/${OCT_PLUGIN_ID}"
  if [ -e "${DEV_EXT_DIR}" ]; then
    if command -v trash >/dev/null 2>&1; then
      trash "${DEV_EXT_DIR}" >/dev/null 2>&1 || true
    else
      mv "${DEV_EXT_DIR}" "/tmp/${OCT_PLUGIN_ID}-oct-backup-$(date +%s)" >/dev/null 2>&1 || true
    fi
  fi
  openclaw --dev plugins install --link "${PLUGIN_ROOT}" >/tmp/oct-install.log 2>&1 || {
    # OpenClaw sometimes exits non-zero even though the plugin was linked successfully
    # (e.g. when it requires a gateway restart). Treat that case as non-fatal.
    if grep -q "Linked plugin path:" /tmp/oct-install.log 2>/dev/null; then
      echo "[oct] openclaw plugins install returned non-zero, but plugin appears linked; continuing."
      tail -50 /tmp/oct-install.log || true
    else
      echo "openclaw plugin install failed. Log:"
      tail -200 /tmp/oct-install.log || true
      exit 1
    fi
  }
else
  export OCT_CAN_START_GATEWAY=0
  # Use the currently running gateway (service-managed). Read token from config if not provided.
  if [ -z "${OCT_GATEWAY_TOKEN:-}" ]; then
    CFG="${HOME}/.openclaw/openclaw.json"
    if [ ! -f "$CFG" ]; then
      echo "No OCT_GATEWAY_TOKEN set and OpenClaw config not found at $CFG"
      echo "Either start the gateway (openclaw gateway start) or export OCT_GATEWAY_TOKEN."
      exit 1
    fi
    export OCT_GATEWAY_TOKEN="$(node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.env.HOME+"/.openclaw/openclaw.json","utf8")); process.stdout.write(cfg.gateway?.auth?.token || "");')"
  fi
fi

oct "${PLUGIN_ROOT}/test/oct"
