#!/bin/bash
# creativity-act-hook — call after unbrowse act execute on cache miss (default-on).
#
# Usage:
#   creativity-act-hook.sh --text "<intent>" [--wallet <pubkey>] [--route <id>] [--cache-miss|--cache-hit]
set -euo pipefail

CE_ACT="${CREATIVITY_ECONOMY_ACT:-/Users/lewis/contract/creativity-economy/scripts/act.sh}"
[[ -f "$CE_ACT" ]] || { echo "creativity-act-hook: missing $CE_ACT" >&2; exit 1; }
exec bash "$CE_ACT" "$@"