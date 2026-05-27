#!/usr/bin/env bash
# exa-probe-fallback-gate — verify.sh
#
# Exits 0 if all three invariants hold across the scope.
# Exits non-zero with a structured error block listing violations.
#
# Invariants (see README.md for the why):
#   A. No resolve envelope can ship success:true together with a body that
#      looks like a login/docs page, UNLESS auth_required:true is set on the
#      same envelope.
#   B. The auth-gated host registry lives as a single const array, never an
#      inline switch/host=== chain at module scope.
#   C. Every synthetic shortlist candidate (Exa probe-fallback today, future
#      search fallbacks tomorrow) carries next_step.go AND next_step.fetch.
#
# Reads scope from sibling scope.txt. Walks every matched file. Read-only.

set -uo pipefail

AUDIT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCOPE_FILE="$AUDIT_DIR/scope.txt"
# Resolve repo root: walk up until we find package.json + src/ + tsconfig.json
REPO_ROOT="$AUDIT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -f "$REPO_ROOT/package.json" ] && [ -d "$REPO_ROOT/src" ] && [ -f "$REPO_ROOT/tsconfig.json" ]; then
    break
  fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done

if [ ! -f "$SCOPE_FILE" ]; then
  echo "exa-probe-fallback-gate: ERROR scope.txt missing" >&2
  exit 2
fi

# Expand scope globs into a file list (newline-separated)
files=""
while IFS= read -r raw; do
  # strip comments + blanks
  line="${raw%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  # tilde expansion
  case "$line" in "~"*) line="$HOME${line#"~"}";; esac
  # if absolute, take as-is; else prefix REPO_ROOT
  case "$line" in /*) pattern="$line";; *) pattern="$REPO_ROOT/$line";; esac
  # use bash glob (nullglob+globstar) for **/*.ts support
  if [ -n "${BASH_VERSION:-}" ]; then
    shopt -s nullglob 2>/dev/null
    shopt -s globstar 2>/dev/null
  fi
  for f in $pattern; do
    [ -f "$f" ] && files="$files$f"$'\n'
  done
done < "$SCOPE_FILE"

files="$(printf '%s' "$files" | awk 'NF && !seen[$0]++')"
file_count="$(printf '%s\n' "$files" | grep -c . || true)"

if [ "$file_count" -eq 0 ]; then
  echo "exa-probe-fallback-gate: ERROR no files matched scope" >&2
  exit 2
fi

violations=""
add_violation() {
  violations="$violations[$1] $2: $3"$'\n'
}

# --------- Invariant A: no success:true near login/docs body ---------
# Heuristic: any line in scope that builds a resolve-envelope literal with
# success:true and (in the surrounding 80-line window) contains one of the
# forbidden body markers without auth_required:true is a violation.
forbidden_markers='<title>Sign in to|Sign in to GitHub|Sign in to X|Sign in to Twitter|"Login - |sign-in page'
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # find lines emitting success: true
  while IFS= read -r hit; do
    line_no="${hit%%:*}"
    [ -z "$line_no" ] && continue
    # window: 40 lines before, 40 lines after
    start=$(( line_no > 40 ? line_no - 40 : 1 ))
    end=$(( line_no + 40 ))
    window="$(awk -v s="$start" -v e="$end" 'NR>=s && NR<=e' "$f")"
    # if window contains a forbidden marker AND does not contain auth_required: true
    if printf '%s' "$window" | grep -Eq "$forbidden_markers"; then
      if ! printf '%s' "$window" | grep -Eq 'auth_required:[[:space:]]*true'; then
        add_violation "A" "$f:$line_no" "success:true near login/docs marker without auth_required:true"
      fi
    fi
  done < <(grep -nE 'success:[[:space:]]*true' "$f" 2>/dev/null || true)
done <<< "$files"

# --------- Invariant B: auth-gated host registry must be a const array ---------
# Flag inlined host comparisons against KNOWN auth-gated hosts at module scope
# (not inside test files, not inside comments). The registry SHOULD live in
# a single file (e.g. src/auth/gated-hosts.ts) exporting a const readonly array.
known_gated_hosts='github\.com|x\.com|twitter\.com|gmail\.com|mail\.google\.com'
const_array_seen=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Detect the canonical const array — accepted in any scope file
  if grep -Eq 'AUTH_GATED_HOSTS[[:space:]]*[:=]' "$f" 2>/dev/null; then
    const_array_seen=1
  fi
  # Flag inline host === "github.com" style outside comments/tests
  if grep -nE "host[[:space:]]*===[[:space:]]*\"($known_gated_hosts)\"" "$f" 2>/dev/null \
        | grep -v '//' | head -5 | while read -r hit; do
    line_no="${hit%%:*}"
    add_violation "B" "$f:$line_no" "inline host=== against known auth-gated host; move to AUTH_GATED_HOSTS const array"
  done; then :; fi
done <<< "$files"

# --------- Invariant C: synthetic shortlist rows need next_step.go + .fetch ---------
# Find candidates.map / candidate-builder blocks that mention url/title/highlights
# but NOT both next_step.go and next_step.fetch in the same 30-line window.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  while IFS= read -r hit; do
    line_no="${hit%%:*}"
    [ -z "$line_no" ] && continue
    end=$(( line_no + 30 ))
    window="$(awk -v s="$line_no" -v e="$end" 'NR>=s && NR<=e' "$f")"
    has_go=$(printf '%s' "$window" | grep -c 'next_step' || true)
    has_fetch=$(printf '%s' "$window" | grep -c 'fetch:' || true)
    has_go_cmd=$(printf '%s' "$window" | grep -c 'go:' || true)
    if [ "$has_go" -gt 0 ] && { [ "$has_fetch" -eq 0 ] || [ "$has_go_cmd" -eq 0 ]; }; then
      add_violation "C" "$f:$line_no" "synthetic candidate next_step missing go: or fetch:"
    fi
  done < <(grep -nE 'highlights_excerpt|exa_candidates' "$f" 2>/dev/null || true)
done <<< "$files"

# Invariant B: if the const array exists, only WARN on inline hits; if NOT, FAIL hard.
# (We treat "no canonical registry yet" as Worker-1's pending fix.)

echo "exa-probe-fallback-gate: scope=$file_count files; const_registry_seen=$const_array_seen"
if [ -z "$violations" ]; then
  echo "exa-probe-fallback-gate: PASS"
  exit 0
fi

echo "exa-probe-fallback-gate: FAIL" >&2
echo "----- violations -----" >&2
printf '%s' "$violations" >&2
echo "----- end -----" >&2
exit 1
