#!/bin/bash
# generate-child.sh "<child plan text>" — the "writes contracts" primitive.
#
# Thin, GENERIC wrapper over `harness build`. It writes ONE child
# meta-harness contract from the plan text the AGENT supplies, then binds
# the new child slug into the umbrella's bound_contracts: list and records
# it to ledgers/children.txt (the durable manifest of what this umbrella
# generated).
#
# Substrate-faithful: this script never decides WHICH contract to write.
# The agent judges the plan text in-thread from the cited evidence in
# references/banger-best-practices.md and passes it as $1. The script only
# performs the mechanical build + bind + record.
#
# Idempotent: if a child with the same inferred slug is already bound, the
# build still runs (harness build is itself idempotent on slug) but the
# bind/record steps skip the duplicate.
set -euo pipefail

PLAN_TEXT="${1:?usage: generate-child.sh \"<child plan text>\"}"
PROJECT="/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse"
UMBRELLA="make-unbrowse-banger-a-meta-contract-that-writes"
STATE="$PROJECT/.claude/$UMBRELLA.local.md"
SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$SCAFFOLD/ledgers/children.txt"
HARNESS="$HOME/.claude/skills/meta-harness/scripts/harness"

[[ -f "$STATE" ]]   || { echo "[generate-child] umbrella state file missing: $STATE" >&2; exit 1; }
[[ -f "$HARNESS" ]] || { echo "[generate-child] harness CLI missing: $HARNESS"      >&2; exit 1; }

echo "[generate-child] building child contract from agent-supplied plan"
echo "[generate-child] plan: ${PLAN_TEXT:0:120}..."

# Build the child. harness build self-calls the child's first iterate; that
# is expected (the child's iter-1 row lands honestly, pass or fail-closed).
OUT="$(bash "$HARNESS" build "$PLAN_TEXT" --project "$PROJECT" 2>&1)" || {
  echo "$OUT" >&2
  echo "[generate-child] harness build FAILED" >&2
  exit 1
}
echo "$OUT"

# Extract the child slug from the JSON block harness build prints.
SLUG="$(printf '%s\n' "$OUT" | python3 -c '
import sys, json, re
text = sys.stdin.read()
m = re.search(r"\{.*\}", text, re.S)
if m:
    try:
        print(json.loads(m.group(0)).get("plan_slug", ""))
        sys.exit(0)
    except Exception:
        pass
m = re.search(r"plan_slug\"?\s*[:=]\s*\"?([a-z0-9-]+)", text)
print(m.group(1) if m else "")
')"

[[ -n "$SLUG" ]] || { echo "[generate-child] could not extract child slug from build output" >&2; exit 1; }
echo "[generate-child] child slug: $SLUG"

# Record to the durable manifest (skip duplicate).
touch "$MANIFEST"
if grep -qxF "$SLUG" "$MANIFEST"; then
  echo "[generate-child] $SLUG already in manifest — skip record"
else
  echo "$SLUG" >> "$MANIFEST"
  echo "[generate-child] recorded $SLUG to ledgers/children.txt"
fi

# Bind the child into the umbrella's bound_contracts: list.
python3 - "$STATE" "$SLUG" <<'PYBIND'
import sys
state_path, slug = sys.argv[1], sys.argv[2]
lines = open(state_path).read().splitlines(keepends=True)
out, in_bound, bound_indent, already, inserted = [], False, "  ", False, False
# Detect existing real (uncommented) entry.
for ln in lines:
    s = ln.strip()
    if s == "bound_contracts:":
        in_bound = True
        out.append(ln)
        continue
    if in_bound:
        # leave the commented candidate block; detect an existing real entry
        if s.startswith("- ") and s[2:].strip() == slug:
            already = True
        # a non-indented key ends the bound_contracts block
        if ln and not ln[0].isspace() and s and not s.startswith("#"):
            if not already and not inserted:
                out.append(f"{bound_indent}- {slug}\n")
                inserted = True
            in_bound = False
        out.append(ln)
        continue
    out.append(ln)
# bound_contracts was the last block in frontmatter (ended by ---)
if in_bound and not already and not inserted:
    # insert the entry right after the bound_contracts: line
    final = []
    for ln in out:
        final.append(ln)
        if ln.strip() == "bound_contracts:":
            final.append(f"{bound_indent}- {slug}\n")
    out = final
    inserted = True
if already:
    print(f"[generate-child] {slug} already bound — skip")
else:
    open(state_path, "w").write("".join(out))
    print(f"[generate-child] bound {slug} into umbrella bound_contracts:")
PYBIND

# Extend the .gitignore managed block so the new child scaffold survives a
# clean clone (re-include its dir, re-ignore its transient logs/).
python3 - "$PROJECT/.gitignore" "$SLUG" <<'PYGI'
import sys
gi_path, slug = sys.argv[1], sys.argv[2]
START, END = "# meta-harness:gitignore START", "# meta-harness:gitignore END"
try:
    lines = open(gi_path).read().splitlines(keepends=True)
except FileNotFoundError:
    lines = []
inc = f"!.claude/{slug}/\n"
ign = f".claude/{slug}/logs/\n"
joined = "".join(lines)
if inc in joined:
    print(f"[generate-child] .gitignore already re-includes {slug} — skip")
elif END + "\n" in joined or any(l.rstrip() == END for l in lines):
    out = []
    for l in lines:
        if l.rstrip() == END:
            out.append(inc); out.append(ign)
        out.append(l)
    open(gi_path, "w").write("".join(out))
    print(f"[generate-child] .gitignore: re-included {slug} scaffold")
else:
    block = ["\n", START + "\n", inc, ign, END + "\n"]
    open(gi_path, "w").write(joined + "".join(block))
    print(f"[generate-child] .gitignore: created managed block, re-included {slug}")
PYGI

echo "[generate-child] done: $SLUG written, recorded, bound, persisted"
