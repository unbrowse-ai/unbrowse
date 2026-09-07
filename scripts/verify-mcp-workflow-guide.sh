#!/usr/bin/env bash
# Falsifier for docs/mcp-workflow-guide.md. Three signals:
#   A. Length cap — guide is < 500 lines.
#   B. Tool coverage — every tool name in src/mcp.ts appears in the guide.
#   C. Citation integrity — every src/mcp.ts:LINE cite resolves to a real line.

set -u
fail=0
mcp=src/mcp.ts
guide=docs/mcp-workflow-guide.md

for f in "$mcp" "$guide"; do
  if [ ! -f "$f" ]; then
    echo "ERROR  required file missing: $f (run from repo root)"
    exit 2
  fi
done

# A — Length
lines=$(wc -l < "$guide" | tr -d ' ')
if [ "$lines" -lt 500 ]; then
  printf "PASS  A — guide is under 500 lines (%s lines)\n" "$lines"
else
  printf "FAIL  A — guide is %s lines (cap is 500)\n" "$lines"
  fail=1
fi

# B — Tool coverage
tools=$(awk -F'"' '/^    name: "unbrowse_/ { print $2 }' "$mcp" | sort -u)
tool_count=$(printf "%s\n" "$tools" | wc -l | tr -d ' ')

if [ "$tool_count" -lt 30 ]; then
  echo "WARN  extracted only $tool_count tools; expected ~33. awk pattern may be drifting."
fi

missing=""
miss_count=0
for t in $tools; do
  if ! grep -q "$t" "$guide"; then
    missing="${missing}        ${t}
"
    miss_count=$((miss_count + 1))
  fi
done

if [ "$miss_count" -eq 0 ]; then
  printf "PASS  B — all %s MCP tools mentioned in guide\n" "$tool_count"
else
  printf "FAIL  B — %s tools NOT mentioned in guide:\n" "$miss_count"
  printf "%s" "$missing"
  fail=1
fi

# C — Citation integrity
src_lines=$(wc -l < "$mcp" | tr -d ' ')
cites=$(grep -oE 'src/mcp\.ts:[0-9]+' "$guide" | sed 's|.*:||' | sort -un)
cite_count=$(printf "%s\n" "$cites" | grep -c '[0-9]')

bad_cites=""
bad_count=0
for n in $cites; do
  if [ "$n" -lt 1 ] || [ "$n" -gt "$src_lines" ]; then
    bad_cites="${bad_cites}        ${n} (out of range; file has $src_lines lines)
"
    bad_count=$((bad_count + 1))
  fi
done

if [ "$bad_count" -eq 0 ]; then
  printf "PASS  C — all %s cited src/mcp.ts line numbers are in range\n" "$cite_count"
else
  printf "FAIL  C — %s cited lines out of range:\n" "$bad_count"
  printf "%s" "$bad_cites"
  fail=1
fi

# D — Citation content match
# For each Part II table row `| `tool` | LINE | ...`, the cited line must be
# the actual `name: "tool"` declaration in src/mcp.ts. Stops the verifier from
# passing when line numbers drift after Phase-1-style insertions.
guide_table_rows=$(awk -F'|' '/^\| `unbrowse_[a-z_]*` \| [0-9]+ \|/ { 
  gsub(/[ `]/, "", $2); gsub(/[ ]/, "", $3); print $2 ":" $3 }' "$guide")

drift_rows=""
drift_count=0
for pair in $guide_table_rows; do
  tool="${pair%%:*}"
  line="${pair##*:}"
  if [ -z "$line" ] || [ -z "$tool" ]; then continue; fi
  actual=$(sed -n "${line}p" "$mcp" 2>/dev/null)
  if ! echo "$actual" | grep -q "name: \"$tool\""; then
    drift_rows="${drift_rows}        ${tool}@${line} (line is: ${actual:0:60}...)
"
    drift_count=$((drift_count + 1))
  fi
done

if [ "$drift_count" -eq 0 ]; then
  printf "PASS  D — every Part II table cite points at a real \`name:\` declaration\n"
else
  printf "FAIL  D — %s tool cites drifted off their declarations:\n" "$drift_count"
  printf "%s" "$drift_rows"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Workflow guide is coherent with src/mcp.ts."
  exit 0
else
  echo "Guide is out of sync with src/mcp.ts. Refresh docs/mcp-workflow-guide.md."
  exit 1
fi
