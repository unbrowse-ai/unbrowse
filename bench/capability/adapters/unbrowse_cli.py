#!/usr/bin/env python3
"""The ONLY module that talks to the preview/global Unbrowse CLI (ARCHITECTURE seam).

Shells the binary for `eval resolve`, `eval version`, `breath execute`; returns plain
data dicts with NO secret values (the secret-firmament: pointers/hashes only).

Replay mode (`--replay <fixture.jsonl>`) lets the harness run deterministically without a
live deploy. NOTE: the committed Reddit fixture is HAND-AUTHORED gold, NOT a live capture
(live resolve currently returns no_active_session); only gate rows stamped `source=live`
are real unbrowse scores. The default binary is the globally installed `unbrowse` (the
harness grades the SHIPPED artifact, not source).
"""
import argparse
import json
import os
import subprocess

UNBROWSE_BIN = os.environ.get("UNBROWSE_BIN", "unbrowse")


def _run(args, timeout=120):
    proc = subprocess.run([UNBROWSE_BIN, *args], capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def version():
    rc, out, err = _run(["eval", "version"])
    return {"rc": rc, "raw": out.strip()}


def resolve(intent, url=None, limit=10):
    """-> {id?, shortlist:[{endpoint_id, domain, title, rank, score}], raw_status}.

    Parses the resolve shortlist; tolerant of the verbose trace lines the CLI emits
    by scanning for the last JSON object in stdout.
    """
    args = ["eval", "resolve", intent]
    if url:
        args += ["--url", url]
    args += ["--limit", str(limit)]
    rc, out, err = _run(args)
    body = _find_result_body(out)  # the result-bearing JSON, NOT a trailing log line
    shortlist = []
    if isinstance(body, dict):
        raw_list = body.get("shortlist") or body.get("domain_results") or body.get("results") or []
        for i, e in enumerate(raw_list):
            if isinstance(e, dict):
                shortlist.append({
                    "endpoint_id": e.get("endpoint_id") or e.get("id") or e.get("cacheKey"),
                    "domain": e.get("domain"),
                    "title": e.get("title"),
                    "rank": i,
                    "score": e.get("score"),
                })
    return {"rc": rc, "shortlist": shortlist}


_RESULT_KEYS = ("shortlist", "domain_results", "global_results", "results", "error")


def _last_json(text):
    """Return the last parseable top-level JSON object/array in text, else None."""
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def _find_result_body(text):
    """Return the last parseable JSON dict that carries a result-bearing key —
    NOT a trailing log line. Falls back to _last_json so error envelopes (which
    carry the 'error' key) are still surfaced. Guards against verbose CLIs that
    emit info/trace JSON after the result."""
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and any(k in obj for k in _RESULT_KEYS):
            return obj
    return _last_json(text)


def replay(fixture_path):
    """Yield recorded resolve rows {id, shortlist} from a frozen fixture."""
    with open(fixture_path) as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["version", "resolve", "replay"])
    ap.add_argument("--intent")
    ap.add_argument("--url")
    ap.add_argument("--replay-file")
    args = ap.parse_args()
    if args.cmd == "version":
        print(json.dumps(version()))
    elif args.cmd == "resolve":
        print(json.dumps(resolve(args.intent, args.url)))
    elif args.cmd == "replay":
        for row in replay(args.replay_file):
            print(json.dumps(row))


if __name__ == "__main__":
    main()
