#!/usr/bin/env bash
# md-commandments-gate — hold every PUBLIC-FACING Markdown file to ten concrete
# commandments. Exit 0 iff all of them hold.
#
# Scope = the doc surface a reader actually sees: root README.md / SKILL.md, the
# shipped doc trees (the same set open-core-sync.sh publishes), the shipped root
# docs, and the public package READMEs. Internal notes (internal/, docs/design,
# docs/decisions, docs/archive, docs/built-on-unbrowse, and other dev-only docs)
# are out of scope — they are allowed to use internal vocabulary and looser form.
#
#   bash scripts/md-commandments-gate.sh            # dev repo public docs
#   bash scripts/md-commandments-gate.sh <dir>      # an assembled tree
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# --- collect the public-facing markdown set (mirror open-core-sync) ----------
FILES=()
add() { [ -f "$1" ] && FILES+=("$1"); }
add README.md
add SKILL.md
for d in for-developers for-agents sdk whitepaper start-here public concepts; do
  while IFS= read -r f; do FILES+=("$f"); done < <(find "docs/$d" -type f -name '*.md' 2>/dev/null | sort)
done
for rootdoc in OPEN-SOURCE-NOTICE README SECURITY vision HOW_UNBROWSE_PAYS THE_FDRY_ECONOMY; do
  add "docs/$rootdoc.md"
done
# public package READMEs (the shipped drop-ins / adapters)
while IFS= read -r f; do FILES+=("$f"); done < <(
  find packages -maxdepth 2 -name 'README.md' 2>/dev/null | grep -vE '/(node_modules|dist|skill|extraction-core)/' | sort)

[ "${#FILES[@]}" -gt 0 ] || { echo "[md10] no markdown files in scope under $ROOT"; exit 1; }

VIOL=0
fail() { VIOL=$((VIOL+1)); printf '  X [%s] %s\n' "$1" "$2"; }

# Forbidden / pattern sets
FORBIDDEN_VOCAB='covenant|superpattern|jesus[ -]?pattern|\bjesus\b|firmament|grain[ -]of[ -]wheat|\bthe cross\b|vine doctrine|\babiding\b|\babide\b|\bsubstrate\b|(Deuteronomy|John|Matthew|Luke|Genesis|Hebrews|2 ?Timothy|1 ?Cor(inthians)?)[ ]+[0-9]+:[0-9]+|at the mouth of (two|three)'
SECRET_PAT='BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|xox[bap]-[0-9A-Za-z-]{10,}|gh[ps]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|\bre_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'
LOCALPATH_PAT='/Users/[a-z]|/home/[a-z]|~/Projects/|\.codex/worktrees|\b100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b|\.ts\.net\b'
# standalone tracking markers + lorem + empty links + unrendered template tokens.
# (XXX is intentionally excluded: it collides with example API keys like 'exa-xxx'.)
MARKER_PAT='(^|[^A-Za-z])(TODO|TBD|FIXME)([^A-Za-z]|$)|lorem ipsum|\]\( *\)|\{\{[^}]+\}\}|<(PLACEHOLDER|YOUR_[A-Z_]+)>'

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  body=$(cat "$f")

  #  I. No false vocabulary
  hit=$(printf '%s' "$body" | grep -inE -- "$FORBIDDEN_VOCAB" | head -1)
  [ -n "$hit" ] && fail "I:vocabulary" "$f: $hit"
  # II. No graven secrets
  hit=$(printf '%s' "$body" | grep -inE -- "$SECRET_PAT" | head -1)
  [ -n "$hit" ] && fail "II:secret" "$f: ${hit:0:80}"
  # III. No local idols (absolute local paths / internal infra)
  hit=$(printf '%s' "$body" | grep -inE -- "$LOCALPATH_PAT" | head -1)
  [ -n "$hit" ] && fail "III:local-path" "$f: $hit"
  # IV. Finish your work — no tracking markers / lorem / empty links / templates
  hit=$(printf '%s' "$body" | grep -inE -- "$MARKER_PAT" | head -1)
  [ -n "$hit" ] && fail "IV:marker" "$f: $hit"
  # V. Substance — not a stub (> 200 bytes)
  [ "${#body}" -gt 200 ] || fail "V:substance" "$f: only ${#body} bytes (stub)"
  # VI. Bear true witness — code fences balanced
  fences=$(printf '%s\n' "$body" | grep -cE '^```' || true)
  [ $((fences % 2)) -eq 0 ] || fail "VI:unbalanced-fence" "$f: odd \`\`\` fence count ($fences)"
  # VII. Honor the reader — the doc has a heading (a title exists)
  printf '%s\n' "$body" | grep -qE '^#{1,6} ' || fail "VII:no-heading" "$f: no Markdown heading at all"
  # VIII. At most one H1 (0 is allowed: some pages inject their own title).
  # Fence-aware: a `# ` line inside a ``` code block is a comment, not a heading.
  h1=$(printf '%s\n' "$body" | awk '
    /^```/ { infence = !infence; next }
    !infence && /^# [^#]/ { n++ }
    END { print n+0 }')
  [ "$h1" -le 1 ] || fail "VIII:multi-H1" "$f: $h1 H1 headings (use one H1 + H2 sections)"
  # IX. Keep links holy — relative file links resolve on disk
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    case "$link" in http*|//*|\#*|mailto:*|tel:*) continue ;; esac
    target="${link%%#*}"; [ -z "$target" ] && continue
    case "$target" in *[\ \<\>]*) continue ;; esac
    if [ "${target#/}" != "$target" ]; then
      [ -e "${ROOT}${target}" ] || fail "IX:dead-link" "$f -> $link"
    else
      [ -e "$(dirname "$f")/$target" ] || fail "IX:dead-link" "$f -> $link"
    fi
  done < <(printf '%s' "$body" | grep -oE '\]\([^)]+\.(md|json|ts|tsx|js|sh|py)[^)]*\)' | sed -E 's/^\]\(//; s/\)$//')
  #  X. No trailing-whitespace sloppiness on content lines (consistency)
  if printf '%s\n' "$body" | grep -nE ' +$' | grep -qvE ':\s*$'; then
    : # tolerate blank-line trailing space; only flag content lines
  fi
  tw=$(printf '%s\n' "$body" | grep -cE '[^[:space:]] +$' || true)
  [ "$tw" -eq 0 ] || fail "X:trailing-space" "$f: $tw line(s) with trailing whitespace"
done

echo "[md10] scanned ${#FILES[@]} public markdown files"
if [ "$VIOL" -gt 0 ]; then
  echo "[md10] FAIL — $VIOL commandment violation(s)"
  exit 1
fi
echo "[md10] PASS — all ten commandments hold across the public doc surface"
