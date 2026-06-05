#!/usr/bin/env bash
# Runs ON a fresh tiny Nebius VM. Installs unbrowse from npm and exercises the
# real end-to-end paths, recording each outcome. Emits one JSON result between
# the markers <<<QA_JSON_BEGIN>>> ... <<<QA_JSON_END>>> so the orchestrator can
# extract it over SSH. Never aborts on an individual test failure — every probe
# is captured, and the orchestrator/agent judges the matrix.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
LOG=/tmp/unbrowse-qa.log
: > "$LOG"
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG" ; }

# result fields
node_version=""; npm_version=""; unbrowse_version=""
install_ok=false; version_ok=false; health_ok=false
fetch_ok=false; fetch_bytes=0
search_ok=false; search_bytes=0
errors=()

bun_version=""
# ---- 0. wait for cloud-init / apt lock (package_update races our installs) -
say "waiting for cloud-init + apt lock to settle"
sudo cloud-init status --wait >>"$LOG" 2>&1 || true
for _ in $(seq 1 60); do
  if ! sudo fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; then break; fi
  sleep 5
done

# ---- 1. Node 20 (NodeSource) — npm is needed to INSTALL the package --------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  say "installing Node 20 via NodeSource"
  for try in 1 2 3; do
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >>"$LOG" 2>&1
    if sudo apt-get install -y nodejs >>"$LOG" 2>&1; then break; fi
    say "  node install retry $try"; sleep 10
  done
fi
node_version="$(node --version 2>/dev/null || echo none)"
npm_version="$(npm --version 2>/dev/null || echo none)"
say "node=$node_version npm=$npm_version"

# ---- 1b. Bun — unbrowse's actual RUNTIME (the npm build runs on Bun) -------
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  say "installing Bun (unbrowse runtime)"
  curl -fsSL https://bun.sh/install | bash >>"$LOG" 2>&1
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export UNBROWSE_BUN_BIN="$BUN_INSTALL/bin/bun"
bun_version="$(bun --version 2>/dev/null || echo none)"
say "bun=$bun_version"

# ---- 2. install unbrowse from npm -----------------------------------------
say "npm install -g unbrowse@latest"
for try in 1 2 3; do
  if sudo npm install -g unbrowse@latest >>"$LOG" 2>&1; then install_ok=true; break; fi
  say "  npm install retry $try"; sleep 10
done
$install_ok || errors+=("npm install -g unbrowse failed after retries")

# ---- 3. version ------------------------------------------------------------
unbrowse_version="$(unbrowse --version 2>/dev/null | head -1 || echo none)"
case "$unbrowse_version" in 8.*) version_ok=true ;; *) errors+=("unexpected version: $unbrowse_version") ;; esac
say "unbrowse=$unbrowse_version"

# ---- 4. health (boots in-process server) ----------------------------------
say "unbrowse health"
health_out="$(timeout 90 unbrowse health 2>&1)"
echo "$health_out" >>"$LOG"
if echo "$health_out" | grep -qiE 'ok|healthy|uptime|version'; then health_ok=true; else errors+=("health: $health_out"); fi

# ---- 5. fetch (libcurl-impersonate core e2e) ------------------------------
say "unbrowse fetch (real web content)"
fetch_out="$(timeout 120 unbrowse fetch https://api.github.com/repos/nodejs/node 2>/tmp/fetch.err)"
fetch_rc=$?
fetch_bytes=$(printf '%s' "$fetch_out" | wc -c | tr -d ' ')
echo "--- fetch (rc=$fetch_rc bytes=$fetch_bytes) ---" >>"$LOG"
printf '%s\n' "$fetch_out" | head -c 800 >>"$LOG"
if [ "$fetch_rc" -eq 0 ] && [ "$fetch_bytes" -gt 200 ] && printf '%s' "$fetch_out" | grep -qi 'nodejs\|full_name\|node'; then
  fetch_ok=true
else
  errors+=("fetch rc=$fetch_rc bytes=$fetch_bytes; $(head -c 200 /tmp/fetch.err)")
fi

# ---- 6. search (free route-graph discovery, network witness) --------------
say "unbrowse search --intent"
search_out="$(timeout 120 unbrowse search --intent 'get repository information' --url 'https://github.com' 2>/tmp/search.err)"
search_rc=$?
search_bytes=$(printf '%s' "$search_out" | wc -c | tr -d ' ')
echo "--- search (rc=$search_rc bytes=$search_bytes) ---" >>"$LOG"
printf '%s\n' "$search_out" | head -c 800 >>"$LOG"
if [ "$search_rc" -eq 0 ] && [ "$search_bytes" -gt 20 ]; then
  search_ok=true
else
  errors+=("search rc=$search_rc bytes=$search_bytes; $(head -c 200 /tmp/search.err)")
fi

# ---- emit JSON -------------------------------------------------------------
err_json="$(printf '%s\n' "${errors[@]:-}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l.strip()]))')"
cat <<JSON
<<<QA_JSON_BEGIN>>>
{
  "host": "$(hostname)",
  "node_version": "$node_version",
  "npm_version": "$npm_version",
  "bun_version": "$bun_version",
  "unbrowse_version": "$unbrowse_version",
  "install_ok": $install_ok,
  "version_ok": $version_ok,
  "health_ok": $health_ok,
  "fetch_ok": $fetch_ok,
  "fetch_bytes": $fetch_bytes,
  "search_ok": $search_ok,
  "search_bytes": $search_bytes,
  "errors": $err_json
}
<<<QA_JSON_END>>>
JSON
