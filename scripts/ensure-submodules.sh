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
  kuri_branch="$(git config -f .gitmodules --get submodule.submodules/kuri.branch || true)"
  kuri_url="$(git config -f .gitmodules --get submodule.submodules/kuri.url || true)"
  if [ -n "$kuri_branch" ] && [ -n "$kuri_url" ]; then
    echo "[submodules] verifying submodules/kuri against ${kuri_branch}"
    actual_sha="$(git -C submodules/kuri rev-parse HEAD)"
    expected_sha="$(git ls-remote --heads "$kuri_url" "$kuri_branch" | awk 'NR==1 { print $1 }')"
    if [ -z "$expected_sha" ]; then
      echo "[submodules] failed to resolve ${kuri_url}#${kuri_branch}" >&2
      exit 1
    fi
    if [ "$actual_sha" != "$expected_sha" ]; then
      echo "[submodules] submodules/kuri is pinned to ${actual_sha}, expected ${expected_sha} from ${kuri_branch}" >&2
      exit 1
    fi
    echo "[submodules] submodules/kuri matches ${kuri_branch} (${actual_sha})"
  fi
fi

echo "[submodules] ready"
