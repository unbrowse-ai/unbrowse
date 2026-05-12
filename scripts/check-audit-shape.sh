#!/usr/bin/env bash
# check-audit-shape.sh — falsifiable shape check for Day-2 firmament audits.
# Usage: scripts/check-audit-shape.sh <path-to-audit.md>
# Exit 0 = PASS, 1 = FAIL (prints the failing condition).

set -u

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "FAIL: audit file not provided or not found: '$file'"
  exit 1
fi

# 6 required H2 headings in this exact order. Match leading word only;
# tolerate " (Day N / Word)" suffixes per the firmament shape.
expected_words=(Symptom Evidence Hypothesis Reproduction Verdict Action)

headings=()
while IFS= read -r line; do
  headings+=("$line")
done < <(grep -n '^## ' "$file" || true)

if [ "${#headings[@]}" -lt 6 ]; then
  echo "FAIL: found ${#headings[@]} H2 headings, need 6"
  for h in "${headings[@]}"; do echo "  $h"; done
  exit 1
fi

for i in 0 1 2 3 4 5; do
  word="${expected_words[$i]}"
  line="${headings[$i]}"
  heading_text="${line#*## }"
  first_word="${heading_text%% *}"
  first_word_clean="$(printf '%s' "$first_word" | tr -cd '[:alpha:]')"
  if [ "$first_word_clean" != "$word" ]; then
    echo "FAIL: heading #$((i+1)) expected leading word '$word', got '$heading_text'"
    exit 1
  fi
done

# Verdict enum: first non-blank line after `## Verdict` must start with
# TRANSIENT, BUG, or UNKNOWN (case-insensitive, optional **bold**).
verdict_lineno="$(grep -n '^## Verdict' "$file" | head -1 | cut -d: -f1)"
if [ -z "$verdict_lineno" ]; then
  echo "FAIL: no '## Verdict' heading found"
  exit 1
fi

verdict_value="$(awk -v start="$verdict_lineno" 'NR>start && NF>0 {print; exit}' "$file")"
verdict_clean="$(printf '%s' "$verdict_value" | sed -E 's/^[[:space:]*]+//' | awk '{print $1}' | tr -cd '[:alpha:]')"
verdict_upper="$(printf '%s' "$verdict_clean" | tr '[:lower:]' '[:upper:]')"

case "$verdict_upper" in
  TRANSIENT|BUG|UNKNOWN) ;;
  *)
    echo "FAIL: Verdict enum invalid — got '$verdict_value' (parsed: '$verdict_upper'), expected TRANSIENT|BUG|UNKNOWN"
    exit 1
    ;;
esac

echo "PASS: 6 headings in order + Verdict=$verdict_upper"
exit 0
