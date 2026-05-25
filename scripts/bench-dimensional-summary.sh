#!/usr/bin/env bash
#
# scripts/bench-dimensional-summary.sh
#
# Reads .bench-local/results.jsonl and harness/probes/corpus-dimensional.txt,
# joins each result with its declared dimension by URL, prints a per-axis
# pass-rate table.
#
# Substrate-faithful: emits evidence only. The agent reads the table and
# judges whether the deploy-gate STAGE-2-BENCH-100 is satisfied. The script
# never decides PASS/FAIL on its own.
#
# Pass-rate is computed across the seven axes (INDEX / AUTH / CSRF /
# SEARCH / RETR / EXEC / META). Lines marked `@class: antibot` are
# excluded from the dimensional totals (their failure mode is a
# capability gap, not a dimensional gap).
#
# Exit: 0 on successful summary print. Non-zero only on missing
# inputs (results.jsonl absent, corpus absent).

set -euo pipefail

cd "$(dirname "$0")/.."

CORPUS="${BENCH_DIMENSIONAL_CORPUS:-harness/probes/corpus-dimensional.txt}"
RESULTS="${BENCH_DIMENSIONAL_RESULTS:-.bench-local/results.jsonl}"

if [ ! -f "$CORPUS" ]; then
  echo "[bench-dimensional] corpus missing: $CORPUS" >&2
  echo "[bench-dimensional] declare a dimensional corpus before running" >&2
  exit 2
fi

if [ ! -f "$RESULTS" ]; then
  echo "[bench-dimensional] no bench results yet: $RESULTS" >&2
  echo "[bench-dimensional] run bash scripts/bench-local.sh first" >&2
  exit 2
fi

python3 - "$CORPUS" "$RESULTS" <<'PY'
import json
import sys

corpus_path = sys.argv[1]
results_path = sys.argv[2]

DIMS = ["INDEX", "AUTH", "CSRF", "SEARCH", "RETR", "EXEC", "META"]
dim_probes: dict[str, list[tuple[str, str]]] = {d: [] for d in DIMS}
url_to_dim: dict[str, str] = {}
antibot_urls: set[str] = set()
auth_gated_urls: set[str] = set()
class_tag: str | None = None

with open(corpus_path) as f:
    for raw in f:
        line = raw.rstrip("\n")
        if not line or line.startswith("#") and not line.startswith("@class"):
            continue
        if line.startswith("@class:"):
            class_tag = line.split(":", 1)[1].strip()
            continue
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        dim, intent, url = parts[0].strip(), parts[1].strip(), parts[2].strip()
        if dim not in DIMS:
            continue
        dim_probes[dim].append((intent, url))
        url_to_dim[url] = dim
        if class_tag == "antibot":
            antibot_urls.add(url)
        elif class_tag == "auth-gated":
            auth_gated_urls.add(url)
        class_tag = None

results_by_url: dict[str, dict] = {}
with open(results_path) as f:
    for raw in f:
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if "url" in row:
            results_by_url[row["url"]] = row

print("\n=== Dimensional bench summary ===")
print(f"corpus:  {corpus_path}")
print(f"results: {results_path} ({len(results_by_url)} rows)")
print()

total_pass = 0
total_judged = 0
total_unmeasured = 0
total_antibot = 0

print(f"{'AXIS':<8} {'PROBES':>7} {'MEASURED':>9} {'PASS':>5} {'FAIL':>5} {'PASS-RATE':>10}")
print("-" * 50)
for dim in DIMS:
    probes = dim_probes[dim]
    measured = 0
    passed = 0
    for _intent, url in probes:
        if url in antibot_urls or url in auth_gated_urls:
            continue
        row = results_by_url.get(url)
        if row is None:
            continue
        measured += 1
        verdict = row.get("verdict", "")
        # Strict PASS only — PASS_WEAK (structural-only, no real data) does not
        # count toward 100%. The "100% across dimensions" claim must mean the
        # agent actually got the data, not that resolve completed structurally.
        if verdict == "PASS":
            passed += 1
    failed = measured - passed
    rate = f"{(100 * passed / measured):>5.1f}%" if measured else "  n/a"
    print(f"{dim:<8} {len(probes):>7} {measured:>9} {passed:>5} {failed:>5} {rate:>10}")
    total_pass += passed
    total_judged += measured

ab_measured = 0
ab_passed = 0
for url in antibot_urls:
    row = results_by_url.get(url)
    if row is None:
        continue
    ab_measured += 1
    if row.get("verdict", "") == "PASS":
        ab_passed += 1
total_antibot = ab_measured

ag_measured = 0
ag_passed = 0
for url in auth_gated_urls:
    row = results_by_url.get(url)
    if row is None:
        continue
    ag_measured += 1
    if row.get("verdict", "") == "PASS":
        ag_passed += 1

excluded = antibot_urls | auth_gated_urls
unmeasured_urls = [url for url in url_to_dim if url not in results_by_url and url not in excluded]
total_unmeasured = len(unmeasured_urls)

print("-" * 50)
overall = f"{(100 * total_pass / total_judged):>5.1f}%" if total_judged else "  n/a"
print(f"{'TOTAL':<8} {sum(len(p) for p in dim_probes.values()):>7} {total_judged:>9} {total_pass:>5} {total_judged - total_pass:>5} {overall:>10}")
print()
print(f"antibot class:    {ab_passed}/{ab_measured} passed (excluded from dimensional totals)")
print(f"auth-gated class: {ag_passed}/{ag_measured} passed (excluded; reflects user-credential gap, not product capability)")
print(f"unmeasured rows:  {total_unmeasured} (probes in corpus but no result row yet)")
if total_unmeasured:
    print(f"  hint: run bash scripts/bench-local.sh --corpus-file {corpus_path}")

print()
print("agent: read the table; judge KEY 2 on whether the deploy gate's")
print("STAGE-2-BENCH-100 child is satisfied (100% across all 7 axes,")
print("antibot + auth-gated classes excluded but separately reported).")
PY

# Substrate-faithful exit. The agent renders the verdict.
exit 0
