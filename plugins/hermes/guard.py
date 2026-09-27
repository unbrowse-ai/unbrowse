"""pre_tool_call guard: route public-web work away from Hermes' built-in browser (and web_extract) to Unbrowse.

Local targets (localhost, loopback, private networks, *.local, file:) keep the built-in browser,
since Unbrowse's cloud cannot reach them. ``UNBROWSE_ALLOW_BUILTIN_BROWSER=1`` turns the guard off.
"""

from __future__ import annotations

import ipaddress
import json
import re
import threading
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.parse import urlsplit

ALLOW_ENV = "UNBROWSE_ALLOW_BUILTIN_BROWSER"
_URL_IN_TEXT = re.compile(r"""(?:https?|wss?)://[^\s'"`<>)\]]+""", re.I)
_LOCAL_SCHEMES = {"file", "about", "data", "blob", "chrome", "chrome-extension", "devtools", "view-source"}
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test")
_TRUTHY = {"1", "true", "yes", "on"}


def truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in _TRUTHY) or value == 1


def is_local_url(url: str) -> bool:
    """True for pages Unbrowse's cloud cannot reach: loopback, private/link-local IPs, single-label and
    ``.local``-style hosts, and non-network schemes."""
    raw = (url or "").strip()
    if not raw:
        return True
    if "://" not in raw and not raw.lower().startswith(tuple(f"{s}:" for s in _LOCAL_SCHEMES)):
        raw = "http://" + raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return False
    if parts.scheme.lower() in _LOCAL_SCHEMES:
        return True
    host = (parts.hostname or "").strip(".").lower()
    if not host:
        return True
    if host == "localhost" or host.endswith(_LOCAL_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host  # intranet single-label host
    return ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified or ip.is_reserved


def _guidance(url: Optional[str]) -> str:
    target = json.dumps({"url": url}) if url else '{"url": "<page>"}'
    return (
        "Unbrowse replaces the built-in browser for public websites in this Hermes setup. "
        f"To read a page call unbrowse_scrape {target}. "
        "For a task on a site (search, book, post, fetch structured data) call unbrowse_discover "
        '{"query": "<what you need>"} and then unbrowse_run with the capability it returns; '
        "when nothing fits, unbrowse_browse_open {\"url\": ..., \"task\": ...} drives Unbrowse's cloud browser "
        "and teaches it the site. Local pages (localhost, private network) still use the built-in browser."
    )


class BrowserGuard:
    """Stateful guard. ``settings()`` returns the plugin settings; ``active()`` says Unbrowse is usable
    (no key → never block, or the agent would lose the web entirely)."""

    def __init__(
        self, settings: Callable[[], Dict[str, Any]], active: Callable[[], bool],
        extract_backend: Callable[[], str], env: Callable[[str], Optional[str]], max_tasks: int = 512,
    ):
        self._settings = settings
        self._active = active
        self._extract_backend = extract_backend
        self._env = env
        self._lock = threading.Lock()
        self._local_task: "OrderedDict[str, bool]" = OrderedDict()  # task_id -> last navigation was local
        self._max_tasks = max_tasks

    def _remember(self, task_id: str, local: bool) -> None:
        with self._lock:
            self._local_task[task_id] = local
            self._local_task.move_to_end(task_id)
            while len(self._local_task) > self._max_tasks:
                self._local_task.popitem(last=False)

    def _task_is_local(self, task_id: str) -> bool:
        with self._lock:
            return self._local_task.get(task_id, False)

    def check(self, tool_name: str, args: Any, task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
        """The ``pre_tool_call`` callback: ``{"action": "block", "message"}`` or ``None``."""
        try:
            return self._check(tool_name or "", args if isinstance(args, dict) else {}, task_id or "default")
        except Exception:  # noqa: BLE001 — a guard bug must never break unrelated tools
            return None

    def _check(self, tool: str, args: Dict[str, Any], task_id: str) -> Optional[Dict[str, str]]:
        is_browser = tool.startswith("browser_")
        if not (is_browser or tool in ("web_extract", "web_search")):
            return None
        if truthy(self._env(ALLOW_ENV)) or not self._active():
            return None
        cfg = self._settings()
        if is_browser:
            if not truthy(cfg.get("block_browser", True)):
                return None
            return self._check_browser(tool, args, task_id)
        if tool == "web_extract":
            mode = str(cfg.get("block_web_extract", "auto")).strip().lower()
            if mode in ("false", "0", "no", "off", "never"):
                return None
            if mode == "auto" and self._extract_backend() == "unbrowse":
                return None
            remote = [u for u in _as_list(args.get("urls")) if not is_local_url(u)]
            if not remote:
                return None
            return _block(f"web_extract is routed to Unbrowse. {_guidance(remote[0])} "
                          "(Or set web.extract_backend: unbrowse so web_extract itself uses Unbrowse.)")
        # web_search: Unbrowse has no general web search, so this is opt-in only.
        if truthy(cfg.get("block_web_search", False)):
            return _block("web_search is disabled by the Unbrowse plugin. " + _guidance(None))
        return None

    def _check_browser(self, tool: str, args: Dict[str, Any], task_id: str) -> Optional[Dict[str, str]]:
        if tool == "browser_navigate":
            url = str(args.get("url") or "")
            local = is_local_url(url)
            self._remember(task_id, local)
            return None if local else _block(f"browser_navigate to a public site is blocked. {_guidance(url)}")
        urls = _URL_IN_TEXT.findall(json.dumps(args)) if tool == "browser_exec" else []
        remote = [u for u in urls if not is_local_url(u)]
        if remote:
            return _block(f"{tool} targeting a public site is blocked. {_guidance(remote[0])}")
        if urls or self._task_is_local(task_id):
            return None  # acting on a local page this task opened
        return _block(f"{tool} only works on local pages here (open one with browser_navigate first). "
                      + _guidance(None))


def _as_list(value: Any) -> List[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Iterable):
        return [v if isinstance(v, str) else str((v or {}).get("url", "")) if isinstance(v, dict) else str(v)
                for v in value]
    return []


def _block(message: str) -> Dict[str, str]:
    return {"action": "block", "message": message}
