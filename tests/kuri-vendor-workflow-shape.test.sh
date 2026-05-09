#!/usr/bin/env bash
# Falsifier for .github/workflows/kuri-vendor.yml structure.
# plan-v13 Day 4 luminary B — Tier 1 seed must be manual-dispatch only,
# 4-platform matrix, lekt9/kuri checkout, kuri-<platform> artifacts.
set -u

WF=".github/workflows/kuri-vendor.yml"
FAILED=0

pass() { printf "PASS %s\n" "$1"; }
fail() { printf "FAIL %s — %s\n" "$1" "$2"; FAILED=1; }

# 1. file exists
if [ -f "$WF" ]; then pass "file_exists"; else fail "file_exists" "$WF missing"; exit 1; fi

# 2. parseable YAML — prefer python3+pyyaml, fall back to node+js-yaml. Never silently pass.
PARSER=""
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
  PARSER="python3"
elif command -v node >/dev/null 2>&1 && node -e "require('js-yaml')" 2>/dev/null; then
  PARSER="node"
else
  fail "yaml_parser_available" "neither python3+yaml nor node+js-yaml available — refusing to silently pass"
  exit 1
fi

if [ "$PARSER" = "python3" ]; then
  if python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$WF" 2>/dev/null; then
    pass "yaml_parses"
  else
    fail "yaml_parses" "python3 yaml.safe_load failed"
    exit 1
  fi
else
  if node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8'))" "$WF" 2>/dev/null; then
    pass "yaml_parses"
  else
    fail "yaml_parses" "node js-yaml load failed"
    exit 1
  fi
fi

# Helper: run a python yaml block. Note: in YAML 1.1, 'on' is a boolean (True),
# so d.get('on') returns None — must check d.get(True) too.
pyyaml() {
  python3 - "$WF" <<'PY'
import yaml, sys
WF = sys.argv[1]
d = yaml.safe_load(open(WF))
import os
mode = os.environ.get('CHECK','')
if mode == 'trigger_keys':
    on = d.get('on', d.get(True))
    if on is None:
        print('MISSING')
    elif isinstance(on, dict):
        print(','.join(sorted(on.keys())))
    elif isinstance(on, list):
        print(','.join(sorted(on)))
    else:
        print(str(on))
elif mode == 'matrix':
    inc = d['jobs']['build']['strategy']['matrix']['include']
    print(len(inc))
    print(','.join(sorted(e['platform'] for e in inc)))
elif mode == 'zig_targets':
    import re
    inc = d['jobs']['build']['strategy']['matrix']['include']
    pat = re.compile(r'^(aarch64-macos|x86_64-macos|aarch64-linux|x86_64-linux)$')
    bad = [(e.get('platform'), e.get('zig_target')) for e in inc if not pat.match(str(e.get('zig_target','')))]
    print('OK' if not bad else 'BAD:'+repr(bad))
PY
}

# 3. trigger is exactly workflow_dispatch
TRIGGER_KEYS=$(CHECK=trigger_keys pyyaml)
if [ "$TRIGGER_KEYS" = "workflow_dispatch" ]; then
  pass "trigger_is_workflow_dispatch_only"
else
  fail "trigger_is_workflow_dispatch_only" "got: $TRIGGER_KEYS (expected exactly 'workflow_dispatch')"
fi

# 4. matrix has exactly 4 entries with required platforms
MATRIX=$(CHECK=matrix pyyaml)
PCOUNT=$(printf '%s' "$MATRIX" | sed -n '1p')
PLIST=$(printf '%s' "$MATRIX" | sed -n '2p')
EXPECTED="darwin-arm64,darwin-x64,linux-arm64,linux-x64"

if [ "$PCOUNT" = "4" ]; then
  pass "matrix_has_4_entries"
else
  fail "matrix_has_4_entries" "got $PCOUNT"
fi

if [ "$PLIST" = "$EXPECTED" ]; then
  pass "matrix_platforms_correct"
else
  fail "matrix_platforms_correct" "got [$PLIST] expected [$EXPECTED]"
fi

# 5. each matrix entry has zig_target matching expected pattern
ZIG_OK=$(CHECK=zig_targets pyyaml)
if [ "$ZIG_OK" = "OK" ]; then
  pass "matrix_zig_targets_valid"
else
  fail "matrix_zig_targets_valid" "$ZIG_OK"
fi

# 6. workflow checks out lekt9/kuri (string presence)
if grep -qE 'repository:[[:space:]]*lekt9/kuri' "$WF"; then
  pass "checks_out_lekt9_kuri"
else
  fail "checks_out_lekt9_kuri" "no 'repository: lekt9/kuri' line"
fi

# 7. each platform uploads artifact named kuri-<platform> (regex)
if grep -qE 'name:[[:space:]]*kuri-\$\{\{[[:space:]]*matrix\.platform[[:space:]]*\}\}' "$WF"; then
  pass "uploads_kuri_platform_artifact"
else
  fail "uploads_kuri_platform_artifact" "no 'name: kuri-\${{ matrix.platform }}' upload step"
fi

if [ "$FAILED" -ne 0 ]; then
  printf "\nFAILED\n"
  exit 1
fi
printf "\nALL PASS\n"
exit 0
