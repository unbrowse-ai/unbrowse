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
