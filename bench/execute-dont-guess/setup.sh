#!/usr/bin/env bash
# setup.sh — make the execute-don't-guess witnesses runnable from the unbrowse repo.
# Resolves the ~280M of adapters/data the witnesses need: copies them from a tinytools
# checkout if present ($TINYTOOLS_DIR, default ~/Projects/tinytools-agent); codebench can
# also TRAIN its own adapter from scratch (train_if_absent), so the headline 25->100 is
# reproducible even with no sibling repo (base model downloads from HuggingFace).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC="${TINYTOOLS_DIR:-$HOME/Projects/tinytools-agent}"
NEED="code_adapters improved_adapters r1_adapters unified_adapters unified_v2_adapters nck_specialist codebench_data r1_data nck_specialist_data"
if [ -d "$SRC" ]; then
  for d in $NEED; do [ -d "$SRC/$d" ] && [ ! -e "$d" ] && cp -R "$SRC/$d" . && echo "  resolved $d"; done
  echo "[setup] adapters/data resolved from $SRC"
else
  echo "[setup] no tinytools checkout at $SRC — codebench will TRAIN its adapter from scratch"
  echo "         (the other three witnesses need their adapters; set TINYTOOLS_DIR or train them)"
fi
