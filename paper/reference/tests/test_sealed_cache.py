"""Each test proves one sentence about the sealed-unless-revealed cache."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ed import Wallet, have_ed  # noqa: E402
from ledger.sealed_cache import SealedCache, SealReveal, content_hash  # noqa: E402


def test_addressed_by_plaintext_hash_on_any_host():
    if not have_ed():
        return
    w = Wallet()
    with tempfile.TemporaryDirectory() as d:
        c = SealedCache(d, w)
        h = c.seal(b"a fresh route result")
        assert h == content_hash(b"a fresh route result")   # key IS plaintext hash
        # same content, same wallet, different cache dir on this host -> same key
        with tempfile.TemporaryDirectory() as d2:
            assert SealedCache(d2, w).seal(b"a fresh route result") == h


def test_at_rest_bytes_are_sealed():
    if not have_ed():
        return
    with tempfile.TemporaryDirectory() as d:
        c = SealedCache(d, Wallet())
        secret = b"Authorization: Bearer sk-live-PLAINTEXT"
        h = c.seal(secret)
        blob = c.sealed_bytes(h)
        assert secret not in blob                # ciphertext, not the plaintext
        assert len(blob) > 12                     # nonce + ciphertext+tag


def test_only_the_binding_wallet_reveals():
    if not have_ed():
        return
    with tempfile.TemporaryDirectory() as d:
        owner = Wallet()
        c = SealedCache(d, owner)
        h = c.seal(b"the credential")
        assert c.reveal(h, owner) == b"the credential"   # owner reveals
        try:
            c.reveal(h, Wallet())                          # stranger cannot
            assert False, "a foreign wallet revealed a sealed value"
        except SealReveal:
            pass


def test_tampered_ciphertext_will_not_reveal():
    if not have_ed():
        return
    with tempfile.TemporaryDirectory() as d:
        owner = Wallet()
        c = SealedCache(d, owner)
        h = c.seal(b"x" * 64)
        p = os.path.join(d, h)
        b = bytearray(open(p, "rb").read())
        b[-1] ^= 0x01                              # flip a ciphertext bit
        open(p, "wb").write(bytes(b))
        try:
            c.reveal(h, owner)
            assert False, "tampered ciphertext revealed"
        except SealReveal:
            pass
