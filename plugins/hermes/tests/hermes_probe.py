"""Run inside a real Hermes interpreter with an isolated HERMES_HOME: load plugins through Hermes' own
plugin manager, then dispatch tool calls through ``model_tools.handle_function_call``.

Usage: python hermes_probe.py '<json>'  where json = {"calls": [{"tool": str, "args": dict, "retry_capacity": int}]}
Prints one JSON object on the last stdout line. Never prints environment values.
"""

from __future__ import annotations

import json
import os
import sys
import time


def main() -> None:
    spec = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    home = os.environ.get("HERMES_HOME", "")
    if not home or os.path.realpath(home) == os.path.realpath(os.path.expanduser("~/.hermes")):
        raise SystemExit("refusing to run without an isolated HERMES_HOME")

    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from tools.registry import registry

    discover_plugins()
    pm = get_plugin_manager()
    listed = {p.get("key") or p.get("name"): p for p in pm.list_plugins()}
    entry = listed.get("unbrowse") or {}
    tools = sorted(e.name for e in registry.get_all_entries() if e.toolset == "unbrowse")
    report = {
        "plugin": {k: entry.get(k) for k in ("name", "enabled", "tools", "hooks", "error", "source") if k in entry},
        "tools": tools,
        "check_fn": None,
        "skill": str(pm.find_plugin_skill("unbrowse:unbrowse") or ""),
        "web_provider": None,
        "results": [],
    }
    try:
        from agent.web_search_registry import get_provider

        provider = get_provider("unbrowse")
        report["web_provider"] = None if provider is None else {
            "name": provider.name, "extract": provider.supports_extract(), "search": provider.supports_search(),
            "available": provider.is_available()}
    except Exception as exc:  # noqa: BLE001
        report["web_provider"] = f"error: {exc}"
    scrape = registry.get_entry("unbrowse_scrape")
    if scrape is not None and scrape.check_fn is not None:
        report["check_fn"] = bool(scrape.check_fn())

    from model_tools import handle_function_call

    for call in spec.get("calls", []):
        attempts = max(1, int(call.get("retry_capacity", 0)) + 1)
        started = time.monotonic()
        for attempt in range(attempts):
            raw = handle_function_call(call["tool"], call.get("args") or {}, task_id=call.get("task_id", "probe"))
            text = raw if isinstance(raw, str) else json.dumps(raw)
            if "browser_capacity" not in text or attempt == attempts - 1:
                break
            time.sleep(30)
        report["results"].append({"tool": call["tool"], "attempts": attempt + 1,
                                  "seconds": round(time.monotonic() - started, 1), "result": text})
    print(json.dumps(report))


if __name__ == "__main__":
    main()
