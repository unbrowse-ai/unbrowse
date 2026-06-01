"""Sealed-unless-revealed content-addressed cache — the privacy half of
*Internal APIs Were Not All You Needed*.

The plain ContentCache is addressed by sha256(plaintext) and stores the payload
in the clear. The sealed cache keeps the same content-addressing — the key is
still sha256 of the PLAINTEXT, so the same content resolves to the same key on
any host — but the bytes at rest are AES-256-GCM ciphertext under a key bound to
the wallet (HKDF over the Ed25519 seed). At-rest bytes are unreadable; only the
holder of the wallet can `reveal()` the plaintext. A different wallet's key fails
the GCM auth tag and the value stays sealed (no fabricated reveal). The AAD is the
content hash, so a ciphertext cannot be relabelled under a different key.
"""
from __future__ import annotations
import hashlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet  # noqa: E402

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAVE_AEAD = True
except Exception:  # pragma: no cover
    _HAVE_AEAD = False


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SealReveal(Exception):
    """Raised when a reveal is attempted by a wallet that does not hold the key."""


class SealedCache:
    """Content-addressed by plaintext hash; sealed (encrypted) at rest."""

    def __init__(self, root: str, wallet: Wallet):
        if not _HAVE_AEAD:
            raise RuntimeError("AES-GCM unavailable (cryptography not installed)")
        self.root = root
        self.wallet = wallet
        self._key = wallet.seal_key()
        os.makedirs(root, exist_ok=True)

    def seal(self, data: bytes) -> str:
        """Store `data` sealed; return its content hash (over the PLAINTEXT)."""
        h = content_hash(data)
        nonce = os.urandom(12)
        ct = AESGCM(self._key).encrypt(nonce, data, h.encode())  # AAD = hash
        with open(os.path.join(self.root, h), "wb") as f:
            f.write(nonce + ct)
        return h

    def sealed_bytes(self, h: str) -> bytes:
        """The at-rest bytes — ciphertext. Readable by no one without the key."""
        with open(os.path.join(self.root, h), "rb") as f:
            return f.read()

    def reveal(self, h: str, wallet: Wallet) -> bytes:
        """Decrypt under `wallet`'s key. Wrong wallet -> stays sealed (raises)."""
        blob = self.sealed_bytes(h)
        nonce, ct = blob[:12], blob[12:]
        try:
            pt = AESGCM(wallet.seal_key()).decrypt(nonce, ct, h.encode())
        except Exception:
            raise SealReveal(f"reveal denied: wallet does not hold the seal key for {h[:8]}")
        if content_hash(pt) != h:  # the seal re-derives; tamper is caught
            raise SealReveal("revealed plaintext does not match content hash")
        return pt
