#!/usr/bin/env bash
# unbrowse-build-fractal.sh — the unbrowse translation of the /contract
# substrate's build-fractal.sh self-attesting pipeline.
#
#   BUILD → TEST → SIGN(parent-sign artifact sha into lineage) → GATE(two-witness)
#
# Unlike a one-off release, every build's artifact sha256 is parent-signed by the
# local wallet (~/.unbrowse, Ed25519) into an append-only lineage chain — witnessed
# BOTH locally (attest/build-ledger.jsonl, offline-verifiable) and on-chain (IQLabs
# Solana, when configured). The chain is git-style history of every build this
# wallet blessed; tampering with any artifact or parent link breaks verify.
#
# The runtime refuse half (a binary that computes sha256(self) and refuses if it
# has no signed row) is wired separately behind UNBROWSE_ATTEST_ENFORCE — this
# script is the SIGN side that lands the row so a correctly-built binary is never
# refused (exactly as build-fractal.sh always lands its L8 row in step 3).
#
# Usage:
#   bash scripts/unbrowse-build-fractal.sh                 # cli + server
#   bash scripts/unbrowse-build-fractal.sh --cli-only
#   bash scripts/unbrowse-build-fractal.sh --server-only
#   bash scripts/unbrowse-build-fractal.sh --skip-test     # NOT RECOMMENDED
#   bash scripts/unbrowse-build-fractal.sh --no-iq         # local witness only (off-chain)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ATTEST="$ROOT_DIR/src/values/build-attest.ts"
DIST_DIR="$ROOT_DIR/dist"

SKIP_TEST=0; DO_CLI=1; DO_SERVER=1; NO_IQ=""
for a in "$@"; do
  case "$a" in
    --skip-test)   SKIP_TEST=1 ;;
    --cli-only)    DO_SERVER=0 ;;
    --server-only) DO_CLI=0 ;;
    --no-iq)       NO_IQ="--no-iq" ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then C_I="\033[1;36m"; C_OK="\033[1;32m"; C_F="\033[1;31m"; C_R="\033[0m"
else C_I=""; C_OK=""; C_F=""; C_R=""; fi
info() { printf "${C_I}» %s${C_R}\n" "$*"; }
ok()   { printf "${C_OK}✓ %s${C_R}\n" "$*"; }
fail() { printf "${C_F}✗ %s${C_R}\n" "$*"; }

# ─── Step 0: preflight ────────────────────────────────────────────────────────
info "preflight"
[[ -f "$ATTEST" ]] || { fail "missing $ATTEST"; exit 2; }
command -v bun >/dev/null || { fail "bun not on PATH"; exit 2; }
ok "preflight"

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"; [[ "$ARCH" == "aarch64" ]] && ARCH="arm64"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
TARGET="$PLATFORM-$ARCH"

# ─── Step 1+2: BUILD + TEST (CLI) ─────────────────────────────────────────────
if [[ "$DO_CLI" == "1" ]]; then
  info "BUILD cli — scripts/build-binaries.sh ($TARGET)"
  bash "$ROOT_DIR/scripts/build-binaries.sh" "$TARGET"
  CLI_ARTIFACT="$DIST_DIR/unbrowse-$TARGET"
  [[ -x "$CLI_ARTIFACT" ]] || { fail "cli artifact missing: $CLI_ARTIFACT"; exit 1; }
  ok "cli built → $CLI_ARTIFACT"

  if [[ "$SKIP_TEST" == "1" ]]; then
    info "TEST cli — SKIPPED (--skip-test)"
  else
    info "TEST cli — bun test (attest + cli-e2e)"
    ( cd "$ROOT_DIR" && bun test tests/build-attest.test.ts tests/cli-e2e.test.ts )
    ok "cli tests pass"
  fi

  # ─── SIGN cli — parent-sign the artifact sha into the lineage ──────────────
  info "SIGN cli — parent-sign $TARGET artifact sha into local + IQ lineage"
  ( cd "$ROOT_DIR" && bun "$ATTEST" sign --kind cli --artifact "$CLI_ARTIFACT" --target "$TARGET" $NO_IQ )
  ok "cli signed into lineage"
fi

# ─── Step 1+2: BUILD + TEST (server) ──────────────────────────────────────────
if [[ "$DO_SERVER" == "1" ]]; then
  if [[ ! -d "$ROOT_DIR/backend" ]]; then
    info "BUILD server — SKIPPED (no backend/ dir)"
  else
    info "BUILD server — wrangler dry-run bundle"
    SRV_OUT="$(mktemp -d)"
    SRV_CFG="$ROOT_DIR/backend/wrangler.ci.toml"
    [[ -f "$SRV_CFG" ]] || SRV_CFG="$ROOT_DIR/backend/wrangler.toml"
    if ( cd "$ROOT_DIR/backend" && bunx wrangler deploy --dry-run --outdir "$SRV_OUT" --config "$SRV_CFG" ) >/dev/null 2>&1; then
      SRV_ARTIFACT="$(find "$SRV_OUT" -name '*.js' -type f | head -1)"
      if [[ -n "$SRV_ARTIFACT" && -f "$SRV_ARTIFACT" ]]; then
        ok "server bundled → $(basename "$SRV_ARTIFACT")"
        if [[ "$SKIP_TEST" != "1" ]]; then
          info "TEST server — bun test backend/tests"
          ( cd "$ROOT_DIR" && bun test backend/tests/ ) || { fail "server tests failed"; rm -rf "$SRV_OUT"; exit 1; }
          ok "server tests pass"
        fi
        info "SIGN server — parent-sign worker bundle sha into local + IQ lineage"
        ( cd "$ROOT_DIR" && bun "$ATTEST" sign --kind server --artifact "$SRV_ARTIFACT" --target "cf-worker" $NO_IQ )
        ok "server signed into lineage"
      else
        fail "server dry-run produced no bundle — SKIPPING server attest (honest negative)"
      fi
    else
      fail "wrangler dry-run failed (CF not configured locally?) — SKIPPING server attest (honest negative)"
    fi
    rm -rf "$SRV_OUT"
  fi
fi

# ─── Step 3: GATE — two-witness seal ──────────────────────────────────────────
info "GATE — two-witness attest seal"
bash "$SCRIPT_DIR/unbrowse-attest-gate.sh" $( [[ "$DO_CLI" == "1" ]] && echo "--cli" ) $( [[ "$DO_SERVER" == "1" ]] && echo "--server" )

ok "FRACTAL BUILD COMPLETE — artifacts signed into lineage and two-witness gated"
echo
echo "verify lineage:  bun $ATTEST verify --kind cli"
echo "self-check:      bun $ATTEST self --kind cli --artifact $DIST_DIR/unbrowse-$TARGET"
echo "gate:            bash scripts/unbrowse-attest-gate.sh"
