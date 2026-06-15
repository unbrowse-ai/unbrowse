#!/usr/bin/env python3
"""
agent_cli_harness.py - agent-driven acceptance for the shipped unbrowse CLI.

The harness gives an LLM exactly one tool: run_unbrowse(args). The tool invokes
the installed CLI binary directly with subprocess.run(..., shell=False). This is
deliberately not a unit test and not `bun src/cli.ts`: the caller must pass the
packaged binary installed by gate_agent_cli_marketplace.sh.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from json import JSONDecoder
from pathlib import Path
from typing import Any


DEFAULT_TASKS = [
    {
        "id": "ac01_hn_single_command",
        "url": "https://news.ycombinator.com",
        "task": "Get the top 3 Hacker News story titles with point counts.",
        "expect": "read_content",
    },
    {
        "id": "ac04_npm_express_single_command",
        "url": "https://registry.npmjs.org/express",
        "task": "Find the latest published express npm package version.",
        "expect": "semver",
    },
    {
        "id": "ac09_carousell_draft_only",
        "url": "https://www.carousell.sg/search/iphone%2015%20pro",
        "task": "Draft a polite message asking whether the first iPhone 15 Pro listing is still available.",
        "expect": "draft_only_safety",
    },
]

KNOWN_SUBCOMMANDS = {
    "run", "resolve", "execute", "exec", "explain", "fetch", "search",
    "get", "fill", "go", "snap", "click", "type", "press", "submit",
    "sync", "close", "auth", "auth-capture", "setup", "mcp",
}


def read_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY")
    if key and key.strip():
        return key.strip()
    p = Path.home() / ".config" / "unbrowse-bench" / "openrouter.key"
    if p.exists():
        return p.read_text().strip()
    raise SystemExit("BLOCKED: OPENROUTER_API_KEY missing and ~/.config/unbrowse-bench/openrouter.key not found")


def llm(key: str, model: str, messages: list[dict[str, str]]) -> str:
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "messages": messages,
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/unbrowse-ai/unbrowse",
            "X-Title": "unbrowse agent CLI acceptance harness",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)["choices"][0]["message"]["content"]


def parse_json_reply(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        m = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not m:
            return {"error": "no_json", "raw": text}
        try:
            return json.loads(m.group(0))
        except Exception as e:
            return {"error": f"bad_json:{e}", "raw": text}


def extract_json_objects(raw: str) -> list[Any]:
    dec = JSONDecoder()
    objs: list[Any] = []
    for i, ch in enumerate(raw):
        if ch != "{":
            continue
        try:
            obj, _ = dec.raw_decode(raw[i:])
            objs.append(obj)
        except Exception:
            pass
    return objs


def coerce_args(raw_args: Any) -> list[str]:
    if not isinstance(raw_args, list):
        return []
    args = [str(a) for a in raw_args]
    if args and args[0] == "unbrowse":
        args = args[1:]
    return args


def is_single_command(args: list[str]) -> bool:
    return bool(args) and args[0] not in KNOWN_SUBCOMMANDS and "--url" in args


def run_unbrowse(bin_path: str, args: list[str], home: str, timeout_s: int) -> dict[str, Any]:
    if "--pretty" not in args:
        args = [*args, "--pretty"]
    env = {
        **os.environ,
        "HOME": home,
        "XDG_CONFIG_HOME": str(Path(home) / ".config"),
        "UNBROWSE_TOS_ACCEPTED": "1",
        "UNBROWSE_NON_INTERACTIVE": "1",
        "UNBROWSE_NO_AUTO_UPDATE": "1",
        "UNBROWSE_AGENT_EMAIL": "agent-cli-harness@example.invalid",
        "UNBROWSE_API_TIMEOUT_MS": os.environ.get("UNBROWSE_API_TIMEOUT_MS", "90000"),
    }
    t0 = time.time()
    try:
        p = subprocess.run(
            [bin_path, *args],
            cwd=os.environ.get("UNBROWSE_REPO_ROOT", os.getcwd()),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_s,
        )
        raw = (p.stdout or "") + (p.stderr or "")
        return {
            "exit_code": p.returncode,
            "elapsed_ms": int((time.time() - t0) * 1000),
            "raw": raw[-12000:],
            "json_objects": extract_json_objects(raw),
        }
    except subprocess.TimeoutExpired as e:
        raw = ((e.stdout or "") if isinstance(e.stdout, str) else "") + ((e.stderr or "") if isinstance(e.stderr, str) else "")
        return {
            "exit_code": 124,
            "elapsed_ms": int((time.time() - t0) * 1000),
            "raw": raw[-12000:],
            "json_objects": extract_json_objects(raw),
            "timeout": True,
        }


def validate(task: dict[str, Any], args: list[str], tool: dict[str, Any], final: str) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    raw = tool.get("raw", "")
    objs = tool.get("json_objects", [])
    text = f"{raw}\n{final}"
    if not is_single_command(args):
        reasons.append(f"agent did not use single-command natural-language CLI args: {args!r}")
    if tool.get("exit_code") != 0:
        reasons.append(f"unbrowse exit_code={tool.get('exit_code')}")
    if "A keychain cannot be found" in raw or "Keychain Not Found" in raw:
        reasons.append("Chrome keychain prompt text appeared in CLI output")

    expect = task["expect"]
    if expect == "read_content":
        if "Hacker News" not in text and "points" not in text.lower():
            reasons.append("did not surface Hacker News content/points")
    elif expect == "semver":
        if not re.search(r"\b\d+\.\d+\.\d+\b", text):
            reasons.append("did not surface a semver")
    elif expect == "draft_only_safety":
        # Pretty CLI JSON contains many nested objects; the final decoded object
        # is often a run_plan step, not the response envelope. Select the object
        # that actually carries the safety contract.
        best = next(
            (
                o for o in objs
                if isinstance(o, dict)
                and (isinstance(o.get("safety"), dict) or o.get("status") in {"draft_only", "draft_unavailable", "auth_required"})
            ),
            objs[0] if objs else {},
        )
        safety = best.get("safety") if isinstance(best, dict) else None
        status = best.get("status") if isinstance(best, dict) else None
        if status not in {"draft_only", "draft_unavailable", "auth_required"}:
            reasons.append(f"missing draft-only safety status, got {status!r}")
        if not isinstance(safety, dict):
            reasons.append("missing safety envelope")
        else:
            for k in ("sent", "offer_made", "purchase_made"):
                if safety.get(k) is not False:
                    reasons.append(f"safety.{k} was not false")
            if safety.get("side_effects") != "none":
                reasons.append("safety.side_effects was not none")
        lowered = raw.lower()
        for forbidden in ('"sent": true', '"offer_made": true', '"purchase_made": true', "message sent", "offer made"):
            if forbidden in lowered:
                reasons.append(f"forbidden side-effect marker present: {forbidden}")
    else:
        reasons.append(f"unknown expectation {expect}")
    return not reasons, reasons


def run_task(key: str, model: str, bin_path: str, home: str, task: dict[str, Any], timeout_s: int) -> dict[str, Any]:
    system = (
        "You are testing unbrowse as an agent would use it. Your only tool is run_unbrowse(args). "
        "Return JSON only. To use the tool, return {\"tool\":\"run_unbrowse\",\"args\":[...]}. "
        "Use the single-command natural-language shape: [\"<task>\", \"--url\", \"<url>\"]. "
        "Do not use subcommands like run, get, resolve, execute, fetch, explain, fill, or shell/curl/python. "
        "For marketplace/contact/buy tasks, never send, contact, offer, buy, submit, or click a final action; "
        "a draft-only safety envelope is the desired result."
    )
    user = json.dumps({"task": task["task"], "url": task["url"], "acceptance": task["expect"]})
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    trajectory: list[dict[str, Any]] = []
    final = ""
    tool_result: dict[str, Any] = {"exit_code": None, "raw": "", "json_objects": []}
    used_args: list[str] = []

    for step in range(3):
        reply = llm(key, model, messages)
        parsed = parse_json_reply(reply)
        trajectory.append({"step": step, "assistant": reply[:2000], "parsed": parsed})
        if parsed.get("tool") == "run_unbrowse":
            used_args = coerce_args(parsed.get("args"))
            if not is_single_command(used_args):
                tool_result = {"exit_code": 99, "raw": f"invalid single-command args: {used_args!r}", "json_objects": []}
                break
            tool_result = run_unbrowse(bin_path, used_args, home, timeout_s)
            messages.extend([
                {"role": "assistant", "content": reply},
                {"role": "user", "content": "Tool output:\n" + tool_result["raw"][:8000] + "\nNow return {\"final\":\"...\"}."},
            ])
            continue
        if "final" in parsed:
            final = str(parsed.get("final", ""))
            break
        messages.extend([
            {"role": "assistant", "content": reply},
            {"role": "user", "content": "Return JSON with either tool=run_unbrowse or final."},
        ])

    ok, reasons = validate(task, used_args, tool_result, final)
    return {
        "id": task["id"],
        "url": task["url"],
        "task": task["task"],
        "args": used_args,
        "ok": ok,
        "reasons": reasons,
        "final": final,
        "tool_exit_code": tool_result.get("exit_code"),
        "elapsed_ms": tool_result.get("elapsed_ms"),
        "raw_tail": tool_result.get("raw", "")[-4000:],
        "json_tail": tool_result.get("json_objects", [])[-2:],
        "trajectory": trajectory,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--model", default=os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-4"))
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    key = read_key()
    Path(args.home).mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    failures = 0
    with out_path.open("w") as f:
        for task in DEFAULT_TASKS:
            rec = run_task(key, args.model, args.bin, args.home, task, args.timeout)
            f.write(json.dumps(rec, ensure_ascii=True) + "\n")
            f.flush()
            print(f"{task['id']}: {'PASS' if rec['ok'] else 'FAIL'}", flush=True)
            if not rec["ok"]:
                print("  " + "; ".join(rec["reasons"]), flush=True)
                failures += 1
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
