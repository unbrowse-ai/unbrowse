#!/usr/bin/env bash
# bare-clone-gate.sh — every adapter the witnesses USE (served or load()ed) is reproducible from
# scratch in this dir: self-trained by a vendored script (mlx_lm.lora --train / train()). The base
# model needs no adapter. Exit 0 iff no used adapter lacks a from-scratch recipe.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 - <<'PY'
import re, glob, sys
files = {f: open(f).read() for f in glob.glob("*.py")}
# USED = every adapter VALUE assigned to a variable that is referenced more than once (i.e. actually
# served/loaded), excluding the base model. This catches serve_and_bench(VAR)/evaluate(VAR)/load paths.
used = {}
for f, t in files.items():
    for var, val in re.findall(r'(\b[A-Z_][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+_adapters)"', t):
        if len(re.findall(rf'\b{var}\b', t)) >= 2:   # assigned AND used
            used.setdefault(val, set()).add(f)
# TRAINED = adapter has a from-scratch recipe: a vendored script trains it (lora --train with its var, or train(VAR/"val"))
trained = set()
for f, t in files.items():
    asg = dict(re.findall(r'(\b[A-Z_][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+_adapters)"', t))
    for var, val in asg.items():
        if "--train" in t and re.search(rf'--adapter-path"?\s*,?\s*"?{var}\b', t): trained.add(val)
        if re.search(rf'\btrain\(\s*{var}\b', t) or re.search(rf'\btrain\(\s*"{val}"', t): trained.add(val)
    for lit in re.findall(r'--adapter-path",\s*"([a-z0-9_]+)"', t): trained.add(lit)
missing = sorted(a for a in used if a not in trained)
for a in sorted(used):
    print(f"  {'✓' if a in trained else '✗'} {a:24} {'self-trained' if a in trained else 'FIXED ARTIFACT — no recipe'}  (used in {','.join(sorted(used[a]))})")
print(f"[bare-clone] base-only witnesses (load(M), no adapter): farformula" )
if missing:
    print(f"[bare-clone] FAIL: no from-scratch recipe for {missing} — a bare clone cannot rebuild them"); sys.exit(1)
print("[bare-clone] PASS — every used adapter is self-trainable; bare-clone reproducible")
PY
