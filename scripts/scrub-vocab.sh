#!/usr/bin/env bash
# scrub-vocab.sh <dir> — translate internal method vocabulary out of a tree.
#
# The single source of truth for the public-surface jargon guardrail: rename
# internal-vocab file/dir names, then translate the contents to plain secular
# engineering language. Used by full-client-public-sync.sh (the audit mirror) AND
# build-runtime-scrubbed.sh (the readable npm runtime) so BOTH come from one clean
# source. Idempotent. Purges build output first so embedded pre-scrub source can't
# re-leak. Witness: scripts/public-tree-leak-gate.sh + scripts/backlog/pubrepo-vocab-gate.sh.
set -uo pipefail
DST="${1:?usage: scrub-vocab.sh <dir>}"
[ -d "$DST" ] || { echo "scrub-vocab: no such dir: $DST" >&2; exit 1; }

# ── purge built artifacts that embed pre-scrub source ──
rm -rf "$DST/packages/skill/runtime" "$DST/packages/skill/dist-sm" "$DST/packages/skill/dist" \
       "$DST/packages/codedb.snapshot" 2>/dev/null
find "$DST" -type f \( -name '*.map' -o -name '*.snapshot' -o -name '*.min.js' -o -name '*.tsbuildinfo' \) \
  -not -path '*/node_modules/*' -delete 2>/dev/null
find "$DST/packages" -type d -name runtime -not -path '*/node_modules/*' -exec rm -rf {} + 2>/dev/null

# ── rename files/dirs whose NAMES carry internal vocabulary ──
find "$DST" -depth -type d \( -name breath -o -name superpattern \) -not -path '*/node_modules/*' 2>/dev/null | while read -r d; do
  nn="$(echo "$d" | sed 's/breath$/act/; s/superpattern$/architecture/')"
  [ "$d" != "$nn" ] && mv "$d" "$nn"
done
find "$DST" -type f -not -path '*/node_modules/*' \( -iname '*covenant*' -o -iname '*breath*' \) 2>/dev/null | while read -r f; do
  b="$(basename "$f")"; nb="$(echo "$b" \
    | sed -E 's/covenant-mapping/verb-mapping/; s/covenant-seed/route-seed/; s/covenant-toll/route-toll/; s/covenant/route/g; s/_breath-audit/_act-audit/; s/-breath-/-act-/g; s/breath-/act-/g; s/breath/act/g')"
  [ "$b" != "$nb" ] && mv "$f" "$(dirname "$f")/$nb"
done
find "$DST" -type f -name 'covenant.ts' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  mv "$f" "$(dirname "$f")/route.ts"
done

# ── translate internal vocabulary out of every text file ──
find "$DST" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.py' -o -name '*.md' -o -name '*.json' -o -name '*.sh' -o -name '*.txt' -o -name '*.yml' -o -name '*.yaml' -o -name 'setup' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 2>/dev/null | while IFS= read -r -d '' f; do
  perl -0pi -e '
    s/COVENANT_SUBSTRATE_MAP/ROUTE_MAP/g; s/COVENANT_MAP/ROUTE_MAP/g;
    s/CovenantVerb/Verb/g;
    s{cli-v7/breath}{cli-v7/act}g; s/_breath-audit/_act-audit/g;
    s/covenant-mapping/verb-mapping/g; s/covenant-seed/route-seed/g;
    s/covenant-toll-emit/route-toll-emit/g; s/covenant-toll-ledger/route-toll-ledger/g;
    s{lib/covenant}{lib/route}g;
    s{superpattern/}{architecture/}g; s/Superpattern/Architecture/g; s/superpattern/architecture/g;
    s/COVENANT/ROUTE/g; s/Covenant/Route/g; s/covenant/route/g;
    s/jesus[- ]?pattern/the method/gi; s/jesus/restricted/gi;
    s{build \(commit\) / breath \(act\) / eval \(observe\)}{create / act / read}g;
    s/\bthe cross\b/the root signature/gi;
    s/breath[- ]?eval/act-read/gi; s/\bbreath\b/act/g;
    s/firmaments?/boundary/gi; s{grain[- ]of[- ]wheat}{seed}gi; s/\bsabbath\b/rest/gi;
    s/at the mouth of (two|three)/corroborated by $1/gi; s/vine doctrine/maintenance-stake model/gi;
    s{\.claude[/A-Za-z0-9_.\-]*}{(internal)}g;
    s/revealed_context/context_fetch/g; s/diffusion_populate/route_populate/g;
    s/ebm_route/route_rank/g; s/ebm_train/rank_train/g; s/ebm_loop/rank_loop/g;
    s/energy_score/rank_score/g; s/canon_witness/route_witness/g;
    s/rules_for_identity/identity_rules/g; s/establishment_query/discovery_query/g; s/recall_episode/recall_route/g;
    # identifier-safe single tokens (these appear in TYPE names + identifiers, not just prose,
    # so a multi-word replacement would inject a space and break the code that must compile)
    s/zero[- ]?knowledge/commitmentBound/gi; s/zk[- ]?proof/commitmentProof/gi;
    s/nullifier/commitmentTag/gi; s/privacy[- ]?ip/private/gi;
    s/\bthe substrate\b/the platform/gi; s/\bsubstrate\b/platform/gi;
    s/\babiding\b/staking/gi; s/\babide\b/stake/gi;
    s{~?/?Projects/fdry[A-Za-z0-9_./\-]*}{(internal)}g;
    s/\bBpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1\b/(vault address withheld)/g;
    s/\s*\((?:Deut(?:eronomy)?|John|Matt(?:hew)?|Luke|Gen(?:esis)?|Heb(?:rews)?|[12] ?Cor(?:inthians)?|[12] ?Tim(?:othy)?|Mark|Phil(?:ippians)?|Prov(?:erbs)?|Rom(?:ans)?|Ps(?:alms?|alm)?|Isa(?:iah)?|Rev(?:elation)?|[12] ?Thess(?:alonians)?)\.?\s+\d+:\d+(?:[-\x{2013}]\d+)?[^)]*\)//gi;
    s/\b(?:Deut(?:eronomy)?|John|Matt(?:hew)?|Luke|Gen(?:esis)?|Heb(?:rews)?|[12] ?Cor(?:inthians)?|[12] ?Tim(?:othy)?|Mark|Prov(?:erbs)?|Phil(?:ippians)?|Rom(?:ans)?|Ps(?:alms?|alm)?|Isa(?:iah)?|Rev(?:elation)?|[12] ?Thess(?:alonians)?)\.?\s+\d+:\d+(?:[-\x{2013}]\d+)?\b//g;
  ' "$f"
done
