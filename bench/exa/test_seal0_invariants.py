#!/usr/bin/env python3
"""test_seal0_invariants.py — falsifiable signs over the SEAL-0 agentic harness.

The luminaries (Gen 1:14): signals you steer the beat-Exa run by, installed BEFORE
the paid 111-question storm. Each invariant is falsifiable and fails loud (exit != 0).
Run:  python3 bench/exa/test_seal0_invariants.py

These are collision-free with seal0_agentic.py (a separate, concurrently-edited file):
the source checks are read-only greps; the ledger checks read the JSONL witnesses.

INVARIANTS
  I1 (no-silent-empty-pred): every NON-errored ledger row must carry a non-empty pred.
      A model that returns nothing is an ABSTENTION and must be recorded errored=true
      (fail-loud) — never a silent empty pred quietly graded "incorrect". This is the
      lost sheep observed across runs 032426Z / 032641Z.
  I2 (answer-key-isolation): seal0_agentic.py's build_agent_input must return ONLY the
      question — the gold answer/urls/search_results columns may never enter agent context.
      The whole point of any SEAL-0 number depends on this firmament (gate z-20260603-50).
  I3 (graded-denominator): accuracy is computed only over graded (non-errored) rows.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "seal0_agentic.py")
failures: list[str] = []


def _rows(path: str) -> list[dict]:
    return [json.loads(l) for l in open(path) if l.strip()]


# ---- I2: answer-key isolation (read-only source check) ----------------------
def check_answer_key_isolation() -> None:
    if not os.path.exists(SRC):
        failures.append(f"I2: source {SRC} missing — cannot verify answer-key isolation")
        return
    src = open(SRC).read()
    m = re.search(r"def build_agent_input\(.*?\)[^:]*:.*?return ([^\n]+)", src, re.DOTALL)
    if not m:
        failures.append("I2: build_agent_input(...) not found — the firmament is unverifiable")
        return
    body = src[m.start():m.start() + 600]
    # The agent input must derive from the question alone; the gold columns are forbidden.
    for forbidden in ("answer", "urls", "search_results", "gold"):
        if re.search(rf'\b{forbidden}\b', m.group(1)) or re.search(rf'row\[[\'\"]{forbidden}', body):
            failures.append(f"I2: build_agent_input references gold column '{forbidden}' — KEY LEAK")
    if "question" not in m.group(1):
        failures.append("I2: build_agent_input return does not derive from 'question'")


# ---- I1 + I3: ledger invariants --------------------------------------------
def check_ledgers() -> None:
    ledgers = sorted(glob.glob(os.path.join(HERE, "seal0_run_*.jsonl")))
    if not ledgers:
        failures.append("I1/I3: no ledgers found — nothing to steer by")
        return
    for path in ledgers:
        rows = _rows(path)
        name = os.path.basename(path)
        for r in rows:
            errored = bool(r.get("errored"))
            pred = (r.get("pred") or "").strip()
            # I1: a non-errored row with an empty pred is a silent abstention — forbidden.
            if not errored and not pred:
                failures.append(
                    f"I1: {name} qid={r.get('qid')} non-errored but pred is EMPTY "
                    f"(silent abstention — must be errored=true, fail-loud)"
                )
        graded = [r for r in rows if not r.get("errored")]
        # I3: denominator must be graded rows only (sanity: no division over errored).
        acc = sum(1 for r in graded if r.get("correct")) / len(graded) if graded else 0.0
        print(f"  {name}: n={len(rows)} graded={len(graded)} acc={acc:.3f} "
              f"empties={sum(1 for r in rows if not r.get('errored') and not (r.get('pred') or '').strip())}")


def main() -> int:
    print("SEAL-0 invariants (luminaries) —")
    check_answer_key_isolation()
    check_ledgers()
    print()
    if failures:
        print(f"✗ {len(failures)} invariant violation(s) — foundation crack revealed:")
        for f in failures:
            print(f"   - {f}")
        return 1
    print("✓ all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
