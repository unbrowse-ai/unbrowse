#!/usr/bin/env python3
"""value_correctness.py — Axis E: does the published CLI return the RIGHT value, not just a
consistent one? Drives `$UNBROWSE_BIN get <intent> --url <url>` over a ground-truth corpus,
extracts the asserted json_path from the REAL returned payload, and compares to the immutable
expected value. Two-witness: each row is run TWICE (distinct invocations); a row PASSES only if
BOTH runs return the value AND it equals expected (correct AND reproducible).

This closes the blind spot in gate_all.sh, which proved reproducibility but not correctness.
Honest negatives are kept: a wrong value is recorded with intent/expected/got; a fetch failure is
BLOCKED (not PASS) — never a fabricated green. Grades the npm-shipped CLI via UNBROWSE_BIN.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UNBROWSE = os.environ.get("UNBROWSE_BIN", "unbrowse")
TIMEOUT = int(os.environ.get("CORRECTNESS_TIMEOUT", "120"))
CORPUS = Path(os.environ.get("CORRECTNESS_CORPUS", HERE / "corpus" / "correctness.jsonl"))


def _run_get(intent: str, url: str) -> tuple[str, bool]:
    try:
        p = subprocess.run([UNBROWSE, "get", intent, "--url", url],
                           capture_output=True, text=True, timeout=TIMEOUT)
        return p.stdout, p.returncode == 0
    except Exception as e:  # noqa: BLE001 — surface, never mask
        return f"__ERR__ {e}", False


def _extract_json(stdout: str) -> dict | None:
    """The `get` envelope JSON is emitted among human trace lines. Find the largest parseable
    top-level JSON object in stdout (the last/biggest brace-balanced span)."""
    best = None
    for m in re.finditer(r"\{", stdout):
        start = m.start()
        depth, in_str, esc = 0, False, False
        for i in range(start, len(stdout)):
            c = stdout[i]
            if in_str:
                if esc: esc = False
                elif c == "\\": esc = True
                elif c == '"': in_str = False
            else:
                if c == '"': in_str = True
                elif c == "{": depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        span = stdout[start:i+1]
                        try:
                            obj = json.loads(span)
                            if isinstance(obj, dict) and (best is None or len(span) > best[1]):
                                best = (obj, len(span))
                        except Exception:
                            pass
                        break
    return best[0] if best else None


def _payload(envelope: dict) -> dict | None:
    """The `get`/resolve envelope wraps the API payload under `result`; fetch returns it raw."""
    if not isinstance(envelope, dict):
        return None
    if isinstance(envelope.get("result"), dict):
        return envelope["result"]
    # raw payload (fetch-style) — use as-is if it doesn't look like a pure envelope
    return envelope


def _navigate(obj: object, path: str):
    cur = obj
    for key in path.split("."):
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return None
    return cur


def score_row(row: dict) -> dict:
    intent, url, jpath, expected = row["intent"], row["url"], row["json_path"], row["expected"]
    got_values = []
    for witness in range(2):
        val = None
        # up to 2 attempts per witness — a None is treated as a transient block
        # (e.g. unauth rate-limit 403/429) and retried once with backoff before we
        # record it as BLOCKED, so BLOCKED means genuinely unfetchable, not a blip.
        for attempt in range(2):
            stdout, ok = _run_get(intent, url)
            env = _extract_json(stdout) if ok else None
            payload = _payload(env) if env else None
            val = _navigate(payload, jpath) if payload is not None else None
            if val is not None:
                break
            time.sleep(2.0 * (attempt + 1))
        got_values.append(val)
        time.sleep(0.5)
    w0, w1 = got_values
    both_present = w0 is not None and w1 is not None
    reproducible = w0 == w1
    correct = both_present and reproducible and str(w0) == str(expected)
    verdict = "PASS" if correct else ("BLOCKED" if not both_present else "WRONG")
    return {"id": row["id"], "host": row.get("host"), "intent": intent, "expected": expected,
            "got": [w0, w1], "reproducible": reproducible, "correct": correct, "verdict": verdict}


def main() -> int:
    if not CORPUS.exists():
        print(f"FAIL: corpus missing {CORPUS}"); return 2
    rows = [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()]
    results = [score_row(r) for r in rows]
    n = len(results)
    npass = sum(1 for r in results if r["verdict"] == "PASS")
    nwrong = sum(1 for r in results if r["verdict"] == "WRONG")
    nblocked = sum(1 for r in results if r["verdict"] == "BLOCKED")
    scored = n - nblocked
    accuracy = (npass / scored) if scored else 0.0
    hosts = sorted({r["host"] for r in results if r["host"]})
    out = {"axis": "E_correctness", "ts": time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime()),
           "cli": subprocess.run([UNBROWSE, "--version"], capture_output=True, text=True).stdout.strip()[:40],
           "n": n, "scored": scored, "pass": npass, "wrong": nwrong, "blocked": nblocked,
           "accuracy": round(accuracy, 4), "hosts": hosts, "two_witness": True, "rows": results}
    print(json.dumps(out, indent=2))
    # honest negatives surfaced loudly
    for r in results:
        if r["verdict"] != "PASS":
            print(f"  ! {r['verdict']} {r['id']}: expected={r['expected']!r} got={r['got']!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
