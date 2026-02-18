#!/usr/bin/env bash
set -euo pipefail

# Package this repo's skill into a single `.skill` file (zip).
# Output: dist/unbrowse.skill

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

name="unbrowse"
out_dir="${1:-dist}"
mkdir -p "$out_dir"

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Minimal skill payload. Keep this intentionally small.
cp -f SKILL.md "$tmp/SKILL.md"
mkdir -p "$tmp/agents" "$tmp/scripts"
cp -f agents/openai.yaml "$tmp/agents/openai.yaml"
cp -f scripts/ensure-agent-browser.sh "$tmp/scripts/ensure-agent-browser.sh"

out="$out_dir/$name.skill"
rm -f "$out"

(cd "$tmp" && zip -qr "$root/$out" .)

echo "Wrote $out"

