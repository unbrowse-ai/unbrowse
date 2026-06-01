"""Signed descent through every layer of computer use — the central claim of
*Internal APIs Were Not All You Needed*.

Computer use is a self-similar stack: a screen click decomposes into a browser
action, which decomposes into an HTTP/CLI call, which decomposes into an OS
syscall, which decomposes into a kernel operation, which decomposes into a packet
on the wire. The paper's claim: **every layer's action descends from ONE wallet
signature** — not a fresh credential per layer, but one Ed25519/Solana root whose
signature is threaded down the stack, each layer binding its own action to the
same root via a hash chain.

Here that is literal. `SignedDescent.descend()` takes a top-level intent and a
parenthesised layer path, signs the root once, and produces a chain of per-layer
records where each record's `parent` is the hash of the layer above it and each is
re-signable/verifiable against the SAME wallet pubkey. Tamper with any layer and
the descent fails to verify; swap in a different wallet and it fails to verify.
"""
from __future__ import annotations
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify, sha, UNSIGNED  # noqa: E402

# The layer stack, top (closest to the human) to bottom (closest to the wire).
LAYERS = ("screen", "browser", "cli", "os", "kernel", "packet")
GENESIS = "0" * 64


def _canon(rec: dict) -> bytes:
    core = {k: rec[k] for k in ("layer", "op", "intent", "root", "parent", "seq")}
    return json.dumps(core, sort_keys=True, separators=(",", ":")).encode()


class SignedDescent:
    """One wallet root; a signed action record at every layer it touches."""

    def __init__(self, wallet: Wallet):
        self.wallet = wallet

    def descend(self, intent: str, ops: dict[str, str], layers=LAYERS) -> list[dict]:
        """Produce a hash-chained, per-layer signed descent for `intent`.

        `ops[layer]` is the concrete operation at that layer (e.g. click coords,
        URL, argv, syscall, packet tuple). Every record is signed by the SAME
        wallet and chains to the layer above it.
        """
        root = self.wallet.pub_hex
        chain: list[dict] = []
        parent = GENESIS
        for seq, layer in enumerate(layers):
            rec = {
                "layer": layer,
                "op": ops.get(layer, ""),
                "intent": intent,
                "root": root,          # the one identity every layer descends from
                "parent": parent,      # hash of the layer above -> the descent
                "seq": seq,
            }
            rec["sig"] = self.wallet.sign(_canon(rec))
            chain.append(rec)
            parent = sha(_canon(rec) + rec["sig"].encode())
        return chain


def verify_descent(chain: list[dict], expect_root: str) -> bool:
    """The seal: every layer signed by the SAME root, chained, untampered."""
    if not chain:
        return False
    parent = GENESIS
    for seq, rec in enumerate(chain):
        if rec["seq"] != seq:
            return False
        if rec["root"] != expect_root:   # every layer descends from the one root
            return False
        if rec["parent"] != parent:
            return False
        # signature must verify against the one root, over THIS record
        if rec["sig"] == UNSIGNED:
            return False
        if not verify(expect_root, rec["sig"], _canon(rec)):
            return False
        parent = sha(_canon(rec) + rec["sig"].encode())
    return True
