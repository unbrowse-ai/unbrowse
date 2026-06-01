"""Shared ed25519 (RFC 8032) helpers for the reference implementation.

Real signatures via `cryptography`. If the library is unavailable, signing
degrades to an honest `__UNSIGNED__` marker and `have_ed()` returns False — never
a faked signature (no fabricated green). Every reference module signs through here
so "one wallet root" is literally one key type across all layers.
"""
from __future__ import annotations
import hashlib

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey)
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    _HAVE_ED = True
except Exception:  # pragma: no cover - environment without crypto
    _HAVE_ED = False

UNSIGNED = "__UNSIGNED__"


def have_ed() -> bool:
    return _HAVE_ED


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class Wallet:
    """One Ed25519/Solana-style identity. The root every layer descends from."""

    def __init__(self, priv_hex: str | None = None):
        self._priv = None
        self.pub_hex = "unsigned"
        if _HAVE_ED:
            if priv_hex:
                self._priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
            else:
                self._priv = Ed25519PrivateKey.generate()
            self.pub_hex = self._priv.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()

    def sign(self, msg: bytes) -> str:
        if self._priv is None:
            return UNSIGNED
        return self._priv.sign(msg).hex()

    def seal_key(self) -> bytes:
        """A 32-byte symmetric key bound to this wallet (HKDF over the raw seed).

        The sealed cache encrypts under this key, so only the holder of the wallet
        can reveal a sealed value. Different wallet -> different key -> stays sealed.
        """
        if self._priv is None:
            raise RuntimeError("no wallet key (cryptography unavailable)")
        raw = self._priv.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption())
        hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                    info=b"unbrowse/sealed-cache/v1")
        return hkdf.derive(raw)


def verify(pub_hex: str, sig_hex: str, msg: bytes) -> bool:
    """True iff `sig_hex` is a real ed25519 signature of `msg` under `pub_hex`."""
    if not _HAVE_ED or sig_hex == UNSIGNED:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub_hex)).verify(
            bytes.fromhex(sig_hex), msg)
        return True
    except Exception:
        return False
