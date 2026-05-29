#!/usr/bin/env bash
# R1: CLI install-from-prod via npm install -g <tarball>
#
# Honest-evidence-row contract:
#   - Pack the local workspace into a tgz (the same artifact that would ship to npm).
#   - Install it into an ISOLATED temp dir as a global (--prefix=temp), so the
#     packaged code path is what runs (NOT bun src/cli.ts which masks pack bugs).
#   - Run a real probe: `unbrowse resolve --intent "X" --url "Y"`.
#   - Capture stdout/stderr + exit code + duration into the cell artifact dir.
#   - Parse x402 sub_state from decision_trace if present; otherwise emit
#     "no_paid_surface_hit" (resolve is free; the sub_state probe is the
#     llm-proxy path or an execute on a paid endpoint).
#
# Per CLAUDE.md: harness collects; agent judges. NO grep-derived verdict here.
#
# Env contract:
#   MATRIX_CELL_ID         = R1C1 | R1C2
#   MATRIX_ARTIFACT_DIR    = scripts/matrix/.artifacts/<cell_id>
#   UNBROWSE_WALLET_ADAPTER (set by orchestrator per column)
#   UNBROWSE_WALLET_KEY     (set by orchestrator per column)

set -uo pipefail

CELL_ID="${MATRIX_CELL_ID:?MATRIX_CELL_ID required}"
ART_DIR="${MATRIX_ARTIFACT_DIR:?MATRIX_ARTIFACT_DIR required}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

mkdir -p "$ART_DIR"

START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

# -----------------------------------------------------------------------------
# Step 1: pack the workspace
# -----------------------------------------------------------------------------
TARBALL="/tmp/unbrowse-matrix-${CELL_ID}.tgz"
echo "[R1] pack: npm pack --workspace packages/skill" | tee "$ART_DIR/pack.log"
(
  cd "$REPO_ROOT"
  npm pack --workspace packages/skill --pack-destination /tmp 2>&1
) | tee -a "$ART_DIR/pack.log"
PACK_EXIT=${PIPESTATUS[0]}

# npm pack writes unbrowse-<version>.tgz — find the freshest one.
PACKED=$(ls -t /tmp/unbrowse-*.tgz 2>/dev/null | head -1 || true)
if [ -z "$PACKED" ]; then
  echo "[R1] pack produced no tarball" | tee "$ART_DIR/error.log"
  echo "diagnostic=no_tarball_produced" >> "$ART_DIR/summary.kv"
  END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo "exit_code=$PACK_EXIT" >> "$ART_DIR/summary.kv"
  echo "duration_ms=$((END_MS-START_MS))" >> "$ART_DIR/summary.kv"
  echo "sub_state=harness_red" >> "$ART_DIR/summary.kv"
  exit 2
fi
cp "$PACKED" "$TARBALL"

# -----------------------------------------------------------------------------
# Step 2: install into an isolated prefix (NO sudo, NO -g touching system)
# -----------------------------------------------------------------------------
INSTALL_DIR=$(mktemp -d "/tmp/unbrowse-matrix-install-${CELL_ID}-XXXXXX")
echo "[R1] install: npm install --prefix $INSTALL_DIR $TARBALL" | tee "$ART_DIR/install.log"
# MATRIX_RELEASE_MODE=1 (default for the 3x2 matrix) runs postinstall.mjs so
# the native binary is fetched/verified — this is the cell the user actually
# experiences after `npm install -g unbrowse`. MATRIX_RELEASE_MODE=0 keeps the
# old --ignore-scripts behaviour for smoke iterations where you only care
# about the packaged-code-path wiring. Per CLAUDE.md "no fake green":
# `cli_native_binary_missing_postinstall_skipped` is what you get with =0,
# and that's not a real release-mode pass.
RELEASE_MODE="${MATRIX_RELEASE_MODE:-1}"
(
  cd "$INSTALL_DIR"
  npm init -y >/dev/null 2>&1
  if [ "$RELEASE_MODE" = "1" ]; then
    npm install "$TARBALL" 2>&1
  else
    npm install --ignore-scripts "$TARBALL" 2>&1
  fi
) | tee -a "$ART_DIR/install.log"
INSTALL_EXIT=${PIPESTATUS[0]}

