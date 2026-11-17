from __future__ import annotations

import io
import json
import os
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from . import _generated as wire
from ._proof import answer_holds, node_proof, port_of, token_key
from ._signed import STREAM, answer_is_the_nodes, body_hash, sign_request
from ._generated import primitive_request
from .browser import Browser
from .models import BrowseReply, CallResult, Capabilities, Card, DoResult, JudgeResult, LinkPreview, Login, PagesResult, ReportResult, Route, Whoami

DEFAULT_NODE = f"http://127.0.0.1:{wire.DEFAULT_PORT}"

# do may walk a page, and a call may heal by walking it again: both can take minutes.
DEFAULT_TIMEOUT = float(wire.CALL_WAIT_SECS)

# Each status the node answers with, as its code: the first ``ERRORS`` names for it (422 is ``unprocessable`` unless the
# body names ``browser_missing``).
CODES: Dict[int, str] = {}
for _code, _status, _class, _means in wire.ERRORS:
    if _status > 0:
        CODES.setdefault(_status, _code)


class UnbrowseError(Exception):
    """Why a request failed. ``code`` is read from the HTTP status, since the node answers ``{"error": "<why>"}``, or
    from the code its body names. Each code, its status, its class and what it means are the node's: ``ERRORS``
    (``unbrowse._generated``, from agent-api.json).
    """

    def __init__(self, message: str, status: int, code: str, body: Any = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.body = body


# One class per way a request fails, all ``UnbrowseError`` s, so a caller catches what it can handle and lets the rest
# through: ``except AuthenticationError: ...``. ``code`` and ``status`` are the same as before. The connection errors
# carry ``Node`` in their names so they don't hide Python's own ``ConnectionError`` and ``TimeoutError``.


class BadRequestError(UnbrowseError):
    """400: a call the node couldn't run with these inputs."""


class AuthenticationError(UnbrowseError):
    """401: no token, or a key that is unknown, revoked or expired."""


class PaymentRequiredError(UnbrowseError):
    """402: a paid route this key isn't authorised for, past its cap, or over the owner's per-fetch maximum."""


class PermissionDeniedError(UnbrowseError):
    """403: the owner declined, or turned learning off, or excluded the site."""


class NotFoundError(UnbrowseError):
    """404: no such route; or nothing does the goal yet and no ``url`` was given."""


class ConflictError(UnbrowseError):
    """409: routes on more than one site do the goal: give ``url`` to say which."""


class UnprocessableEntityError(UnbrowseError):
    """422: the browser or the learner couldn't do it; the message says why."""


class BrowserMissingError(UnprocessableEntityError):
    """422 with the node's code ``browser_missing``: what was asked needs the node's browser (to learn a page, or to
    drive one by hand), and the node lacks it or the call said ``browser="never"``. Everything else works without it:
    search, calls of routes the node holds or fetches, whoami. ``install`` says how to get it (``unbrowse browser
    install``); ``fetches`` is whether the node fetches it by itself when a goal needs it. Also an
    ``UnprocessableEntityError``, which is what code written before the browser was optional catches."""

    def _field(self, name: str) -> Any:
        return self.body.get(name) if isinstance(self.body, dict) else None

    @property
    def browser(self) -> str:
        """The browser as the node saw it: ``missing``, ``installing`` (fetching it now: try again in a minute) or
        ``present``."""
        b = self._field("browser")
        return b if b in ("present", "installing") else "missing"

    @property
    def missing(self) -> List[str]:
        """The parts missing: ``program`` (the browser program, for driving a page) and ``chromium`` (for any page)."""
        m = self._field("missing")
        return [str(x) for x in m] if isinstance(m, list) else []

    @property
    def install(self) -> str:
        """How to get it, on the node's machine."""
        i = self._field("install")
        return i if isinstance(i, str) else "unbrowse browser install"

    @property
    def fetches(self) -> bool:
        """Whether the node fetches the browser itself the first time a goal needs it."""
        return self._field("fetch") is True


class NodeUnavailableError(UnbrowseError):
    """503: the node is paused by its owner, or waiting for Keychain access."""


class NodeConnectionError(UnbrowseError):
    """Status 0: the node isn't running, or nothing answers at its address."""


class NodeTimeoutError(NodeConnectionError):
    """Status 0: the node didn't answer in time. Also a ``NodeConnectionError``."""


# The classes by their names in ``ERRORS``, then by the code each is raised for.
_BY_NAME = {
    c.__name__: c
    for c in (
        BadRequestError,
        AuthenticationError,
        PaymentRequiredError,
        PermissionDeniedError,
        NotFoundError,
        ConflictError,
        UnprocessableEntityError,
        BrowserMissingError,
        NodeUnavailableError,
        NodeConnectionError,
        NodeTimeoutError,
    )
}
_CLASSES = {code: _BY_NAME[name] for code, _status, name, _means in wire.ERRORS if name}


def error_for(message: str, status: int, code: str, body: Any = None) -> UnbrowseError:
    """The error for a failure: the class its ``code`` names, else a plain ``UnbrowseError``."""
    return _CLASSES.get(code, UnbrowseError)(message, status, code, body)


Value = Union[str, int, float, bool]


class UnbrowseNode:
    """The Unbrowse node on this machine, as an agent sees it. Say what you want with ``do``: the node calls the route
    that does it, or learns one from the page and calls that.

    When the page needs hands, drive it with ``browser()``; the node learns from every step.

    ``token`` defaults to ``UNBROWSE_AGENT_TOKEN``; ``base_url`` to ``UNBROWSE_NODE``, then http://127.0.0.1:7788;
    ``timeout`` (seconds) to 330.

    ``session`` is the browsing session this client's pages belong to: each session has its own tab in a site's
    browser on the node, so agents browsing the same site at once each read and drive their own page, even on one key.
    It defaults to one drawn fresh for this client; pass the same name to pick up a page another client of yours opened.

    ``auto_start`` (``True``, or the options ``start`` takes as a dict) starts the node on this machine on the first
    request when none answers, as ``Unbrowse.start()`` does; ``close()`` stops it again, and the next request starts it
    again.
    """

    def __init__(
        self,
        token: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        session: Optional[str] = None,
        auto_start: Union[bool, Mapping[str, Any]] = False,
    ):
        named = base_url or os.environ.get("UNBROWSE_NODE")
        self.base_url = (named or DEFAULT_NODE).rstrip("/")
        self._token = token or os.environ.get("UNBROWSE_AGENT_TOKEN")
        self.timeout = timeout
        self.session = session or uuid.uuid4().hex
        self._started: Any = None
        self._caps: Optional[Capabilities] = None
        # The node ``_auto`` found or started, as far as this client has seen, is still there.
        self._brought = False
        # One start at a time: a request made during one waits for it, and ``close`` stops what it brought.
        self._starting = threading.Lock()
        # The address goes to the start only when it was named; a token only when it was given.
        self._auto: Optional[Dict[str, Any]] = None
        if auto_start:
            self._auto = {**({"base_url": named} if named else {}), **({"token": token} if token else {}), **(dict(auto_start) if isinstance(auto_start, Mapping) else {})}

    @classmethod
    def start(cls, **opts: Any) -> "UnbrowseNode":
        """The node on this machine, started when none is running: the ``unbrowse-node`` program the package brought
        (or ``UNBROWSE_BIN``'s, or ``program``), with no window, waited for until it answers, and an agent token read
        from it when none is given. No browser is needed: the node serves search, calls and whoami without one.
        ``close()`` stops a node this started and leaves one that was running already. Without a node program, it says
        how to get one. A node that goes away later is brought back as ``auto_start`` does.

        Takes ``home`` (``UNBROWSE_HOME``), ``port`` (``UNBROWSE_PORT``), ``program``, ``token``, ``base_url``,
        ``ready_timeout`` (seconds, 60), ``env`` (more environment for the node), ``output`` (``"ignore"`` or
        ``"inherit"``), and the client's ``timeout`` and ``session``.
        """
        from .start import bring

        client_opts = {k: opts.pop(k) for k in ("timeout", "session") if k in opts}
        base_url, token, started = bring(**opts)
        node = cls(token=token, base_url=base_url, **client_opts)
        node._started, node._auto, node._brought = started, opts, True
        return node

    def close(self) -> None:
        """Stops the node this client started (``start``, ``auto_start``); a node that was running already is left. A
        start still running finishes first, so its node is stopped too. A later request starts the node again, as the
        first one did."""
        with self._starting:
            started, self._started = self._started, None
            self._brought = False
        if started is not None:
            started.stop()

    def __enter__(self) -> "UnbrowseNode":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _ensure_started(self) -> None:
        """Finds the node, when ``auto_start`` says to: the first time a request needs it, and again once it has gone. A
        node this client started is known gone by its process, so the request waits for the next one. One started
        elsewhere shows only as a request that couldn't reach it (``_request``), which is answered as it failed: it may
        have been a write, and the node that takes the next request is a new one."""
        if self._auto is None:
            return
        from .start import bring

        with self._starting:
            if self._brought and not (self._started is not None and self._started.exited):
                return
            if self._started is not None:
                # Its process has gone; this takes it off the list of what ends with the script.
                self._started.stop()
                self._started = None
            base_url, token, started = bring(**self._auto)
            self.base_url, self._token, self._started, self._caps = base_url.rstrip("/"), token, started, None
            self._brought = True

    def __repr__(self) -> str:
        # Never the token.
        return f"UnbrowseNode(base_url={self.base_url!r})"

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        self._ensure_started()
        if not self._token:
            raise error_for(
                "no agent token: pass token= or set UNBROWSE_AGENT_TOKEN (Unbrowse app, Wallet, New agent key)",
                401,
                "unauthorized",
            )
        try:
            return _send(self.base_url, self._token, method, path, body, timeout or self.timeout)
        except UnbrowseError as e:
            if e.code == "unreachable" and self._started is None:
                self._brought = False
            raise

    def _primitive(self, tool: str, args: Dict[str, Any], timeout: Optional[float] = None) -> Any:
        """One agent primitive, as its ``/v1`` route takes it (``_generated.PRIMITIVES``), answering the wire record."""
        method, path, body = primitive_request(tool, args)
        return self._request(method, path, body, timeout=timeout)

    def whoami(self) -> Whoami:
        """Which agent key this client holds, and the node it's live on. A cheap way to check the setup."""
        r: wire.Whoami = self._primitive("unbrowse_whoami", {})
        fetch = r.get("browser_fetch")
        return Whoami(agent=r.get("agent", ""), address=r.get("address", ""), node=r.get("node", ""), browser=r.get("browser"), browser_fetch=fetch if isinstance(fetch, bool) else None)

    def capabilities(self) -> Capabilities:
        """What the node can do now: whether it has its browser (``present``, ``missing``, ``installing``, or
        ``unknown`` for a node from before the browser was optional), whether it fetches it itself when a goal needs
        it, and whether it takes ``do``'s ``browser`` option. Search and calls never need the browser; learning a page
        and driving one do."""
        w = self.whoami()
        return Capabilities(browser=w.browser or "unknown", fetches_browser=w.browser_fetch is True, browser_option=w.browser is not None)

    def observe(self, site: str = "", session: str = "", goal: str = "") -> Dict[str, Any]:
        """The page in the node's browser as actions, not text: each interactive element with its stable ref, role,
        name, state and the commands it takes (click, fill, type, select, check). Nothing is clicked and nothing is
        paid. Use the same ``site`` and ``session`` with :meth:`browse`."""
        return self._primitive("unbrowse_observe", {"site": site, "session": session, "goal": goal})

    def challenge(
        self,
        action: str,
        url: str = "",
        site: str = "",
        session: str = "",
        x: Optional[float] = None,
        y: Optional[float] = None,
        to_x: Optional[float] = None,
        to_y: Optional[float] = None,
        text: Optional[str] = None,
        key: Optional[str] = None,
        ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """A page that asks for a person, met with your own eyes: ``look`` shows it as a picture (``image``, at ``w`` x
        ``h`` CSS pixels) with its text and ``asks`` (whether it still asks), and ``click``, ``drag``, ``type``,
        ``press``, ``wait`` or ``done`` take one step. Every reply is the page again, so you see what your step did;
        ``asks`` is the page's own answer."""
        return self._primitive(
            "unbrowse_challenge",
            {"action": action, "url": url, "site": site, "session": session, "x": x, "y": y, "to_x": to_x, "to_y": to_y, "text": text, "key": key, "ms": ms},
        )

    def inspect(self, route_id: str) -> Dict[str, Any]:
        """A route's values before you call or change it: each step, each field's class and where it comes from,
        whether a step needs a browser, the scripts the route carries, and its own description. Nothing is called and
        nothing is paid; no value is shown, only its class and where it came from."""
        return self._primitive("unbrowse_inspect", {"route_id": route_id})

    def search(self, query: str = "") -> List[Route]:
        """Routes for what you want, by plain words or the site's name.

        This node's and other contributors' (``remote=True``, with their fetch fee; ``over_max`` on one the owner's
        per-fetch maximum rules out), ranked together. An empty query lists every local route.
        """
        r: wire.SearchResult = self._primitive("unbrowse_search", {"query": query})
        return [Route.of(x) for x in (r or {}).get("routes") or []]

    def walk(self, url: str, goal: str = "", pick: Optional[int] = None, what: str = "", session: str = "") -> Dict[str, Any]:
        """The calls a page makes, so you can pick the one that does your goal instead of guessing.

        Walks ``url`` once in the node's browser (or reuses the walk this session already made) and returns its
        candidates: ``index`` (the candidate's own index to pick), method, host, path, status, bytes, the top-level
        keys of the answer, and ``page`` when it is the page itself. With ``pick`` the node keeps that candidate as a
        route, named ``what`` (or ``goal``), and returns it in ``route``, ready for :meth:`call`.
        """
        return self._primitive("unbrowse_walk", {"url": url, "goal": goal, "pick": pick, "what": what, "session": session})

    def do(
        self,
        goal: str,
        url: Optional[str] = None,
        inputs: Optional[Mapping[str, Value]] = None,
        *,
        browser: Optional[str] = None,
        fields: Optional[Sequence[str]] = None,
        pays_usd: Optional[float] = None,
        pays: bool = False,
    ) -> DoResult:
        """What you want, done: the route that does ``goal`` is called.

        When none does yet and you give ``url`` (a page that does it), the node's browser walks the page once, keeps
        the call that answers the goal, and calls that; the next ``do`` with the same goal skips the browser. Put what
        you'd search for in the url's query (``https://hn.algolia.com/?q=rust``): it becomes the route's input.
        ``inputs`` go by the route's input names and win over the url's.

        Before the browser, another contributor's route for the page's site may do it (``how == "network"``): the node
        pays its fee itself, with nothing to approve, up to the owner's per-fetch maximum, and ``network_skipped``
        names any it passed over for costing more. When the page needs clicks or typing, ``how`` is ``"browse"`` and
        the page is open in the node's browser for you to drive. A write that fails is answered as it failed, never
        retried another way: read ``result.retry``.

        ``browser`` says whether this may use the node's browser, which only learning a page and driving one need:
        ``"auto"`` (the default, what the node has always done: the browser when the goal needs it, fetched first when
        the node lacks it and its owner lets it), ``"if_present"`` (only a browser the node has already) or ``"never"``
        (only a route, another contributor's route or a plain request). A goal that needs a browser this rules out,
        or that the node lacks, raises ``BrowserMissingError``. A node from before this option can't honour
        ``"never"``, so the client refuses to send it there rather than let that node open its browser.

        ``fields`` are the answer's fields to get besides the ones a call hands back by default (the goal's fields and
        each record's name), by the paths ``result.fields.more`` lists, or ``["*"]`` for the whole answer.

        ``pays_usd`` and ``pays`` are accepted from older code and ignored: nothing is sent for them.
        """
        _ignored(pays_usd, pays)
        if browser not in (None, "auto", "if_present", "never"):
            raise ValueError(f"browser is auto, if_present or never, not {browser!r}")
        if browser == "never":
            # A node from before the option reads past it and may open its browser: "never" isn't sent where it can't hold.
            if self._caps is None:
                self._caps = self.capabilities()
            if not self._caps.browser_option:
                raise error_for("this node is from before do's browser option, so it can't keep a call off its browser: update the node, or leave browser unset", 0, "unsupported")
        args: wire.DoArgs = {"goal": goal, "url": url or "", "inputs": {k: _str(v) for k, v in (inputs or {}).items()}, "session": self.session}
        if browser in ("if_present", "never"):
            args["browser"] = browser  # type: ignore[typeddict-item]
        if fields:
            args["fields"] = list(fields)  # type: ignore[typeddict-item]
        return DoResult.of(self._primitive("unbrowse_do", dict(args)))

    def do_pages(
        self,
        goal: str,
        pages: Sequence[Union[str, Mapping[str, Any]]],
        inputs: Optional[Mapping[str, Value]] = None,
        *,
        browser: Optional[str] = None,
        fields: Optional[Sequence[str]] = None,
    ) -> PagesResult:
        """Several pages at once, each done as ``do`` does one url, side by side on the node.

        ``pages`` are urls, or ``{"url": ..., "goal": ..., "inputs": {...}}`` for a page with a goal or inputs of its
        own (they win over the call's). Within a site its first page goes first, so a route learned there answers the
        site's other pages (another coin's, item's or user's) in one call each. Each answer is cut to how it went, its
        time and its data; a page that needs clicks or typing says so (``how == "browse"``) and isn't opened: ask
        ``do`` for it alone. At most 100 pages. ``browser`` and ``fields`` are as for ``do``.
        """
        if browser not in (None, "auto", "if_present", "never"):
            raise ValueError(f"browser is auto, if_present or never, not {browser!r}")
        asked: List[Dict[str, Any]] = []
        for p in pages:
            if isinstance(p, str):
                asked.append({"url": p})
            else:
                page: Dict[str, Any] = {"url": str(p.get("url", ""))}
                if p.get("goal"):
                    page["goal"] = str(p["goal"])
                if p.get("inputs"):
                    page["inputs"] = {k: _str(v) for k, v in p["inputs"].items()}
                asked.append(page)
        args: Dict[str, Any] = {"goal": goal, "pages": asked, "inputs": {k: _str(v) for k, v in (inputs or {}).items()}, "session": self.session}
        if browser in ("if_present", "never"):
            args["browser"] = browser
        if fields:
            args["fields"] = list(fields)
        r = self._primitive("unbrowse_do", args)
        if (r or {}).get("how") != "pages":
            raise error_for("this node is from before do's pages: update it, or ask for each page with do", 0, "unsupported")
        return PagesResult.of(r)

    def call(
        self,
        route_id: str,
        inputs: Optional[Mapping[str, Value]] = None,
        *,
        fields: Optional[Sequence[str]] = None,
        pays_usd: Optional[float] = None,
        pays: bool = False,
    ) -> CallResult:
        """Call a route and get the site's answer.

        Inputs go by the names in the route's ``inputs``; values are sent as strings. Nothing waits for the owner: a
        network route's fee is paid by the node itself, once, and one costing more than the owner's per-fetch maximum
        is refused (``payment_required``). ``pays_usd`` and ``pays`` are accepted from older code and ignored.

        A call that doesn't pass returns ``ok=False`` rather than raising: read ``retry`` before running a write
        again. ``data`` holds the fields the route's goal names and each record's name; ``fields`` adds others by the
        paths ``result.fields.more`` lists, or ``["*"]`` for the whole answer.
        """
        _ignored(pays_usd, pays)
        args: wire.CallArgs = {"route_id": route_id, "inputs": {k: _str(v) for k, v in (inputs or {}).items()}}
        if fields:
            args["fields"] = list(fields)
        return CallResult.of(self._primitive("unbrowse_call", dict(args)))

    def open(self, link: str) -> LinkPreview:
        """What an ``unbrowse://`` link names: a site's routes, or one route, as the network lists them and the chain
        proves them. Nothing is called or paid; ``call`` a route by its id afterwards. A link that isn't one is refused.
        """
        return LinkPreview.of(self._primitive("unbrowse_open", {"link": link}))

    def logins(self) -> List[Login]:
        """Logins saved on the node, as references (``vault:<site>:<account>``). Values never leave the node."""
        r: wire.LoginsResult = self._primitive("unbrowse_logins", {})
        return [Login(ref=x.get("ref", ""), site=x.get("site", ""), code=x.get("code")) for x in (r or {}).get("logins") or []]

    def cards(self) -> List[Card]:
        """Payment cards saved on the node, each by its label and last four digits, with a reference for every field a
        checkout asks for. Fill one into a page with the browser (``fill(target, card.number)``): the node types it,
        and asks the owner to approve the payment first. Card numbers never leave the node."""
        r: wire.LoginsResult = self._primitive("unbrowse_logins", {})
        return [Card.of(x) for x in (r or {}).get("cards") or []]

    def report(
        self,
        kind: str,
        summary: str,
        expected: str,
        got: str,
        *,
        route_id: Optional[str] = None,
        goal: Optional[str] = None,
        url: Optional[str] = None,
        tool: Optional[str] = None,
        error: Optional[str] = None,
    ) -> ReportResult:
        """Report a problem with Unbrowse itself, so it gets fixed.

        ``kind``: ``wrong_data`` (a result for another thing than asked), ``false_success`` (ok with a block page,
        captcha, error page or no data), ``failed`` (a call failed or needed a workaround), ``slow``, ``confusing`` or
        ``other``. Once per distinct problem, then carry on. The node scrubs it (no query strings, emails, tokens or
        your names), adds the route's shape and your last error, and sends it to be filed as a public GitHub issue on
        unbrowse-ai/unbrowse. Never for a site that is simply down, and never with personal data. ``report`` in the
        result says whether it was sent, queued or off.
        """
        # An optional field left empty is None, which the request leaves out: the node reads it as not given.
        given = {"route_id": route_id, "goal": goal, "url": url, "tool": tool, "error": error}
        args: Dict[str, Any] = {"kind": kind, "summary": summary, "expected": expected, "got": got, **{k: v or None for k, v in given.items()}}
        r: wire.ReportResult = self._primitive("unbrowse_report", args)
        return ReportResult.of(r or {})

    def judge(
        self,
        route_id: str,
        verdict: str,
        *,
        url: Optional[str] = None,
        why: Optional[str] = None,
        what: Optional[str] = None,
        fields: Optional[Sequence[str]] = None,
        writes: Optional[bool] = None,
    ) -> JudgeResult:
        """Tell the node what you saw in a route's answer, so its next answers are right.

        You read the answer against your goal, and the node keeps what you say. ``verdict="wrong"`` with ``url`` and
        ``why``: the answer doesn't do that page (an empty list, another thing, the wrong tab); ``do`` for it then
        passes the route over and learns the page afresh, or opens it for your hands. ``what``: your words for what
        the answer really is, which the route goes by from then on. ``verdict="right"`` with ``fields``: those paths
        are the answer, kept as the route's defaults. ``writes=True``: calling it changes the site whatever its
        method says (a GET that unsubscribes or adds to a cart), so it is held as a write; ``False`` takes that back.
        """
        args: Dict[str, Any] = {"route_id": route_id, "verdict": verdict, "url": url or None, "why": why or None, "what": what or None, "fields": list(fields) if fields else None, "writes": writes}
        r: wire.JudgeResult = self._primitive("unbrowse_judge", args)
        return JudgeResult.of(r or {})

    def answer_bounty(self, route_id: str, verdict: str, *, bounty: int, entry: str) -> wire.BountyAnswer:
        """Answer what a call's ``bounties.confirm`` asked (spec ch. 8), once each, with its ``bounty`` and ``entry``.

        ``verdict="right"``: the answer you got from that entry does your owner's bounty, and the node asks your owner,
        confirming the bounty (it buys that entry's coin) only on their yes. ``"wrong"``: it doesn't, and you won't be
        asked about that entry again. Never call an entry only to answer: calls are paid.
        """
        args: Dict[str, Any] = {"route_id": route_id, "verdict": verdict, "bounty": bounty, "entry": entry}
        return self._primitive("unbrowse_judge", args)

    def browser(self, goal: str = "", site: str = "", session: Optional[str] = None) -> Browser:
        """The node's browser, driven by hand, for a page that needs it (``do`` says so with ``how == "browse"``).

        Every step is recorded, and the node learns routes from it as you go: each reply names them in ``learned``.
        It drives this client's session's own tab of the site's browser; ``session`` names another.
        """
        return Browser(self, goal=goal, site=site, session=session)

    def browse(
        self,
        args: List[str],
        site: str = "",
        goal: str = "",
        timeout: Optional[float] = None,
        session: Optional[str] = None,
    ) -> BrowseReply:
        """One raw browse command, as ``POST /v1/browse`` takes it. ``browser()`` is the usual way in."""
        browse: wire.BrowseArgs = {"do": list(args), "site": site, "goal": goal, "session": session or self.session}
        return BrowseReply.of(self._primitive("unbrowse_browse", dict(browse), timeout=timeout))

    def mcp_server(self) -> Dict[str, Any]:
        """The node as an MCP server, for agent frameworks that take one: ``unbrowse mcp`` over stdio.

        Tools ``unbrowse_do``, ``unbrowse_browse``, ``unbrowse_search``, ``unbrowse_call`` and ``unbrowse_report``. The
        bridge signs each message with the token, so the framework never sends the token, and a process that took or
        relays the node's address never sees it. The config carries the token in the bridge's environment: keep it out
        of logs.
        """
        self._ensure_started()
        token = self._token
        if not token:
            raise error_for("no agent token: pass token= or set UNBROWSE_AGENT_TOKEN", 401, "unauthorized")
        prove_node(self.base_url, token, self.timeout)
        # ``unbrowse mcp`` signs each message with the token: the framework never sends it over a transport of its own.
        return {"type": "stdio", "command": "unbrowse", "args": ["mcp"], "env": {"UNBROWSE_NODE": self.base_url, "UNBROWSE_AGENT_TOKEN": token}}


def prove_node(base_url: str, token: str, timeout: Optional[float]) -> None:
    """Asks what listens at ``base_url`` to answer a fresh challenge with ``token`` before the token goes there: only the
    node the token is for can (``/v1/node/proof``). Raises ``AuthenticationError`` when it can't (the listener isn't the
    node, or the node no longer holds the token), and the token is never sent."""
    port = port_of(base_url)

    def refused(why: str) -> UnbrowseError:
        return error_for(f"{why}; the token wasn't sent", 401, "unauthorized")

    if port is None:
        raise refused(f"the node's address ({base_url}) names no port to prove")
    challenge = os.urandom(32)
    url = f"{base_url}/v1/node/proof?challenge={challenge.hex()}&key={token_key(token)}"
    wait = min(timeout, 30.0) if timeout else 30.0
    try:
        with _NO_REDIRECT.open(urllib.request.Request(url, method="GET"), timeout=wait) as res:
            answer = _json(res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        answer = _json(e.read().decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise error_for(f"the node didn't answer within {wait} s", 0, "timeout") from None
        raise error_for(f"couldn't reach the node at {base_url}: is the Unbrowse app running? ({e.reason})", 0, "unreachable") from None
    except (socket.timeout, TimeoutError):
        raise error_for(f"the node didn't answer within {wait} s", 0, "timeout") from None
    except ConnectionError as e:
        raise error_for(f"couldn't reach the node at {base_url}: is the Unbrowse app running? ({e})", 0, "unreachable") from None
    if not answer_holds(answer, node_proof(token, port, challenge)):
        raise refused(f"what answers at {base_url} couldn't prove it is the node this token is for (or the node no longer holds the token)")


class _Unfollowed(urllib.request.HTTPRedirectHandler):
    """Follows no redirect: a request to the node goes to its address and nowhere else, and an answer that points
    elsewhere ends it (as the ``HTTPError`` it is)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


#: Every request to the node, the proof included, goes through this opener.
_NO_REDIRECT = urllib.request.build_opener(_Unfollowed)


def _send(base_url: str, token: Optional[str], method: str, path: str, body: Optional[Dict[str, Any]], timeout: Optional[float], raw: bool = False) -> Any:
    """One request to the node: the answer as JSON, or with ``raw`` the open response itself (a stream) or its bytes (a
    picture), which the caller closes. Without a token it goes as it is, for a proxy in front of the node that adds what
    it needs. With one, the listener proves first that it is the node the token is for (``prove_node``), so nothing a
    request says goes to one that can't reach the node; the request is signed with the token, which is never sent
    (``_signed``), and an answer is used only when the node signed it for this request."""
    if token:
        prove_node(base_url, token, timeout)
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers: Dict[str, str] = {}
    nonce = ""
    if token:
        headers, nonce = sign_request(token, method, url, data or b"")
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        res = _NO_REDIRECT.open(req, timeout=timeout)
        streams = (res.headers.get("content-type") or "").startswith("text/event-stream")
        if raw and streams:
            if token and not answer_is_the_nodes(token, res.status, res.headers, STREAM, nonce):
                res.close()
                raise _not_the_nodes(base_url, res.status)
            res.unbrowse_nonce = nonce  # type: ignore[attr-defined]
            return res
        with res:
            got = res.read()
            status, answer_headers = res.status, res.headers
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise error_for(f"what answered at {base_url} pointed elsewhere (status {e.code}): a request to the node is never sent on", 0, "unreachable") from None
        # A refusal the node didn't sign (it couldn't tell whose the request was) may be anyone's words: only its status
        # is read, and what is said is this client's own. One the node signed is said in its words.
        got = e.read()
        if token and not answer_is_the_nodes(token, e.code, e.headers, body_hash(got), nonce):
            raise error_for(unsigned_refusal(e.code), e.code, CODES.get(e.code, f"http_{e.code}")) from None
        text = got.decode("utf-8", "replace")
        parsed = _json(text)
        why = parsed.get("error") if isinstance(parsed, dict) and isinstance(parsed.get("error"), str) else (text or e.reason)
        # A code the node names (``browser_missing``) says more than the status; a node from before codes names none.
        named = parsed.get("code") if isinstance(parsed, dict) else None
        code = named if isinstance(named, str) and named in _CLASSES else CODES.get(e.code, f"http_{e.code}")
        raise error_for(str(why), e.code, code, parsed if parsed is not None else text) from None
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise error_for(f"the node didn't answer within {timeout} s", 0, "timeout") from None
        raise error_for(f"couldn't reach the node at {base_url}: is the Unbrowse app running? ({e.reason})", 0, "unreachable") from None
    except (socket.timeout, TimeoutError):
        raise error_for(f"the node didn't answer within {timeout} s", 0, "timeout") from None
    except ConnectionError as e:
        raise error_for(f"couldn't reach the node at {base_url}: is the Unbrowse app running? ({e})", 0, "unreachable") from None
    text = got.decode("utf-8", "replace")
    if token and not answer_is_the_nodes(token, status, answer_headers, body_hash(got), nonce):
        raise _not_the_nodes(base_url, status)
    if raw:
        return io.BytesIO(got)
    return _json(text)


def _not_the_nodes(base_url: str, status: int) -> UnbrowseError:
    return error_for(
        f"what answered at {base_url} didn't sign its answer as the node this token is for does (status {status}): nothing it said is used or shown",
        0,
        "unreachable",
    )


def unsigned_refusal(status: int) -> str:
    """What a client says of a refusal the node didn't sign, by its status alone: the node signs every answer once it
    knows whose the request is, so an unsigned one is the node refusing before that (an unknown key, a bad signature, a
    clock too far off, a node not ready) or something else holding its address. Its words are never shown."""
    said = {
        401: "the node refused this request before it could tell whose it was: the key may be unknown, revoked or expired, or this machine's clock too far off (get a fresh key: `unbrowse connect`, or `unbrowse agent token`)",
        413: "the request was larger than the node takes",
        421: "the node takes requests at 127.0.0.1 or localhost on its own port only",
        503: "the node isn't ready for this (starting, paused, or waiting for its key, or it couldn't record the request): try again shortly",
    }.get(status, "the node refused this request")
    return f"{said} (status {status}; the answer wasn't signed, so nothing it said is shown)"


def _json(text: str) -> Any:
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def _str(v: Value) -> str:
    # The node takes strings; a bool goes as JavaScript would write it, so both SDKs send the same thing.
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _ignored(pays_usd: Optional[float], pays: bool) -> None:
    # Code written for nodes that asked what a call pays still runs: the words are dropped, never sent, and said once.
    if pays_usd is not None or pays:
        warnings.warn(
            "pays_usd and pays are no longer used: the node pays a route's fee itself, up to its owner's per-fetch maximum",
            DeprecationWarning,
            stacklevel=3,
        )
