"""Key mobility and the public boundary — the identity-exposure rule of
*Crypto Was All You Needed*.

One Ed25519/Solana root owns the whole layer stack (see layers/descent.py). This
module states the asymmetry that makes exposing that single root safe. The
PRIVATE key is mobile INWARD: it can surface (sign / authorise) an identity or a
value at ANY layer it descends to — a click at the screen layer, a signature on a
packet — always the one root, moving up or down the stack to wherever authority is
needed. Across the PUBLIC boundary the rule inverts: **only value copies cross the
public boundary** — content-addressed copies of the value, verifiable against the
PUBLIC key and nothing more. The private key never leaves; what the world receives
is a copy it can check, but cannot forge and cannot reverse into the secret.

`Identity.surface(value, layer)` signs a value at a given altitude with the one
root key (mobility inward; the record is private-side). `publish(surfaced)` emits
the only thing allowed outward: a fresh value copy {content_hash, value, layer,
root, sig} carrying no private material. `verify_public()` checks the copy against
the public key and its own content hash. A foreign wallet cannot forge a copy; a
tampered copy fails its content hash; the published object is an independent copy,
so mutating it never touches the source.
"""
from __future__ import annotations
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify, sha, UNSIGNED  # noqa: E402

# Same stack as the signed descent, top (human) to bottom (wire).
LAYERS = ("screen", "browser", "cli", "os", "kernel", "packet")


def _canon(value: str, layer: str, root: str) -> bytes:
    return json.dumps({"value": value, "layer": layer, "root": root},
                      sort_keys=True, separators=(",", ":")).encode()


class Identity:
    """One root key whose signing authority is mobile across every layer."""

    def __init__(self, wallet: Wallet):
        self.wallet = wallet

    def surface(self, value: str, layer: str) -> dict:
        """Surface (sign) a value or identity at `layer` with the one root key.

        The private key moves to whatever altitude needs it. The returned record
        is private-side — it lives inside the stack, not yet across the boundary.
        """
        root = self.wallet.pub_hex
        rec = {"value": value, "layer": layer, "root": root}
        rec["sig"] = self.wallet.sign(_canon(value, layer, root))
        return rec


def publish(surfaced: dict) -> dict:
    """The public boundary: emit ONLY a content-addressed value copy.

    A fresh dict (a COPY) carrying the value, its layer, the PUBLIC key, the
    signature, and the content hash — never any private key material.
    """
    value = surfaced["value"]
    return {
        "content_hash": sha(value.encode()),
        "value": value,            # a copy of the value, not a reference
        "layer": surfaced["layer"],
        "root": surfaced["root"],  # the PUBLIC key only
        "sig": surfaced["sig"],
    }


def verify_public(published: dict, expect_root: str) -> bool:
    """True iff `published` is an authentic, untampered value copy of `expect_root`:
    content hash matches the value bytes and the signature verifies under the
    PUBLIC key. No private material is needed (or present) to check it."""
    if published.get("root") != expect_root:
        return False
    if published.get("content_hash") != sha(published.get("value", "").encode()):
        return False
    sig = published.get("sig")
    if not sig or sig == UNSIGNED:
        return False
    return verify(expect_root, sig, _canon(published["value"], published["layer"], expect_root))
