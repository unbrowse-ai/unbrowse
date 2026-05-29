"""Append-only, hash-chained, signed ledger: the COMMITMENT half.

Each entry is {seq, signer, value_hash, ts, prev, sig}. prev = hash of the prior
entry's canonical bytes, so reordering or editing any past row breaks every entry
after it (the seal atom — Bitcoin hash chain). The value itself lives off-ledger in
the ContentCache; the ledger carries only its content-hash (value off-chain, root
on-chain). The Merkle root over all entries is the single commitment a checkpoint
would publish (Certificate Transparency, RFC 6962).

ed25519 (RFC 8032) signs each entry. If `cryptography` is unavailable the ledger
still hash-chains and Merkle-roots; signing degrades to a recorded marker, never a
faked signature (no fabricated green).
"""
from __future__ import annotations
import hashlib
import json
import os

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey)
    from cryptography.hazmat.primitives import serialization
    _HAVE_ED = True
except Exception:
    _HAVE_ED = False

GENESIS = "0" * 64


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _canon(entry: dict) -> bytes:
    """Canonical bytes of an entry EXCLUDING its own signature (sig signs this)."""
    core = {k: entry[k] for k in ("seq", "signer", "value_hash", "ts", "prev")}
    return json.dumps(core, sort_keys=True, separators=(",", ":")).encode()


def merkle_root(leaves):
    """RFC-6962-style Merkle Tree Hash over entry hashes. Empty -> sha256('')."""
    if not leaves:
        return _sha(b"")
    level = [bytes.fromhex(x) for x in leaves]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                nxt.append(hashlib.sha256(b"\x01" + level[i] + level[i + 1]).digest())
            else:
                nxt.append(level[i])  # odd leaf promoted
        level = nxt
    return level[0].hex()


class SignedLedger:
    def __init__(self, path: str, priv_hex=None):
        self.path = path
        self._priv = None
        self._pub_hex = "unsigned"
        if _HAVE_ED:
            if priv_hex:
                self._priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
            else:
                self._priv = Ed25519PrivateKey.generate()
            pub = self._priv.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            self._pub_hex = pub.hex()

    def _entries(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path) as f:
            return [json.loads(ln) for ln in f if ln.strip()]

    def _sign(self, msg: bytes) -> str:
        if self._priv is None:
            return "__UNSIGNED__"  # honest marker; never a faked sig
        return self._priv.sign(msg).hex()

    def append(self, value_hash: str, ts: int) -> dict:
        entries = self._entries()
        prev = _sha(_canon(entries[-1]) + entries[-1]["sig"].encode()) if entries else GENESIS
        entry = {"seq": len(entries), "signer": self._pub_hex,
                 "value_hash": value_hash, "ts": ts, "prev": prev}
        entry["sig"] = self._sign(_canon(entry))
        with open(self.path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
        return entry

    def verify_chain(self) -> bool:
        """The seal: every prev links, and every signature checks (if signed)."""
        entries = self._entries()
        prev = GENESIS
        for e in entries:
            if e["prev"] != prev:
                return False
            if _HAVE_ED and e["sig"] != "__UNSIGNED__":
                try:
                    Ed25519PublicKey.from_public_bytes(bytes.fromhex(e["signer"])).verify(
                        bytes.fromhex(e["sig"]), _canon(e))
                except Exception:
                    return False
            prev = _sha(_canon(e) + e["sig"].encode())
        return True

    def root(self) -> str:
        """The single on-chain-checkpointable commitment over the whole log."""
        return merkle_root([_sha(_canon(e) + e["sig"].encode()) for e in self._entries()])

    def inclusion(self, seq: int) -> bool:
        """Walk: is entry `seq` actually in the committed log?"""
        entries = self._entries()
        return 0 <= seq < len(entries) and entries[seq]["seq"] == seq
