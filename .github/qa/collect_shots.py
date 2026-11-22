#!/usr/bin/env python3
"""A picture of every check the agent QA ran (UNB-235), after the agent is done, holding no credential.

The checklist asks the agent to take a screenshot through the node after each check and to name, in qa-verdict.json,
the check's `url` and the `shot` the node's reply gave. For each check, in this order:
1. the agent's own screenshot: <shots>/check-NN.png already there (the QA job copies it out under the check's number),
   or a PNG at `shot`, read only from the shots folder, the node's home or the temp folders (never anywhere else);
2. else the check's `url`, opened straight in Chrome for Testing on a profile of its own (nothing signed in);
3. else the check's result and note, drawn.
Each lands in <shots>/check-NN.png, and the report says which of the three it is. A verdict with no checks fails.

    python3 .github/qa/collect_shots.py --verdict qa-verdict.json --shots qa-shots --chrome <path> [--allow <dir> ...]

Writes <shots>/shots.json and <shots>/shots.md.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

# The report job runs this with `python3 -I`, which leaves the script's own folder off the import path: put it back
# (only this trusted checkout's .github/qa), or the import below fails and no check gets a picture (UNB-235).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_check import chrome_shot, draw_card, is_png  # noqa: E402


def allowed(path, roots):
    try:
        real = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    return any(real.is_relative_to(r.resolve()) for r in roots if r)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verdict", type=Path, required=True)
    parser.add_argument("--shots", type=Path, required=True)
    parser.add_argument("--chrome", default="")
    parser.add_argument("--allow", type=Path, action="append", default=[])
    args = parser.parse_args(argv)
    args.shots.mkdir(parents=True, exist_ok=True)
    try:
        checks = json.loads(args.verdict.read_text()).get("checks") or []
    except (OSError, ValueError) as e:
        checks, why = [], str(e)
    else:
        why = "the verdict lists no checks"
    roots = [args.shots, *args.allow, Path(tempfile.gettempdir()), Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir()))]
    rows = []
    for c in checks:
        n = int(c.get("n") or len(rows) + 1)
        target = args.shots / f"check-{n:02d}.png"
        source = None
        shot = str(c.get("shot") or "")
        if is_png(target):
            source = "the agent's screenshot, through the node"  # taken out of the agent's job under its number
        elif shot and allowed(shot, roots) and is_png(Path(shot)):
            if Path(shot).resolve() != target.resolve():
                shutil.copyfile(shot, target)
            source = "the agent's screenshot, through the node"
        elif chrome_shot(args.chrome, str(c.get("url") or ""), target, args.shots / ".profile"):
            source = "the check's page, straight in Chrome"
        elif chrome_shot(args.chrome, draw_card(args.shots / f".{n:02d}.html", f"check {n}: {c.get('result', '?')}", "", c.get("note", "")), target, args.shots / ".profile"):
            source = "the check's result, drawn"
        rows.append({"n": n, "result": c.get("result"), "shot": target.name if source else None, "source": source})
    shutil.rmtree(args.shots / ".profile", ignore_errors=True)
    for card in args.shots.glob(".*.html"):
        card.unlink()
    ok = bool(rows) and all(r["shot"] for r in rows)
    lines = [f"**Screenshots: {sum(bool(r['shot']) for r in rows)} of {len(rows)} checks pictured.**" + ("" if rows else f" {why}."), "",
             "| Check | Result | Picture | From |", "| --- | --- | --- | --- |"]  # fmt: skip
    lines += [f"| {r['n']} | {r['result']} | {r['shot'] or '**none**'} | {r['source'] or ''} |" for r in rows]
    (args.shots / "shots.json").write_text(json.dumps({"pass": ok, "checks": rows}, indent=2) + "\n")
    (args.shots / "shots.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
