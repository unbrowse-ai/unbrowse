#!/usr/bin/env bash
#
# Public docs + npm metadata audit.
# Catches the recurring public-surface regressions from:
# - stale SDK version pins
# - legacy install commands
# - broken local markdown links in public entrypoints
# - internal substrate / low-level moat vocabulary leaking into docs users read

set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0
fail() {
  echo "[public-docs-audit] FAIL: $*" >&2
  FAIL=1
}

sdk_version=$(node -p "require('./packages/sdk/package.json').version")
# Public README advertises the latest STABLE release; an in-flight preview prerelease in
# package.json must not force the README to a preview version.
case "$sdk_version" in *-*) sdk_version="$(git tag --list 'v*' --sort=-v:refname | grep -vE '\-' | head -1 | sed 's/^v//')";; esac
if ! grep -qF "Current version: **${sdk_version}**." packages/sdk/README.md; then
  fail "packages/sdk/README.md current version does not match package.json (${sdk_version})"
fi

PUBLIC_SURFACES=(
  README.md
  docs/EARN_AS_INDEXER.md
  docs/OPEN-SOURCE-NOTICE.md
  docs/for-developers
  frontend/src/app
  frontend/src/components
  frontend/src/lib/blog
  packages/sdk/README.md
  packages/sdk-v2/README.md
  packages/sdk-v2/package.json
  packages/skill/README.md
  packages/skill/SKILL.md
  packages/skill/package.json
)

if grep -RInE 'npx @unbrowse/sdk(@latest)?|@unbrowse/sdk setup|npm i @unbrowse/client@|npm install @unbrowse/client@' \
  "${PUBLIC_SURFACES[@]}" \
  --include='*.md' --include='*.tsx' --include='*.ts' --include='package.json' >/tmp/unbrowse-public-docs-legacy.$$ 2>/dev/null; then
  cat /tmp/unbrowse-public-docs-legacy.$$ >&2
  fail "legacy or version-pinned public install command found"
fi
rm -f /tmp/unbrowse-public-docs-legacy.$$

if grep -RInE 'contract [0-9a-f]{8}\b|organ [0-9a-f]{8}\b|contract:[0-9a-f]{8}\b|\bKEY [123]\b|\bsubstrate\b|\bheaders_template\b' \
  "${PUBLIC_SURFACES[@]}" \
  --include='*.md' --include='*.tsx' --include='*.ts' --include='package.json' >/tmp/unbrowse-public-docs-substrate.$$ 2>/dev/null; then
  cat /tmp/unbrowse-public-docs-substrate.$$ >&2
  fail "internal substrate vocabulary leaked into public docs/metadata"
fi
rm -f /tmp/unbrowse-public-docs-substrate.$$

if grep -RInE 'reverse-engineer|reverse engineering|anti-bot bypass|vendor-specific research|cookie injection|/v1/auth/steal|SQLite database|credentials\.enc|vault/\.key|HAR parsing' \
  "${PUBLIC_SURFACES[@]}" \
  --include='*.md' --include='*.tsx' --include='*.ts' --include='package.json' >/tmp/unbrowse-public-docs-moat.$$ 2>/dev/null; then
  cat /tmp/unbrowse-public-docs-moat.$$ >&2
  fail "low-level capture/auth/moat detail leaked into public docs/metadata"
fi
rm -f /tmp/unbrowse-public-docs-moat.$$

python3 - <<'PY' || FAIL=1
import pathlib, re, sys

docs = [
    pathlib.Path("README.md"),
    pathlib.Path("packages/sdk/README.md"),
    pathlib.Path("packages/sdk-v2/README.md"),
    pathlib.Path("packages/skill/README.md"),
]
ok = True
for path in docs:
    text = path.read_text()
    for raw in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        target = raw.split("#", 1)[0].split("?", 1)[0]
        if not target or re.match(r"^(https?:|mailto:|#)", target):
            continue
        resolved = (path.parent / target).resolve()
        if not resolved.exists():
            print(f"[public-docs-audit] FAIL: broken link {path} -> {target} (resolved {resolved})", file=sys.stderr)
            ok = False
if not ok:
    sys.exit(1)
PY

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "[public-docs-audit] clean"
