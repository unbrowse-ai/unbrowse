#!/usr/bin/env bash
# setup-impersonation.sh — provision the three fetch-ladder venvs idempotently.
#
# The fetch ladder (src/capture/fetch-ladder.ts) walks three impersonation
# rungs in order: curl_cffi (TLS-fingerprint) → camoufox (JS-challenge) →
# patchright (headed Chrome). Each rung is OPTIONAL: when its venv/helper is
# absent the TS caller returns null and the ladder advances — honest
# degradation, never a throw or a fake result.
#
# This script provisions the venvs so the rungs become live. It is idempotent
# (already exists → skip) and never fatal (a failed pip install is logged and
# the script continues to the next rung). No venv is created implicitly at
# runtime — provisioning is explicit via this script.
#
# Usage:
#   bash scripts/setup-impersonation.sh            # all three rungs
#   bash scripts/setup-impersonation.sh --help      # usage
#   bash scripts/setup-impersonation.sh --only curl_cffi
#   bash scripts/setup-impersonation.sh --only camoufox
#   bash scripts/setup-impersonation.sh --only patchright
#   SKIP_CAMOUFOX=1 bash scripts/setup-impersonation.sh
#   SKIP_PATCHRIGHT=1 bash scripts/setup-impersonation.sh
#
# Venvs:
#   scripts/.curl-impersonate-venv  — pip install curl_cffi  (lightweight)
#   scripts/.camoufox-venv          — pip install camoufox   (heavy/optional, ~200MB Firefox)
#   scripts/.patchright-venv        — pip install patchright && patchright install chrome (needs DISPLAY/xvfb for headed mode)

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURL_VENV="$ROOT/scripts/.curl-impersonate-venv"
CAMOUFOX_VENV="$ROOT/scripts/.camoufox-venv"
PATCHRIGHT_VENV="$ROOT/scripts/.patchright-venv"

ONLY="${ONLY:-}"
SKIP_CAMOUFOX="${SKIP_CAMOUFOX:-0}"
SKIP_PATCHRIGHT="${SKIP_PATCHRIGHT:-0}"
FORCE="${FORCE:-0}"

usage() {
  cat <<'USAGE'
setup-impersonation.sh — provision unbrowse impersonation venvs (idempotent)

Usage:
  bash scripts/setup-impersonation.sh [--help] [--only RUNG] [--force]

Rungs:
  curl_cffi   scripts/.curl-impersonate-venv  (pip install curl_cffi)        — lightweight, TLS-fingerprint rung
  camoufox    scripts/.camoufox-venv          (pip install camoufox)         — heavy/optional, stealth Firefox JS-challenge rung
  patchright  scripts/.patchright-venv        (pip install patchright && patchright install chrome) — headed Chrome, needs DISPLAY/xvfb

Options:
  --help            Show this help and exit (0)
  --only RUNG       Only provision the named rung (curl_cffi|camoufox|patchright)
  --force           Reinstall even if venv already exists

Env:
  SKIP_CAMOUFOX=1    Skip camoufox rung
  SKIP_PATCHRIGHT=1  Skip patchright rung
  ONLY=RUNG          Same as --only

Each rung is skippable (exists → skip) and failures are logged not fatal.
When a rung is not installed its TS caller returns null — the ladder advances
honestly (see src/capture/DESIGN_NOTES.md "Impersonation ladder").
USAGE
}

should_run() {
  local rung="$1"
  if [[ -n "$ONLY" && "$ONLY" != "$rung" ]]; then
    return 1
  fi
  return 0
}

has_python() {
  command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1
}

# ---- arg parse ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --only)
      ONLY="${2:-}"
      if [[ -z "$ONLY" ]]; then echo "[setup-impersonation] --only requires an argument (curl_cffi|camoufox|patchright)" >&2; exit 2; fi
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --skip-camoufox)
      SKIP_CAMOUFOX=1
      shift
      ;;
    --skip-patchright)
      SKIP_PATCHRIGHT=1
      shift
      ;;
    *)
      echo "[setup-impersonation] Unknown arg: $1 (try --help)" >&2
      exit 2
      ;;
  esac
done

# Validate ONLY value if set
if [[ -n "$ONLY" && "$ONLY" != "curl_cffi" && "$ONLY" != "camoufox" && "$ONLY" != "patchright" ]]; then
  echo "[setup-impersonation] Invalid --only value: $ONLY (expected curl_cffi|camoufox|patchright)" >&2
  exit 2
fi

if ! has_python; then
  echo "[setup-impersonation] WARNING: python3 not found on PATH — cannot provision venvs. Install python3 and re-run." >&2
  exit 0
fi

PYBIN="python3"
if ! command -v python3 >/dev/null 2>&1; then PYBIN="python"; fi

echo "[setup-impersonation] Root: $ROOT"
echo "[setup-impersonation] Python: $($PYBIN --version 2>&1)"

# ---- helpers ----
ensure_venv() {
  local venv_path="$1"
  local label="$2"
  if [[ -d "$venv_path" && "$FORCE" != "1" ]]; then
    echo "[setup-impersonation] $label: venv exists at $venv_path — skipping (use --force to reinstall)"
    return 1
  fi
  if [[ -d "$venv_path" && "$FORCE" == "1" ]]; then
    echo "[setup-impersonation] $label: --force — recreating venv at $venv_path"
    rm -rf "$venv_path"
  fi
  echo "[setup-impersonation] $label: creating venv at $venv_path ..."
  if ! "$PYBIN" -m venv "$venv_path" 2>&1; then
    echo "[setup-impersonation] WARNING: $label: failed to create venv at $venv_path" >&2
    return 2
  fi
  return 0
}

