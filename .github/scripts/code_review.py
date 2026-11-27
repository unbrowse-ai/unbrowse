#!/usr/bin/env python3
"""Turn one `opencode run` answer into a GitHub review, a check run, and the severity line other tools read.

The workflow (.github/workflows/opencode-review.yml) gives the agent a diff and the pull request's tree, and takes back
one JSON object. This reads that object, keeps only findings that land on a line the change actually touched (anything
else goes in the review body, never invented onto a line), and renders:

  review.json   the POST body for /pulls/<n>/reviews: the body and one inline comment per placed finding
  check.md      the check run's output text, its last line `<!-- bughunter-severity: {"nit":…,"normal":…,
                "pre_existing":…} -->` — Claude Ship's own line, so a script that gates on a Claude Code Review run reads
                ours unchanged
  findings.json the sanitised findings, uploaded as an artifact for PR Steward
  review.md     the review body alone, for the run's summary and a fallback comment

A review that could not be read is `ok=false` with the reason: the check says so and the run still passes, because a
review that failed is not a pull request that failed.

    code_review.py --events events.jsonl --diff review.diff --pr 12 --head <sha> --tree pr --out /tmp/review
"""
import argparse
import json
import os
import re
import sys

SEVERITIES = {"important": "normal", "normal": "normal", "nit": "nit", "pre-existing": "pre_existing", "pre_existing": "pre_existing"}
MARK = {"normal": "🔴 Important", "nit": "🟡 Nit", "pre_existing": "🟣 Pre-existing"}
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _events(lines):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def answer(events):
    """The agent's last message. Claude Code's stream (what agent_cli.py writes on either CLI): the last result event's
    text, or failing that the last assistant message's; a refused run (is_error) answers nothing. OpenCode's own
    events, from a run made before the switch: the text parts that share the last text part's messageID, in order."""
    events = list(events)
    results = [e for e in _events(events) if e.get("type") == "result"]
    if results:
        last = results[-1]
        return "" if last.get("is_error") else str(last.get("result") or "")
    said = []
    for e in _events(events):
        if e.get("type") == "assistant":
            text = "".join(c.get("text", "") for c in (e.get("message") or {}).get("content") or []
                           if isinstance(c, dict) and c.get("type") == "text")
            if text:
                said.append(text)
    if said:
        return said[-1]
    parts = []
    for event in _events(events):
        part = event.get("part") or {}
        if event.get("type") == "text" and part.get("text"):
            parts.append((part.get("messageID"), part["text"]))
    if not parts:
        return ""
    last = parts[-1][0]
    return "".join(text for message, text in parts if message == last)


def refusal(events):
    """What a run that ended in an error said: the reason a check shows instead of "the agent answered nothing"."""
    for e in reversed([e for e in _events(events) if e.get("type") == "result"]):
        if e.get("is_error"):
            return str(e.get("result") or e.get("subtype") or "the run ended in an error")
    return ""


def cost(events):
    """What the run was reported to cost, in dollars: Claude Code's result total, else OpenCode's steps added up."""
    events = list(events)
    for e in reversed([e for e in _events(events) if e.get("type") == "result"]):
        if isinstance(e.get("total_cost_usd"), (int, float)):
            return round(e["total_cost_usd"], 4)
    total = 0.0
    for event in _events(events):
        spent = (event.get("part") or {}).get("cost")
        if isinstance(spent, (int, float)):
            total += spent
    return round(total, 4)


