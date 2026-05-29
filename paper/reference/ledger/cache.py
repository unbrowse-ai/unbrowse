"""Content-addressed cache: the VALUE half. Fetch by hash, order-independent.

A value is stored under sha256(content). The same content always resolves to the
same key on any host — that is what makes "centralized server" just *a* host, not
*the* host. This is the cache atom (LEDGER.md / SOVEREIGN.md): exact, deterministic,
unordered. The ledger references these hashes; it never carries the payload.
"""
import hashlib
import os


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ContentCache:
    def __init__(self, root: str):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def put(self, data: bytes) -> str:
        h = content_hash(data)
        with open(os.path.join(self.root, h), "wb") as f:
            f.write(data)
        return h

    def get(self, h: str) -> bytes:
        with open(os.path.join(self.root, h), "rb") as f:
            return f.read()

    def verify(self, h: str) -> bool:
        """Re-derive the hash from stored bytes; the seal must still hold."""
        try:
            return content_hash(self.get(h)) == h
        except OSError:
            return False
