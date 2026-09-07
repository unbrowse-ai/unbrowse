#!/usr/bin/env bash
# _resolve-bins.sh — one place the shell gates find the obscura binaries.
#
# Mirrors the resolution order in src/obscura/resolve-bin.ts, because a gate that
# resolves differently from the code it gates is not gating that code:
#   1. explicit env override
#   2. the vendored tree, vendor/obscura/<target>/   (what vendor.sh populates)
#   3. the local sidecar build dir (sidecar only)
#   4. bare name on PATH
#
# Sets OBS (the obscura CLI) and CAP (the obscura-capture sidecar). Exports both
# under every name the gates and the TS resolver read, so a gate and the code it
# invokes always agree on which binary is under test.
# shellcheck shell=bash

_ob_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) os=unsupported;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) arch=unsupported;; esac
  printf '%s-%s' "$os" "$arch"
}

_ob_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ob_repo="$(cd "$_ob_here/../.." && pwd)"
_ob_vendor="$_ob_repo/vendor/obscura/$(_ob_target)"

# --- the obscura CLI ---------------------------------------------------------
OBS="${OBSCURA_BIN:-${UNBROWSE_OBSCURA_BIN:-}}"
if [ -z "$OBS" ] || { [ ! -x "$OBS" ] && ! command -v "$OBS" >/dev/null 2>&1; }; then
  if [ -x "$_ob_vendor/obscura" ]; then OBS="$_ob_vendor/obscura"
  else OBS="obscura"; fi
fi

# --- the capture sidecar -----------------------------------------------------
CAP="${OBSCURA_CAPTURE_BIN:-${UNBROWSE_OBSCURA_CAPTURE_BIN:-}}"
if [ -z "$CAP" ] || [ ! -x "$CAP" ]; then
  if   [ -x "$_ob_vendor/obscura-capture" ];              then CAP="$_ob_vendor/obscura-capture"
  elif [ -x "$_ob_here/target/release/obscura-capture" ]; then CAP="$_ob_here/target/release/obscura-capture"
  else CAP="obscura-capture"; fi
fi

export OBS CAP
export OBSCURA_BIN="$OBS"            UNBROWSE_OBSCURA_BIN="$OBS"
export OBSCURA_CAPTURE_BIN="$CAP"    UNBROWSE_OBSCURA_CAPTURE_BIN="$CAP"
