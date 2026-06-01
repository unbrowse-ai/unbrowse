"""Proof of indexing — the verifiable freshness primitive of *Unbrowse
Maintenance Network*, cited to The Graph's POI and Filecoin PoRep/PoSt.

A maintainer who claims "this route is indexed and fresh" must produce a proof
anyone can check. Here a Proof of Indexing is a per-indexer, hash-chained, signed
attestation: `{route_id, content_hash, indexed_at, prev, signer, sig}`. The
content hash is content-addressed (sha256 of what the indexer actually fetched),
so a verifier with the same content re-derives the hash and confirms the indexer
truly saw it — not an assertion, a re-computation. Freshness is a window over
`indexed_at`. The chain root is the single commitment the bond secures.
"""
from __future__ import annotations
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify  # noqa: E402

GENESIS = "0" * 64


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _canon(e: dict) -> bytes:
    core = {k: e[k] for k in ("route_id", "content_hash", "indexed_at", "prev", "signer")}
    return json.dumps(core, sort_keys=True, separators=(",", ":")).encode()


class ProofOfIndexing:
    """One indexer's append-only chain of freshness attestations."""

    def __init__(self, wallet: Wallet):
        self.wallet = wallet
        self.chain: list[dict] = []

    def attest(self, route_id: str, content: bytes, indexed_at: int) -> dict:
        prev = _sha(_canon(self.chain[-1]) + self.chain[-1]["sig"].encode()) \
            if self.chain else GENESIS
        e = {"route_id": route_id, "content_hash": _sha(content),
             "indexed_at": indexed_at, "prev": prev, "signer": self.wallet.pub_hex}
        e["sig"] = self.wallet.sign(_canon(e))
        self.chain.append(e)
        return e


def verify_poi(entry: dict, content: bytes) -> bool:
    """Re-derive: does the attested hash match the real content, signed for real?"""
    if _sha(content) != entry["content_hash"]:
        return False
    return verify(entry["signer"], entry["sig"], _canon(entry))


def is_fresh(entry: dict, now: int, ttl: int) -> bool:
    """Freshness window: the attestation must be no older than `ttl`."""
    return 0 <= (now - entry["indexed_at"]) <= ttl
