#!/usr/bin/env bash
# intent-type-gate.sh — energy ranker classifies access-pattern type ~2x over baseline.
# Secular entry point; runs the real witness.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../jespa/intent-type-gate.sh" "$@"
