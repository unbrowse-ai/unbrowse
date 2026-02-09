#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export OCT_LIB_DIR="${REPO_ROOT}/third_party/openclaw-test-suite/lib"
export PATH="${REPO_ROOT}/third_party/openclaw-test-suite/bin:${PATH}"

export OCT_PLUGIN_ID="unbrowse-openclaw"
export OCT_PLUGIN_DIR="${REPO_ROOT}"
export OCT_GATEWAY_URL="${OCT_GATEWAY_URL:-http://127.0.0.1:18789}"
export OCT_GATEWAY_TOKEN="${OCT_GATEWAY_TOKEN:-}"

MODE="${OCT_MODE:-local}"

if [ "$MODE" = "docker" ] || [ "${OCT_CAN_START_GATEWAY:-}" = "1" ]; then
  export OCT_CAN_START_GATEWAY=1
  export OCT_GATEWAY_TOKEN="${OCT_GATEWAY_TOKEN:-oct_test_token_$(date +%s)}"
  export OPENCLAW_GATEWAY_TOKEN="$OCT_GATEWAY_TOKEN"

  # Ensure a minimal config exists so `openclaw gateway run` doesn't abort.
  mkdir -p "${HOME}/.openclaw"
  CFG="${HOME}/.openclaw/openclaw.json"
  if [ ! -f "$CFG" ]; then
    cat >"$CFG" <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789,
    "auth": { "mode": "token", "token": "${OCT_GATEWAY_TOKEN}" },
    "tailscale": { "mode": "off", "resetOnExit": false }
  }
}
EOF
  fi

  # Generate an ephemeral Solana keypair for signed marketplace requests.
  eval "$(node --input-type=module -e 'import {Keypair} from "@solana/web3.js"; import bs58 from "bs58"; const kp=Keypair.generate(); console.log(`export UNBROWSE_CREATOR_WALLET=${kp.publicKey.toBase58()}`); console.log(`export UNBROWSE_SOLANA_PRIVATE_KEY=${bs58.encode(kp.secretKey)}`);')"

  # Install this plugin into OpenClaw so `gateway run` loads it.
  openclaw plugins install --link "${REPO_ROOT}" >/tmp/oct-install.log 2>&1 || {
    echo "openclaw plugin install failed. Log:"
    tail -200 /tmp/oct-install.log || true
    exit 1
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

oct "${REPO_ROOT}/test/oct"
