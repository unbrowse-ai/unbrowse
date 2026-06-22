#!/usr/bin/env bash
# aiko-outline-gate.sh — falsifiable witness for the two published Aiko Outline docs.
# Exits 0 ONLY when both docs are LIVE in the Foundry Outline KB, in the Pitch &
# Positioning collection, carry their required strings, and cross-link correctly.
# Reads each doc back via documents.info — a created-doc witness, not a claimed one.
set -uo pipefail

TOKEN=$(cat ~/.config/outline/token 2>/dev/null)
BASE=$(cat ~/.config/outline/baseurl 2>/dev/null)
COLL="79c0241c-51e4-40b9-ac1e-153660609b4b"
DOCA="da359176-91e0-4254-99fa-c21c05104ab6"
DOCB="83712bd3-1b14-49f2-8d0f-ee3db9be2183"
BRIEF_URL="/doc/aiko-positioning-pitch-CcAfLPGand"
DOCA_URL="/doc/aiko-messaging-voice-shipped-strings-source-of-truth-jMbtgB6gyb"
DOCB_URL="/doc/aiko-early-bird-launch-offer-waitlist-pricing-k3Aw0wmeSD"
[ -z "$TOKEN" ] && { echo "NO TOKEN"; exit 1; }

fail=0
info() { curl -s -X POST "$BASE/api/documents.info" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"id\":\"$1\"}"; }

check_doc() { # id  collection-expected  link-expected  required-substrings...
  local id="$1" linkexp="$2"; shift 2
  local json text title coll pub
  json="$(info "$id")"
  text="$(printf '%s' "$json" | python3 -c "import sys,json;print(json.load(sys.stdin,strict=False)['data']['text'])" 2>/dev/null)"
  title="$(printf '%s' "$json" | python3 -c "import sys,json;print(json.load(sys.stdin,strict=False)['data'].get('title',''))" 2>/dev/null)"
  coll="$(printf '%s' "$json" | python3 -c "import sys,json;print(json.load(sys.stdin,strict=False)['data'].get('collectionId',''))" 2>/dev/null)"
  pub="$(printf '%s' "$json" | python3 -c "import sys,json;print(bool(json.load(sys.stdin,strict=False)['data'].get('publishedAt')))" 2>/dev/null)"
  echo "  doc $id — \"$title\""
  [ -n "$text" ] || { echo "    MISS: no body (doc unreadable)"; fail=1; return; }
  [ "$coll" = "$COLL" ] || { echo "    MISS: wrong collection ($coll)"; fail=1; }
  [ "$pub" = "True" ] || { echo "    MISS: not published"; fail=1; }
  case "$text" in *"$linkexp"*) ;; *) echo "    MISS: cross-link absent: $linkexp"; fail=1;; esac
  for s in "$@"; do case "$text" in *"$s"*) ;; *) echo "    MISS: substring: $s"; fail=1;; esac; done
}

echo "== DOC A — Messaging & Voice =="
check_doc "$DOCA" "$DOCB_URL" "She already knows how" "Aiko is the context" "Banned outward" "Swap test" "$BRIEF_URL"
echo "== DOC B — Early-Bird Launch Offer =="
check_doc "$DOCB" "$DOCA_URL" '$200' '$100' "50%" "www.unbrowse.ai/aiko" "Subscribe early" "$BRIEF_URL"

if [ "$fail" -eq 0 ]; then
  echo "GATE: PASS — both Aiko docs live, collection-correct, published, cross-linked, strings present."
  exit 0
fi
echo "GATE: FAIL"; exit 1
