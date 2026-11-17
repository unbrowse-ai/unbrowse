"""Requests signed with a token, never carrying it (``unbrowse_core::signed`` on the node).

The client names its token by its key (``token_key``) and signs each request with an HMAC-SHA256 keyed by the token over
the method, the authority it goes to (host and port), the request target (path and query, as sent), a SHA-256 of the body, the time and a fresh nonce. The node
checks it and takes each nonce once, so a process that took the node's address, or relays it, gets one request it can't
send again and no token. The node signs its answer over the status, a SHA-256 of the body and the request's nonce, and
each event of a stream with its place in it, so an answer of anyone else's is never used."""

import hashlib
import hmac
import os
import time
from typing import Dict, Mapping, Tuple
from urllib.parse import urlsplit

from ._proof import token_key

#: What stands for the body hash in the signature on an event stream's answer.
STREAM = "event-stream"


def _mac(token: str, parts: Tuple[str, ...]) -> str:
    return hmac.new(token.encode(), "\n".join(parts).encode(), hashlib.sha256).hexdigest()


def body_hash(body: bytes) -> str:
    """SHA-256 of a body, hex: what the signatures carry in its place."""
    return hashlib.sha256(body).hexdigest()


def request_mac(token: str, method: str, authority: str, target: str, body: bytes, at: int, nonce: str) -> str:
    """``authority`` is the host and port the request goes to (``address_of``): signed for one, it verifies at no other."""
    return _mac(token, ("unbrowse/request/v2", method.upper(), authority.lower(), target, body_hash(body), str(at), nonce))


def address_of(url: str) -> Tuple[str, str]:
    """What a request to ``url`` is signed over: the authority it goes to (``host:port``, lower case, the port always
    written) and the path and query it sends."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if ":" in host:
        host = f"[{host}]"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return f"{host}:{port}", parts.path + (f"?{parts.query}" if parts.query else "")


def reply_mac(token: str, status: int, hashed: str, nonce: str) -> str:
    return _mac(token, ("unbrowse/reply/v1", str(status), hashed, nonce))


def event_mac(token: str, nonce: str, seq: int, name: str, data: str) -> str:
    return _mac(token, ("unbrowse/event/v1", nonce, str(seq), name, data))


def sign_request(token: str, method: str, url: str, body: bytes) -> Tuple[Dict[str, str], str]:
    """The headers that sign a request to ``url``, and the nonce its answer is signed over."""
    authority, target = address_of(url)
    nonce = os.urandom(16).hex()
    at = int(time.time())
    return (
        {
            "x-unbrowse-key": token_key(token),
            "x-unbrowse-time": str(at),
            "x-unbrowse-nonce": nonce,
            "x-unbrowse-signature": request_mac(token, method, authority, target, body, at, nonce),
        },
        nonce,
    )


def answer_is_the_nodes(token: str, status: int, headers: Mapping[str, str], hashed: str, nonce: str) -> bool:
    """Whether an answer is the node's to the request that carried ``nonce``: ``hashed`` is ``body_hash`` of its body,
    or ``STREAM``."""
    theirs = headers.get("x-unbrowse-reply") or ""
    return bool(theirs) and hmac.compare_digest(reply_mac(token, status, hashed, nonce), theirs.strip().lower())