CLI_BIN="$INSTALL_DIR/node_modules/.bin/unbrowse"
if [ ! -x "$CLI_BIN" ]; then
  echo "[R1] CLI binary missing after install" | tee "$ART_DIR/error.log"
  echo "diagnostic=cli_binary_missing_post_install" >> "$ART_DIR/summary.kv"
  END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
  echo "exit_code=$INSTALL_EXIT" >> "$ART_DIR/summary.kv"
  echo "duration_ms=$((END_MS-START_MS))" >> "$ART_DIR/summary.kv"
  echo "sub_state=harness_red" >> "$ART_DIR/summary.kv"
  exit 2
fi

# -----------------------------------------------------------------------------
# Step 3: run a real probe. Resolve is free; the x402-fetch wedge only surfaces
# when a 402 actually fires. For the matrix smoke we run `unbrowse --version`
# (proves packaged bin runs) and `unbrowse resolve` against a stable public
# URL (proves networking + free path). Sub_state will be `no_paid_surface_hit`
# unless the resolve happens to hit a 402, which is rare on this corpus.
# -----------------------------------------------------------------------------
"$CLI_BIN" --version > "$ART_DIR/version.out" 2> "$ART_DIR/version.err" || true
VERSION_EXIT=$?

# Run resolve with a deliberately short timeout; we care about the produced
# decision_trace, not whether resolve fully succeeds.
UNBROWSE_DECISION_TRACE=1 \
UNBROWSE_API_URL="${UNBROWSE_API_URL:-https://beta-api.unbrowse.ai}" \
timeout 30 "$CLI_BIN" resolve \
  --intent "fetch GitHub repo metadata for octocat/Hello-World" \
  --url "https://github.com/octocat/Hello-World" \
  > "$ART_DIR/resolve.out" 2> "$ART_DIR/resolve.err" || true
RESOLVE_EXIT=$?

# -----------------------------------------------------------------------------
# Step 4: extract sub_state from decision_trace if present
# -----------------------------------------------------------------------------
SUB_STATE=$(python3 - "$ART_DIR/resolve.out" "$ART_DIR/resolve.err" <<'PY'
import json, sys, re
sub = "no_paid_surface_hit"
for fp in sys.argv[1:]:
    try:
        with open(fp) as f:
            data = f.read()
    except Exception:
        continue
    # If postinstall was skipped the resolve never actually ran — surface
    # that as a distinct sub_state so the agent can judge it's a HARNESS
    # gap (ignore-scripts choice) not a product regression.
    if "native binary not installed" in data:
        sub = "cli_native_binary_missing_postinstall_skipped"
        break
    for tok in ("x402_signed","x402_signer_error","x402_cost_exceeded","x402_retry_blocked","x402_passthrough","x402_no_wallet"):
        if tok in data:
            sub = tok
            break
    if sub != "no_paid_surface_hit":
        break
print(sub)
PY
)

END_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

{
  echo "cell_id=$CELL_ID"
  echo "tarball=$TARBALL"
  echo "install_dir=$INSTALL_DIR"
  echo "release_mode=$RELEASE_MODE"
  echo "version_exit=$VERSION_EXIT"
  echo "resolve_exit=$RESOLVE_EXIT"
  echo "exit_code=$RESOLVE_EXIT"
  echo "duration_ms=$((END_MS-START_MS))"
  echo "sub_state=$SUB_STATE"
  echo "UNBROWSE_WALLET_ADAPTER_present=$([ -n "${UNBROWSE_WALLET_ADAPTER:-}" ] && echo true || echo false)"
  echo "UNBROWSE_WALLET_KEY_present=$([ -n "${UNBROWSE_WALLET_KEY:-}" ] && echo true || echo false)"
} > "$ART_DIR/summary.kv"

exit "$RESOLVE_EXIT"
