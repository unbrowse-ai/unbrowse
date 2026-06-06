#!/usr/bin/env bash
# route-ranking-gate.sh — energy-based route ranking lifts top-1 retrieval over the
# keyword baseline. Secular entry point; runs the real witness.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../jespa/jespa-route-gate.sh" "$@"
