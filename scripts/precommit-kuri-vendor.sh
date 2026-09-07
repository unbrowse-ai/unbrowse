#!/usr/bin/env bash
# Pre-commit Kuri vendor freshness gate.
#
# Fires ONLY when the staged diff bumps the submodules/kuri gitlink.
# When triggered, compares the NEW staged submodule SHA against
# packages/skill/vendor/kuri/manifest.json source_sha. Mismatch BLOCKS
# the commit with an actionable rebuild command.
#
# Prevents the Day-5 Worker-5 lost-sheep scenario: 7 Windows-port
# submodule bumps (ba7e87c00, f55011c99, f0f68cc2f, +4 more) advanced
# Kuri without regenerating the vendor manifest. The vendor guard
# (packages/skill/scripts/assert-kuri-vendor.mjs) caught it eventually
# but only at release-it pack time — this hook catches it at commit
# time when the fix is cheap.
#
# Self-contained: pure bash + git + standard unix tools, no node/bun
# dependency so it stays fast (~5ms) when no kuri change is staged.

set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Fast path: only fire when submodules/kuri is in the staged diff.
# .gitmodules edits alone don't bump the gitlink, but include them so
# branch/url rewrites that pair with a SHA bump get the same check.
STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
if ! echo "$STAGED" | grep -qE '^(submodules/kuri|\.gitmodules)$'; then
  exit 0
fi

# Only proceed if the gitlink itself is staged (a .gitmodules-only edit
# without a SHA bump is fine).
if ! echo "$STAGED" | grep -qE '^submodules/kuri$'; then
  exit 0
fi

MANIFEST="packages/skill/vendor/kuri/manifest.json"
if ! git cat-file -e ":$MANIFEST" 2>/dev/null; then
  echo "[pre-commit kuri-vendor] ERROR: $MANIFEST missing from index — cannot verify Kuri vendor freshness" >&2
  exit 1
fi

# Read the NEW staged submodule SHA (the one this commit would land).
STAGED_SHA=$(git rev-parse :submodules/kuri 2>/dev/null || true)
if [[ -z "$STAGED_SHA" ]]; then
  echo "[pre-commit kuri-vendor] ERROR: could not read staged submodules/kuri SHA" >&2
  exit 1
fi

# Extract manifest source_sha from the INDEX, not the worktree. Earlier
# pre-commit steps run pack/leak checks that may refresh generated files in the
# working tree; this guard is about what the pending commit will land.
MANIFEST_SHA=$(git show ":$MANIFEST" | grep -E '"source_sha"' | head -1 | sed -E 's/.*"source_sha"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/')
if [[ -z "$MANIFEST_SHA" ]]; then
  echo "[pre-commit kuri-vendor] ERROR: could not parse source_sha from $MANIFEST" >&2
  exit 1
fi

if [[ "$STAGED_SHA" == "$MANIFEST_SHA" ]]; then
  echo "[pre-commit kuri-vendor] ok — manifest source_sha matches staged Kuri SHA ($STAGED_SHA)"
  exit 0
fi

cat >&2 <<EOF
[pre-commit kuri-vendor] BLOCKED — Kuri vendor manifest is stale.

  staged submodules/kuri SHA : $STAGED_SHA
  manifest source_sha        : $MANIFEST_SHA
  manifest path              : $MANIFEST

The submodule pointer is moving but the baked binaries + manifest were not
regenerated. Release-time prepare-pack will reject this and CI will fail.

Rebuild the vendor manifest in the same commit:

  UNBROWSE_REBUILD_KURI=1 node packages/skill/scripts/build-kuri-binaries.mjs
  git add packages/skill/vendor/kuri/manifest.json packages/skill/vendor/kuri/
  git commit ...

Or, if this commit is intentionally only moving the submodule pointer for
a downstream rebuild (rare), unstage the bump:

  git restore --staged submodules/kuri
EOF
exit 1