def object_in(text):
    """The JSON object the answer holds, with or without a fence and with anything said around it."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("the answer holds no JSON object")
    return json.loads(text[start:end + 1])


def changed_lines(diff):
    """Every path the diff touches, and the lines of the new file a finding may sit on: `+` lines and context, not
    under a `-` line. A deleted file has no lines to put a comment on."""
    paths, lines, path, new = {}, {}, None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            name = raw[4:].strip()
            path = None if name == "/dev/null" else re.sub(r"^b/", "", name)
            if path:
                paths.setdefault(path, set())
                lines.setdefault(path, set())
            continue
        hunk = HUNK.match(raw)
        if hunk:
            new = int(hunk.group(1))
            continue
        if path is None:
            continue
        if raw.startswith("+"):
            paths[path].add(new)
            lines[path].add(new)
            new += 1
        elif raw.startswith(" "):
            lines[path].add(new)
            new += 1
    return paths, lines


def place(finding, paths, lines, tree):
    """Where the finding goes: an inline line the change touched, the file on its own, or the body only."""
    path = str(finding.get("path") or "").strip().lstrip("./")
    path = re.sub(r"^(?:pr/)+", "", path)
    severity = SEVERITIES.get(str(finding.get("severity") or "").strip().lower())
    if not severity:
        return None, path, None, None, f"severity {finding.get('severity')!r} is not one of Important, Nit, Pre-existing"
    number = finding.get("line")
    try:
        number = int(number) if number is not None else None
    except (TypeError, ValueError):
        number = None
    if path not in paths:
        return ("body", path, number, severity, "not a file this change touches")
    if number is not None and number in lines.get(path, set()):
        return ("inline", path, number, severity, None)
    return ("file", path, number, severity, None)


def render(head, findings, unplaced, summary, note):
    order = {"normal": 0, "nit": 1, "pre_existing": 2}
    findings = sorted(findings, key=lambda f: (order[f["severity"]], f["path"], f.get("line") or 0))
    counts = {k: sum(1 for f in findings if f["severity"] == k) for k in ("normal", "nit", "pre_existing")}
    rows = "".join(
        f"| {MARK[f['severity']]} | `{f['path']}:{f.get('line') or '—'}` | {f['title']} |\n" for f in findings
    )
    body = [f"### Code review of {head[:12]}", ""]
    body.append((summary or "").strip() or "No summary was given.")
    body.append("")
    if findings:
        body += ["| Severity | File:Line | Finding |", "| - | - | - |", rows.rstrip("\n"), ""]
    else:
        body += ["No findings.", ""]
    if unplaced:
        body += ["**Left out of the line comments**:", ""]
        body += ["".join(f"- {why}: `{path}:{number or '—'}` — {title}\n" for why, path, number, title in unplaced)]
        body.append("")
    if note:
        body += [f"> {note}", ""]
    body += [
        "Claude Ship's severities: 🔴 fixed before merging · 🟡 worth fixing · 🟣 already in the code, not added here. "
        "A review never approves, blocks or merges: the merge follows the branch rules.",
    ]
    comments = []
    for f in findings:
        if f["where"] != "inline":
            continue
        why = (f.get("why") or "").strip()
        tail = f"\n\n<details><summary>Why this was flagged</summary>\n\n{why}\n\n</details>" if why else ""
        comments.append({
            "path": f["path"], "line": f["line"], "side": "RIGHT",
            "body": f"**{MARK[f['severity']]}** — {f['title']}\n\n{f.get('body') or ''}{tail}",
        })
    check_rows = rows or "| — | — | No findings. |\n"
    check = (
        f"| Severity | File:Line | Issue |\n| - | - | - |\n{check_rows}\n"
        f"<!-- bughunter-severity: {json.dumps(counts)} -->\n"
    )
    return body, comments, check, counts


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--events", required=True)
    p.add_argument("--diff", required=True)
    p.add_argument("--pr", required=True, type=int)
    p.add_argument("--head", required=True)
    p.add_argument("--tree", default="pr")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    with open(a.diff, encoding="utf-8", errors="replace") as f:
        diff = f.read()
    with open(a.events, encoding="utf-8", errors="replace") as f:
        events = f.readlines()
    os.makedirs(a.out, exist_ok=True)

    result = {"ok": False, "why": "", "counts": {"normal": 0, "nit": 0, "pre_existing": 0}}
    text = answer(events)
    if not text.strip():
        result["why"] = f"the model refused: {refusal(events)}" if refusal(events) else "the agent answered nothing"
    else:
        try:
            said = object_in(text)
            paths, lines = changed_lines(diff)
            findings, unplaced = [], []
            for raw in said.get("findings") or []:
                where, path, number, severity, why = place(raw, paths, lines, a.tree)
                if where is None:
                    unplaced.append((why, str(raw.get("path") or ""), raw.get("line"), str(raw.get("title") or "")[:80]))
                    continue
                findings.append({
                    "where": where, "path": path, "line": number, "severity": severity,
                    "title": str(raw.get("title") or "Untitled finding").strip(),
                    "body": str(raw.get("body") or "").strip(),
                    "why": str(raw.get("why") or "").strip(),
                })
            body, comments, check, counts = render(a.head, findings, unplaced, said.get("summary"), "")
            payload = {"commit_id": a.head, "body": "\n".join(body), "event": "COMMENT", "comments": comments}
            with open(os.path.join(a.out, "review.json"), "w") as f:
                json.dump(payload, f, indent=2)
            with open(os.path.join(a.out, "review.md"), "w") as f:
                f.write("\n".join(body) + "\n")
            with open(os.path.join(a.out, "check.md"), "w") as f:
                f.write(check)
            with open(os.path.join(a.out, "findings.json"), "w") as f:
                json.dump({"pr": a.pr, "head": a.head, "summary": said.get("summary") or "",
                           "findings": findings, "counts": counts}, f, indent=2)
            result.update({"ok": True, "counts": counts})
        except (ValueError, json.JSONDecodeError) as e:
            result["why"] = f"the answer was not the JSON object asked for: {e}"

    if not result["ok"]:
        note = f"The review could not be read ({result['why']}). The agent's answer is in the run's log."
        body = [f"### Code review of {a.head[:12]}", "", f"> {note}", ""]
        with open(os.path.join(a.out, "review.md"), "w") as f:
            f.write("\n".join(body) + "\n")
        with open(os.path.join(a.out, "review.json"), "w") as f:
            json.dump({"commit_id": a.head, "body": "\n".join(body), "event": "COMMENT", "comments": []}, f, indent=2)
        with open(os.path.join(a.out, "check.md"), "w") as f:
            f.write(f"{note}\n")
        with open(os.path.join(a.out, "findings.json"), "w") as f:
            json.dump({"pr": a.pr, "head": a.head, "summary": "", "findings": [], "counts": result["counts"], "error": result["why"]}, f, indent=2)

    result["cost"] = cost(events)
    print(f"CODE_REVIEW {json.dumps(result)}")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
        f.write(f"ok={'true' if result['ok'] else 'false'}\n")
        f.write(f"important={result['counts']['normal']}\n")
        f.write(f"cost={result['cost']}\n")
        if not result["ok"]:
            f.write("why=" + result["why"].replace("\n", " ")[:200] + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
