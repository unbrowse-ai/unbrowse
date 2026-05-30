#!/usr/bin/env bash
# outline-gate.sh — a falsifiable sign that the Paper 3 outline is internally honest.
#
# Three checks, all runnable:
#   A. No fabricated-green sentinels (TODO/FIXME/XXX/TKTK/lorem).
#   B. Every declared citation key (ostrom, pigou, samuelson, sybil, casper)
#      also appears in the §-tree body — i.e. it occurs >=2 times (table + section),
#      so there are no orphan citations.
#   C. No moat-leak terms (engine internals / economic constants).
#
# Exit 0 on all-pass, 1 on any fail. Edit the outline to fix a real failure,
# never edit this gate to force a pass.

set -uo pipefail

# Repo root = dir two levels up from this script (paper/scripts/ -> repo).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTLINE="${REPO_ROOT}/paper/maintenance-network.OUTLINE.md"

fail=0

echo "outline-gate: target = ${OUTLINE}"

if [[ ! -f "${OUTLINE}" ]]; then
  echo "FAIL: outline file not found: ${OUTLINE}"
  echo "================================"
  echo "SUMMARY: FAIL — outline file missing"
  exit 1
fi

# ---- CHECK A: no fabricated-green sentinels ---------------------------------
echo
echo "[CHECK A] no fabricated-green sentinels (TODO/FIXME/XXX/TKTK/lorem)"
sentinel_hits="$(grep -nE 'TODO|FIXME|XXX|TKTK|lorem' "${OUTLINE}" || true)"
if [[ -n "${sentinel_hits}" ]]; then
  echo "  FAIL: sentinel string(s) present:"
  echo "${sentinel_hits}" | sed 's/^/    /'
  fail=1
else
  echo "  PASS: none present"
fi

# ---- CHECK B: no orphan citations ------------------------------------------
echo
echo "[CHECK B] every declared citation key also appears in the section body (>=2 occurrences)"
keys=(ostrom pigou samuelson sybil casper)
for key in "${keys[@]}"; do
  count="$(grep -oF "${key}" "${OUTLINE}" | wc -l | tr -d '[:space:]')"
  if [[ "${count}" -ge 2 ]]; then
    echo "  PASS: ${key} (${count} occurrences)"
  else
    echo "  FAIL: ${key} appears only ${count} time(s) — orphan citation (declared but not used in a section)"
    fail=1
  fi
done

# ---- CHECK C: no moat leak --------------------------------------------------
echo
echo "[CHECK C] no moat-leak terms"
leak_terms=(DELTA_DECAY_RATE BASE_FEE_UC FLEX_SPONSOR revealed_context \
  diffusion_populate ebm_route energy_score COVENANT_SUBSTRATE_MAP \
  coverage-harness dogfood-loop primitive-registry)
leak_found=0
for term in "${leak_terms[@]}"; do
  hits="$(grep -nF "${term}" "${OUTLINE}" || true)"
  if [[ -n "${hits}" ]]; then
    echo "  FAIL: leak term '${term}' present:"
    echo "${hits}" | sed 's/^/    /'
    leak_found=1
    fail=1
  fi
done
if [[ "${leak_found}" -eq 0 ]]; then
  echo "  PASS: no leak terms present"
fi

# ---- SUMMARY ----------------------------------------------------------------
echo
echo "================================"
if [[ "${fail}" -eq 0 ]]; then
  echo "SUMMARY: PASS — outline is internally honest (A, B, C all green)"
  exit 0
else
  echo "SUMMARY: FAIL — one or more checks failed (see above)"
  exit 1
fi
