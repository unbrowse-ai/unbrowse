"""The node as its owner sees it: everything the Unbrowse window does, over ``POST /owner/{command}``."""

from __future__ import annotations

import codecs
import hmac
import json
import os
import urllib.parse
import warnings
from typing import Any, Callable, Dict, Iterator, Optional, Tuple, Union

from . import _generated as wire
from ._generated import OwnerCommands
from ._signed import event_mac
from .client import DEFAULT_NODE, _send, error_for

# A call the owner runs may heal by walking the site again: it can take minutes.
DEFAULT_TIMEOUT = float(wire.CALL_WAIT_SECS)


def _stream_lines(res: Any) -> Iterator[str]:
    """The lines of an event stream, read a chunk at a time: the response's own line reading knows LF alone,
    and the format allows CRLF, LF and a lone CR (UNB-181). A CRLF cut between its CR and its LF across two
    chunks is one line end, not two: the CR closes its line, and an LF opening the next chunk is dropped as
    that line end's other half."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buf = ""
    half_cr = False
    while True:
        chunk = res.read1(65536) if hasattr(res, "read1") else res.read(65536)
        if not chunk:
            break
        text = decoder.decode(chunk)
        if not text:
            continue
        if half_cr and text.startswith("\n"):
            text = text[1:]
        half_cr = text.endswith("\r")
        buf += text.replace("\r\n", "\n").replace("\r", "\n")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            yield line
    if buf:
        yield buf


class UnbrowseOwner(OwnerCommands):
    """The node as its owner sees it: routes, agent keys, the vault, settings (the per-fetch maximum agents spend up to
    among them), the wallet and the chain. Records come back as the node's own snake-case dicts, ready to send back
    (``save_settings(settings)``).

    One method per command comes from the node's own list of them (``OwnerCommands``, generated from agent-api.json),
    named as the node names the command (``agents_list``, ``agent_create``); this class adds the live events, a walk's
    picture, and a few helpers.

    ``token`` is the owner's token, or how to read it, and defaults to ``UNBROWSE_OWNER_TOKEN``. The node writes a fresh
    one to ``~/.unbrowse/owner.token`` every start, so a token held as text is refused from its next start: pass
    ``unbrowse.local.owner_token`` itself, not what it answers, and each request reads the file. With none, requests go
    unsigned, for a proxy in front of the node that signs them. ``base_url`` defaults to ``UNBROWSE_NODE``, then
    http://127.0.0.1:7788; ``timeout`` (seconds) to 330.

    The owner's token can do anything on the node, the vault included. Keep it on this machine.
    """

    def __init__(self, token: Union[str, Callable[[], Optional[str]], None] = None, base_url: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT):
        self.base_url = (base_url or os.environ.get("UNBROWSE_NODE") or DEFAULT_NODE).rstrip("/")
        self._given = token or os.environ.get("UNBROWSE_OWNER_TOKEN")
        self.timeout = timeout

    @property
    def _token(self) -> Optional[str]:
        return self._given() if callable(self._given) else self._given

    def __repr__(self) -> str:
        # Never the token.
        return f"UnbrowseOwner(base_url={self.base_url!r})"

    def command(self, name: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Any owner command by the node's name for it, with its arguments as the node takes them:
        ``command("activity", {"limit": 50})``."""
        return _send(self.base_url, self._token, "POST", f"/owner/{urllib.parse.quote(name, safe='')}", args or {}, self.timeout)

    def address(self) -> str:
        """This node's own address alone: where to send it gas (``identity``)."""
        return self.identity()["address"]

    def agent_create(self, name: str, cap_usdc: Optional[float] = None, days: Optional[int] = None, cap_unb: Optional[float] = None) -> wire.NewAgent:  # type: ignore[override]
        """Make an agent key: ``cap_usdc`` is the most it spends a day, in USDC, and ``days`` how long it lasts. Its setup
        is answered once. ``cap_unb`` is the same cap under its old name, deprecated."""
        if cap_unb is not None:
            warnings.warn("agent_create(cap_unb=...) is deprecated: pass cap_usdc (the amount is USDC)", DeprecationWarning, stacklevel=2)
        cap = cap_usdc if cap_usdc is not None else cap_unb
        if cap is None or days is None:
            raise TypeError("agent_create needs name, cap_usdc and days")
        # The cap goes under its old name too, the one a node from before the rename reads; the amount is USDC either way.
        return self.command("agent_create", {"name": name, "cap_usdc": cap, "cap_unb": cap, "days": days})

    def set_max_fetch(self, usdc: float) -> wire.Settings:
        """Set the most the node pays, in USDC, to fetch one route another contributor lists (0 uses only free routes and
        the node's own). Agents spend up to it on their own; nothing asks the owner."""
        settings: Dict[str, Any] = dict(self.settings())
        settings["max_fetch_usdc"] = usdc
        return self.save_settings(settings)  # type: ignore[arg-type]

    def frame(self, walk: str = "") -> bytes:
        """The latest picture of a walk as JPEG bytes; the newest walk's when ``walk`` is left out."""
        res = _send(self.base_url, self._token, "GET", f"/owner/frame?walk={urllib.parse.quote(walk, safe='')}", None, self.timeout, raw=True)
        with res:
            return res.read()

    def events(self) -> Iterator[Tuple[str, Any]]:
        """The node's live events over ``GET /owner/events``, as ``(name, payload)`` pairs, the payload parsed as JSON.

        One connection: ``("open", None)`` comes first, and the pairs end when the node closes it (a restart). Call it
        again then, and refetch what you show, since events sent while the line was down are gone. The restarted node
        has a fresh token, so that takes a client that reads its token (``token=owner_token``): with one held as text
        the call raises ``AuthenticationError``. Close the generator to hang up."""
        # No timeout: the line stays open for as long as the node sends.
        token = self._token
        res = _send(self.base_url, token, "GET", "/owner/events", None, None, raw=True)
        # A stream answering a signed request has each event's id say its place and carry the node's signature over it:
        # an event out of place or not the node's ends the stream, with ``UnbrowseError``.
        nonce = getattr(res, "unbrowse_nonce", "")
        seq = 0
        with res:
            yield "open", None
            name, data, ident = "message", [], ""
            for line in _stream_lines(res):
                if not line:
                    if data:
                        text = "\n".join(data)
                        if nonce and token:
                            place, _, sig = ident.partition(".")
                            if place != str(seq) or not hmac.compare_digest(event_mac(token, nonce, seq, name, text), sig.strip().lower()):
                                raise error_for(f"an event on the node's stream isn't the node's, or is out of place (expected event {seq}): the stream was dropped", 0, "unreachable")
                            seq += 1
                        try:
                            payload: Any = json.loads(text)
                        except ValueError:
                            payload = text
                        yield name, payload
                    name, data, ident = "message", [], ""
                    continue
                if line.startswith(":"):
                    continue
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    name = value
                elif field == "data":
                    data.append(value)
                elif field == "id":
                    ident = value
