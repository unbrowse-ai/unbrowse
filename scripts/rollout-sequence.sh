#!/usr/bin/env bash
# rollout-sequence.sh — the public rollout, sequenced by its blockers.
#
# The plan, in order (each stage triggers only when its blocker clears):
#   Stage 1  public basic auth for the internet  -> ship now, beat the benchmarks
#   Stage 2  Paper 2: "Internal APIs Were Not All You Needed"  -> AFTER sign-off
#   Stage 3  Paper 3: token distribution / maintenance network -> AFTER stage 2
#
# Routing: PRIVATE artifacts -> the private Gitea; PUBLIC artifacts -> the public
# Gitea. The actual push/publish is the credentialed trigger (held for a human);
# this orchestrator reports which stage is unblocked and the exact trigger.
#
#   bash scripts/rollout-sequence.sh            # show the sequenced status
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

stage() { printf '\n── Stage %s: %s\n' "$1" "$2"; }
ok()    { printf '   [UNBLOCKED] %s\n' "$1"; }
blocked(){ printf '   [BLOCKED ] %s\n' "$1"; }

echo "ROLLOUT SEQUENCE — public releases in blocker order (private->private Gitea, public->public Gitea)"

# --- Stage 1: public basic auth for the internet -----------------------------
stage 1 "Public basic auth for the internet (beat benchmarks)"
if bash scripts/github-public-gate.sh >/dev/null 2>&1; then
  ok "the public packages are MIT + point at the unbrowse-ai org (open surface ready)"
  echo "   target : PUBLIC Gitea  ·  trigger: bash scripts/publish-dropins.sh + publish-python.sh"
  echo "   blocker: publish credentials only (npm/PyPI login) — not the whitepaper"
else
  blocked "public packages not yet org-clean — run scripts/github-public-gate.sh"
fi

# --- Stage 2: Paper 2 (the named blocker) ------------------------------------
stage 2 "Paper 2 — Internal APIs Were Not All You Needed"
if bash scripts/whitepaper-signoff-gate.sh >/dev/null 2>&1; then
  ok "Paper 2 finished AND signed off (Kevin or Rach Pradhan) — may ship"
  echo "   target : PUBLIC Gitea  ·  trigger: push paper/internal-apis.{tex,pdf} + reference/ to the public repo"
else
  blocked "Paper 2 NOT yet signed off — THIS IS THE CURRENT BLOCKER"
  echo "   needs  : Kevin or Rach Pradhan to sign paper/SIGNOFF.md (then this clears)"
  echo "   verify : bash scripts/whitepaper-signoff-gate.sh"
fi

# --- Stage 3: Paper 3 --------------------------------------------------------
stage 3 "Paper 3 — token distribution / maintenance network"
if bash scripts/whitepaper-signoff-gate.sh >/dev/null 2>&1; then
  ok "stage 2 cleared — Paper 3 may follow (its own sign-off sheet applies when added)"
else
  blocked "waits on Stage 2 (Paper 2 sign-off) first"
fi

echo
echo "Gitea routing: private dev tree -> private Gitea (lekt8/unbrowse); open SDKs/adapters + signed papers -> public Gitea."
echo "Current blocker: Stage 2 — the whitepaper sign-off by Kevin or Rach Pradhan."
