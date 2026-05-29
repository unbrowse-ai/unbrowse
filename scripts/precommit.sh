#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

staged_files=()
while IFS= read -r file; do
  staged_files+=("$file")
done < <(git diff --cached --name-only --diff-filter=ACMR)

if [[ ${#staged_files[@]} -eq 0 ]]; then
  echo "[pre-commit] no staged files"
  exit 0
fi

has_match() {
  local pattern="$1"
  local file
  for file in "${staged_files[@]}"; do
    if [[ "$file" =~ $pattern ]]; then
      return 0
    fi
  done
  return 1
}

run_tests() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  echo "[pre-commit] bun test $*"
  # Integration tests like cli-input-payload spawn `bun src/cli.ts` which
  # cold-starts in 5-7s under load on slower machines. Default bun-test
  # timeout is 5s, which surfaces as flake without a real regression.
  # 30s covers cold-start with margin; CI runs unaffected.
  bun test --timeout 30000 "$@"
}

echo "[pre-commit] staged files: ${#staged_files[@]}"

# Substrate-leak guard: blocks /contract vocabulary from leaking into
# public surfaces (README.md, CHANGELOG.md, frontend/src/, docs/ but NOT
# docs/internal/). Pattern + scope at scripts/check-contract-leak.sh.
if has_match '^(README\.md|CHANGELOG\.md|frontend/src/|docs/)' && [[ "${CONTRACT_LEAK_ALLOW:-}" != "1" ]]; then
  bash scripts/check-contract-leak.sh
fi

# Public-primitives doc honesty gate: when docs/public/primitives/ files
# change, the README inventory must match the folder and no substrate
# vocabulary may leak. Pattern at scripts/check-primitives-doc-public.sh.
if has_match '^docs/public/primitives/'; then
  bash scripts/check-primitives-doc-public.sh
fi

if has_match '^(src/client/index\.ts|src/runtime/|src/cli\.ts|packages/skill/README\.md|tests/client-registration\.test\.ts|tests/runtime-setup\.test\.ts)$'; then
  run_tests tests/client-registration.test.ts tests/runtime-setup.test.ts
fi

if has_match '^(src/kuri/|src/runtime/paths\.ts|packages/skill/|tests/runtime-(paths|setup)\.test\.ts|scripts/check-packaged-kuri\.sh|packages/skill/scripts/)'; then
  echo "[pre-commit] checking packaged Kuri path"
  bash scripts/check-packaged-kuri.sh
fi

if has_match '^(src/execution/|src/orchestrator/|src/capture/|src/intent-match\.ts|src/extraction/|src/reverse-engineer/|tests/(cli-input-payload|input-payload-ingestion|intent-match|graph-filters)\.test\.ts)$'; then
  run_tests \
    tests/cli-input-payload.test.ts \
    tests/input-payload-ingestion.test.ts \
    tests/intent-match.test.ts \
    tests/graph-filters.test.ts
fi


if has_match '^(packages/skill/package\.json|packages/skill/scripts/|scripts/publish-preview-cli\.mjs|\.release-it\.json)$'; then
  echo "[pre-commit] asserting opaque npm tarball"
  bun run check:opaque-tarball
fi

if has_match '^(docs/|README\.md|packages/skill/README\.md|packages/skill/SKILL\.md|scripts/leak-guard\.sh|src/|packages/|backend/src/)'; then
  echo "[pre-commit] leak-guard: scanning public surface for alpha + covenant mechanism leaks"
  bash scripts/leak-guard.sh
fi
# Client-audit gate (gate 5): the @unbrowse/client OSS surface stays auditable —
# every public export has an audit row and no moat term leaks into client source.
# Self-skips when no client surface / audit map / gate change is staged.
if has_match '^(packages/sdk-v2/|paper/client-audit\.tsv|scripts/client-audit-gate\.sh)'; then
  echo "[pre-commit] client-audit: every public export audited + no moat leak in @unbrowse/client"
  bash scripts/client-audit-gate.sh
fi
# Kuri vendor freshness gate: when the staged diff bumps the
# submodules/kuri gitlink, the packaged vendor manifest source_sha must
# match the new SHA. Prevents Day-5 W5's lost-sheep scenario (7 Windows-
# port submodule bumps shipped with a stale manifest). Self-skips when
# no kuri change is staged. Pattern at scripts/precommit-kuri-vendor.sh.
bash scripts/precommit-kuri-vendor.sh

# Doc-delta probe: when the staged diff carries shipping-surface signals
# (new workspace member, [[bin]], deploy target, new top-level dir, new
# manifest below root) AND no canonical doc (README / architecture /
# CHANGELOG) was touched, print evidence to stderr. Never blocks.
bash scripts/precommit-doc-delta.sh || true


# Parity gate: when src/ files are staged, run bench-targeted to confirm
# CLI and MCP transports agree. Exits 0 even if all probes miss (no cached skill)
# as long as both transports agree. Exits 1 only on divergence.
if has_match '^src/'; then
  # The bench-targeted.sh CLI/MCP parity gate was deleted as part of the
  # benches-as-contracts migration (2026-05-26). Surface the gap honestly
  # per the fallbacks-visible rule instead of failing the commit on a
  # missing script. When the substrate-side bench executor adapter lands,
  # re-wire this gate to invoke it.
  if [ -x scripts/bench-targeted.sh ]; then
    echo "[pre-commit] src/ changed — running bench-targeted parity check"
    if ! bash scripts/bench-targeted.sh --corpus-file scripts/corpus/bench-on-change.txt 2>&1; then
      echo "[pre-commit] FAIL: CLI/MCP parity divergence detected. Fix before committing." >&2
      exit 1
    fi
  else
    echo "[pre-commit] src/ changed — bench-targeted parity gate unavailable (script deleted in benches-as-contracts migration); skipping" >&2
  fi
fi
echo "[pre-commit] fast checks passed"
