#!/usr/bin/env bash
# Falsifier for W-NOISE-FILTER-CONTROLLER-RESOURCES: NOISE_PATHS in
# src/ranking/filters/noise-patterns.ts must drop URLs whose path
# segment is `controller-resources`. These are JS module-loader
# bootstraps (Slack canvas pattern, observed on probe 042) that the
# capture pipeline incorrectly surfaced as a data endpoint.
#
# Live regression source: .bench-gate/20260520T025154Z probe 042
# (app.slack.com/client) - INDEX_FAIL_WRONG_SHAPE because the only
# captured operation was
# https://uprockhq.slack.com/canvas/collab/controller-resources?...
# returning module_loader_url + import_map JSON, not channel messages.
#
# Structural assertion: NOISE_PATHS regex source contains
# `controller-resources` as a token.
set -uo pipefail
PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

if zigrep "controller-resources" src/ranking/filters/noise-patterns.ts >/dev/null 2>&1; then
  ok "noise-paths-includes-controller-resources"
else
  err "noise-paths-includes-controller-resources" "NOISE_PATHS missing controller-resources token; W-NOISE-FILTER-CONTROLLER-RESOURCES not wired"
fi
log "PASS=$PASS FAIL=$FAIL"
exit $((FAIL > 0 ? 1 : 0))
