# execute-don't-guess — the SLM tool-routing witnesses (vendored, reproducible from this repo)

The four headline "execute, don't guess" numbers, with their runnable witnesses now living
in the unbrowse repo (was: a sibling `tinytools-agent` checkout). Each spawns the served
0.8B model with the relevant adapter and scores a disjoint held-out set through the real
generation+execution loop.

```bash
bash setup.sh                          # resolve adapters/data (copy from tinytools or train)
RIFE=/path/to/mlx-python                # an mlx_lm-capable python
$RIFE codebench_witness.py             # code        25% -> 100%   (trains its own adapter if absent)
$RIFE farformula_witness.py            # knowledge    0% ->  95%
$RIFE specialist_witness.py            # reasoning   50% ->  92%
$RIFE skillfollow_witness.py           # skill       63% ->  93%
$RIFE codebench_reliability.py         # seed-stability + unseen-family scope
```

Locality witness: `bash witness-locality-gate.sh` — exit 0 when the scripts are vendored,
self-contained (no sibling-repo paths), compile clean, and codebench runs green from HERE.
Adapters (~280M) are resolved by setup, not committed (see .gitignore). Paper: `paper/execute-dont-guess-benchmarks.md`.

## Bare-clone reproducibility (no sibling repo, no adapters present)

`bash train-from-scratch.sh` rebuilds every adapter from scratch and verifies all four
witnesses — the base model downloads from HuggingFace; no tinytools checkout needed:
- `improved_adapters` ← codebench (hand-written rule teacher, 7 families)
- `r1_adapters` ← r1_witness (rejection-sample improved's correct outputs, self-distil)
- `unified_v2_adapters` ← specialist (specialist→generalist)
- farformula is base-only; skillfollow uses `improved_adapters`.

Recipe-completeness witness: `bash bare-clone-gate.sh` — exit 0 iff every adapter the
witnesses use is the base model or self-trained by a vendored script (no fixed artifacts).
codebench's baseline is the raw base model (the true pre-distillation state).
