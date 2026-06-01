"""Zero-knowledge credential binding — the central new claim of
*Internal APIs Were Not All You Needed*: prove that a credential (cookie, API
token, keychain entry) is bound to the wallet WITHOUT revealing the credential.

Construction (a textbook, sound, runnable NIZK):

  - Derive a secret scalar  x = H(credential) mod q  from the credential bytes.
  - Public binding point     y = g^x mod p   over the 2048-bit RFC-3526 MODP
    group (discrete log hard, so y reveals nothing about x / the credential).
  - The WALLET signs y (ed25519), binding "this y belongs to this wallet". The
    credential never appears — only y, which is one-way.
  - A non-interactive Schnorr proof of knowledge of x (Fiat-Shamir):
        k random;  t = g^k;  e = H(g, y, t, ctx);  s = k + e*x  (mod q)
    Verifier checks  g^s == t * y^e (mod p)  AND the wallet's signature over y.

A holder who knows the credential can prove it is the one bound to the wallet; a
verifier learns only "yes, bound" — never the credential. Tamper with y, the
proof, or swap the wallet, and verification fails.
"""
from __future__ import annotations
import hashlib
import os
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, verify  # noqa: E402

# RFC 3526 group 14 (2048-bit MODP). p safe prime, q = (p-1)/2, generator g=2.
P = int(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74"
    "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437"
    "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05"
    "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB"
    "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718"
    "3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF", 16)
G = 2
Q = (P - 1) // 2


def _int(b: bytes) -> int:
    return int.from_bytes(hashlib.sha256(b).digest(), "big")


def credential_scalar(credential: bytes) -> int:
    return _int(b"cred:" + credential) % Q


def bind(credential: bytes, wallet: Wallet) -> dict:
    """Public binding: y = g^x, signed by the wallet. Reveals nothing of x."""
    x = credential_scalar(credential)
    y = pow(G, x, P)
    y_hex = hex(y)
    return {"y": y_hex, "root": wallet.pub_hex, "sig": wallet.sign(y_hex.encode())}


def prove(credential: bytes, binding: dict, ctx: bytes = b"") -> dict:
    """NIZK proof of knowledge of the credential behind `binding` (Schnorr/FS)."""
    x = credential_scalar(credential)
    y = int(binding["y"], 16)
    assert pow(G, x, P) == y, "credential does not open this binding"
    k = secrets.randbelow(Q - 1) + 1
    t = pow(G, k, P)
    e = _int(b"%d|%d|%d|" % (G, y, t) + ctx) % Q
    s = (k + e * x) % Q
    return {"t": hex(t), "s": hex(s), "ctx": ctx.hex()}


def verify_binding(binding: dict, proof: dict) -> bool:
    """True iff the proof shows knowledge of the bound credential AND the wallet
    signed the binding — without the credential ever being transmitted."""
    try:
        y = int(binding["y"], 16)
        t = int(proof["t"], 16)
        s = int(proof["s"], 16)
        ctx = bytes.fromhex(proof["ctx"])
        # 1. the wallet really bound this y
        if not verify(binding["root"], binding["sig"], binding["y"].encode()):
            return False
        # 2. Schnorr: g^s == t * y^e (mod p)
        e = _int(b"%d|%d|%d|" % (G, y, t) + ctx) % Q
        return pow(G, s, P) == (t * pow(y, e, P)) % P
    except Exception:
        return False
