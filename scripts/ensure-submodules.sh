#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "[submodules] git not found"
  exit 1
fi

if [ ! -f .gitmodules ]; then
  echo "[submodules] no .gitmodules present; skipping"
  exit 0
fi

echo "[submodules] syncing"
git submodule sync --recursive

echo "[submodules] updating"
git submodule update --init --recursive "$@"

should_verify_kuri=1
if [ "$#" -gt 0 ]; then
  should_verify_kuri=0
  for arg in "$@"; do
    if [ "$arg" = "submodules/kuri" ]; then
      should_verify_kuri=1
      break
    fi
  done
fi

if [ "$should_verify_kuri" -eq 1 ] && [ -f .gitmodules ] && [ -e submodules/kuri/.git -o -d submodules/kuri/.git ]; then
  # Verify the submodule checked out to the commit the superproject expects
  actual_sha="$(git -C submodules/kuri rev-parse HEAD)"
  expected_sha="$(git ls-tree HEAD submodules/kuri | awk '{ print $3 }')"
  if [ -z "$expected_sha" ]; then
    echo "[submodules] submodules/kuri not tracked by superproject; skipping verify" >&2
  elif [ "$actual_sha" != "$expected_sha" ]; then
    echo "[submodules] submodules/kuri is at ${actual_sha}, superproject expects ${expected_sha}" >&2
    exit 1
  else
    echo "[submodules] submodules/kuri matches superproject pin (${actual_sha})"
  fi

  # Warn (non-fatal) if the pinned commit is behind the tracking branch
  kuri_branch="$(git config -f .gitmodules --get submodule.submodules/kuri.branch || true)"
  kuri_url="$(git config -f .gitmodules --get submodule.submodules/kuri.url || true)"
  if [ -n "$kuri_branch" ] && [ -n "$kuri_url" ]; then
    remote_sha="$(git ls-remote --heads "$kuri_url" "$kuri_branch" 2>/dev/null | awk 'NR==1 { print $1 }')"
    if [ -n "$remote_sha" ] && [ "$actual_sha" != "$remote_sha" ]; then
      echo "[submodules] NOTE: submodules/kuri is behind ${kuri_branch} tip (${remote_sha}). Consider updating."
    fi
  fi
fi

echo "[submodules] ready"
