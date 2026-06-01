"""On-chain Merkle-root checkpoints — *Unbrowse Maintenance Network*'s batching
commitment (Certificate Transparency, RFC 6962; value off-chain, root on-chain).

Many signed ledger entries are batched into ONE Merkle root. Publishing that root
(the maturity ladder's on-chain step) commits to every batched entry at once,
while each entry stays off-chain. An auditor who holds a single leaf plus its
audit path can prove the leaf is included under the published root without seeing
the other leaves — that is the whole point of batching: one cheap on-chain write
secures thousands of off-chain records, each independently provable.

This reference computes the root and the per-leaf inclusion proof and verifies
inclusion against the root. The on-chain publication itself is the deployment
step; the cryptographic commitment it would publish is exactly this root.
"""
from __future__ import annotations
import hashlib


def _h(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def _leaf(data: bytes) -> bytes:
    return _h(b"\x00" + data)   # leaf-prefix, RFC 6962


def _node(l: bytes, r: bytes) -> bytes:
    return _h(b"\x01" + l + r)  # node-prefix, RFC 6962


def build(entries: list[bytes]) -> str:
    """Merkle root over a batch of entries (hex). Empty batch -> sha256('')."""
    if not entries:
        return hashlib.sha256(b"").hexdigest()
    level = [_leaf(e) for e in entries]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                nxt.append(_node(level[i], level[i + 1]))
            else:
                nxt.append(level[i])  # odd leaf promoted
        level = nxt
    return level[0].hex()


def inclusion_proof(entries: list[bytes], index: int) -> list[tuple[str, str]]:
    """Audit path for `entries[index]`: list of (sibling_hex, side) bottom-up."""
    assert 0 <= index < len(entries)
    level = [_leaf(e) for e in entries]
    path: list[tuple[str, str]] = []
    idx = index
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            if i + 1 < len(level):
                if i == idx:
                    path.append((level[i + 1].hex(), "right"))
                elif i + 1 == idx:
                    path.append((level[i].hex(), "left"))
                nxt.append(_node(level[i], level[i + 1]))
            else:
                nxt.append(level[i])  # odd leaf promoted, no sibling
        idx //= 2
        level = nxt
    return path


def verify_inclusion(entry: bytes, proof: list[tuple[str, str]], root: str) -> bool:
    """Recompute the root from the leaf + audit path; must equal `root`."""
    cur = _leaf(entry)
    for sib_hex, side in proof:
        sib = bytes.fromhex(sib_hex)
        cur = _node(sib, cur) if side == "left" else _node(cur, sib)
    return cur.hex() == root
