"""Before a token goes to whatever answers at the node's address, that listener proves it is the node the token is for.

The node answers a fresh challenge with keccak256("unbrowse/node-proof\\n" || token || "\\n" || port (2 bytes, big
endian) || challenge) for the token whose key the asker names (``/v1/node/proof``; ``unbrowse_core::node_proof``). Only a
process holding the token can, so one that took the node's port while it was away (a boot, an update, a crash) never
sees it. Keccak-256 is written out here: ``hashlib``'s ``sha3_256`` pads differently, and the package has no
dependencies.
"""

from __future__ import annotations

from typing import Any, List, Optional
from urllib.parse import urlsplit

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
_MASK = (1 << 64) - 1


def _rol(v: int, n: int) -> int:
    return ((v << n) | (v >> (64 - n))) & _MASK if n else v


def _permute(s: List[int]) -> None:
    for rc in _RC:
        c = [s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20] for x in range(5)]
        for x in range(5):
            d = c[(x + 4) % 5] ^ _rol(c[(x + 1) % 5], 1)
            for y in range(0, 25, 5):
                s[x + y] ^= d
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rol(s[x + 5 * y], _ROT[x + 5 * y])
        for y in range(0, 25, 5):
            for x in range(5):
                s[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & b[(x + 2) % 5 + y])
        s[0] ^= rc


def keccak256(data: bytes) -> bytes:
    """Keccak-256, as Ethereum and the node use it (padding 0x01, not SHA3's 0x06)."""
    rate = 136
    padded = bytearray(data)
    padded.append(0x01)
    padded.extend(b"\x00" * (-len(padded) % rate))
    padded[-1] |= 0x80
    s = [0] * 25
    for off in range(0, len(padded), rate):
        for i in range(rate // 8):
            s[i] ^= int.from_bytes(padded[off + 8 * i: off + 8 * i + 8], "little")
        _permute(s)
    return b"".join(s[i].to_bytes(8, "little") for i in range(4))


def node_proof(token: str, port: int, challenge: bytes) -> str:
    """What the node answers for ``token`` at ``port`` to ``challenge`` (``unbrowse_core::node_proof``), in hex."""
    return keccak256(b"unbrowse/node-proof\n" + token.encode() + b"\n" + port.to_bytes(2, "big") + challenge).hex()


def token_key(token: str) -> str:
    """The name the node finds a token by, without the token (``unbrowse_core::token_key``), in hex."""
    return keccak256(b"unbrowse/node-key\n" + token.encode()).hex()


def port_of(base_url: str) -> Optional[int]:
    """The port a base URL reaches, as the node signs it: the one named, else the scheme's own."""
    try:
        u = urlsplit(base_url)
        if u.port:
            return u.port
    except ValueError:
        return None
    return {"https": 443, "http": 80}.get(u.scheme)


def answer_holds(answer: Any, want: str) -> bool:
    """Whether a proof answer holds ``want``: among the agents' proofs, or as the owner's."""
    if not isinstance(answer, dict):
        return False
    agents = answer.get("agents")
    said = (list(agents) if isinstance(agents, list) else []) + [answer.get("owner"), answer.get("agent")]
    return any(isinstance(p, str) and p.lower().removeprefix("0x") == want for p in said)