pip_install() {
  local venv_path="$1"
  local label="$2"
  shift 2
  echo "[setup-impersonation] $label: pip install $* ..."
  if ! "$venv_path/bin/pip" install --upgrade pip 2>&1 | tail -n 5; then
    echo "[setup-impersonation] WARNING: $label: pip upgrade failed (continuing)" >&2
  fi
  if ! "$venv_path/bin/pip" install "$@" 2>&1; then
    echo "[setup-impersonation] WARNING: $label: pip install $* failed" >&2
    return 1
  fi
  return 0
}

# ---- 1) curl_cffi ----
if should_run "curl_cffi"; then
  echo ""
  echo "── curl_cffi (TLS-fingerprint rung) ──"
  if ensure_venv "$CURL_VENV" "curl_cffi"; then
    if pip_install "$CURL_VENV" "curl_cffi" "curl_cffi"; then
      echo "[setup-impersonation] curl_cffi: OK — test with: $CURL_VENV/bin/python -c 'import curl_cffi; print(curl_cffi.__version__)'"
    else
      echo "[setup-impersonation] WARNING: curl_cffi: install failed — rung will remain null (honest degradation)" >&2
    fi
  fi
else
  echo "[setup-impersonation] curl_cffi: skipped (--only filter)"
fi

# ---- 2) camoufox ----
if should_run "camoufox"; then
  if [[ "$SKIP_CAMOUFOX" == "1" ]]; then
    echo ""
    echo "[setup-impersonation] camoufox: skipped (SKIP_CAMOUFOX=1)"
  else
    echo ""
    echo "── camoufox (stealth Firefox JS-challenge rung) ──"
    echo "[setup-impersonation] NOTE: camoufox is heavy (~200MB Firefox) and optional — JS-challenge rung; skip with SKIP_CAMOUFOX=1"
    if ensure_venv "$CAMOUFOX_VENV" "camoufox"; then
      if pip_install "$CAMOUFOX_VENV" "camoufox" "camoufox[geoip]"; then
        echo "[setup-impersonation] camoufox: fetching Firefox binary (this may take a minute)..."
        if ! "$CAMOUFOX_VENV/bin/python" -m camoufox fetch 2>&1 | tail -n 20; then
          echo "[setup-impersonation] WARNING: camoufox: 'python -m camoufox fetch' failed — try manually: $CAMOUFOX_VENV/bin/python -m camoufox fetch" >&2
        else
          echo "[setup-impersonation] camoufox: OK — test with: $CAMOUFOX_VENV/bin/python -c 'from camoufox.sync_api import Camoufox; print(\"ok\")'"
        fi
      else
        echo "[setup-impersonation] WARNING: camoufox: install failed — rung will remain null (honest degradation)" >&2
      fi
    fi
  fi
else
  echo "[setup-impersonation] camoufox: skipped (--only filter)"
fi

# ---- 3) patchright ----
if should_run "patchright"; then
  if [[ "$SKIP_PATCHRIGHT" == "1" ]]; then
    echo ""
    echo "[setup-impersonation] patchright: skipped (SKIP_PATCHRIGHT=1)"
  else
    echo ""
    echo "── patchright (headed Chrome JS-challenge rung) ──"
    echo "[setup-impersonation] NOTE: patchright requires DISPLAY or xvfb-run for headed mode; headless leaks HeadlessChrome in UA and is refused"
    if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
      echo "[setup-impersonation] WARNING: no DISPLAY/WAYLAND_DISPLAY — patchright will refuse at runtime unless run under xvfb-run -a" >&2
    fi
    if ! command -v xvfb-run >/dev/null 2>&1; then
      echo "[setup-impersonation] HINT: xvfb-run not found — install xvfb (apt install xvfb) for headless servers" >&2
    fi
    if ensure_venv "$PATCHRIGHT_VENV" "patchright"; then
      if pip_install "$PATCHRIGHT_VENV" "patchright" "patchright"; then
        echo "[setup-impersonation] patchright: installing Chrome browser..."
        if ! "$PATCHRIGHT_VENV/bin/patchright" install chrome 2>&1 | tail -n 20; then
          echo "[setup-impersonation] WARNING: patchright: 'patchright install chrome' failed — try manually: $PATCHRIGHT_VENV/bin/patchright install chrome" >&2
        else
          echo "[setup-impersonation] patchright: OK — test with: DISPLAY=:99 xvfb-run -a $PATCHRIGHT_VENV/bin/python $ROOT/scripts/patchright-fetch.py https://example.com"
        fi
      else
        echo "[setup-impersonation] WARNING: patchright: install failed — rung will remain null (honest degradation)" >&2
      fi
    fi
  fi
else
  echo "[setup-impersonation] patchright: skipped (--only filter)"
fi

echo ""
echo "[setup-impersonation] Done. Uninstalled rungs return null and the ladder advances — see src/capture/DESIGN_NOTES.md."
