#!/usr/bin/env python3
"""Reference witness for capability-gated, content-addressed pipes.

This is the inverse of signed outward descent: a producer may compute bytes, but
those bytes are released to a downstream consumer only through an explicit
capability approval. The payload itself stays content-addressed; the ledger
records `piped` or `denied` edges by CID, not by copying payloads into rows.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import sys
from dataclasses import dataclass, field


SECRET = b"aiko-reference-pipe-secret"


def cid(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def approval_token(source_cid: str, target: str) -> str:
    msg = f"{source_cid}|{target}".encode()
    return hmac.new(SECRET, msg, hashlib.sha256).hexdigest()


def approved(source_cid: str, target: str, token: str | None) -> bool:
    if token is None:
        return False
    return hmac.compare_digest(token, approval_token(source_cid, target))


@dataclass
class PipeRuntime:
    blobs: dict[str, bytes] = field(default_factory=dict)
    cache: dict[tuple[str, ...], str] = field(default_factory=dict)
    ledger: list[dict[str, str]] = field(default_factory=list)
    runs: int = 0

    def produce(self, command: tuple[str, ...]) -> str:
        if command in self.cache:
            return self.cache[command]
        result = subprocess.run(command, check=True, capture_output=True)
        value = result.stdout
        key = cid(value)
        self.blobs[key] = value
        self.cache[command] = key
        self.runs += 1
        self.ledger.append({"event": "produced", "cid": key, "command": json.dumps(command)})
        return key

    def pipe(self, source_cid: str, target: str, token: str | None) -> bytes | None:
        if source_cid not in self.blobs:
            raise KeyError(source_cid)
        if not approved(source_cid, target, token):
            self.ledger.append({"event": "denied", "cid": source_cid, "target": target})
            return None
        self.ledger.append({"event": "piped", "cid": source_cid, "target": target})
        return self.blobs[source_cid]


def check(name: str, condition: bool) -> int:
    if condition:
        print(f"ok {name}")
        return 0
    print(f"FAIL {name}", file=sys.stderr)
    return 1


def main() -> int:
    runtime = PipeRuntime()
    command = (sys.executable, "-c", "print('capability pipe payload')")
    first_cid = runtime.produce(command)

    failures = 0
    failures += check("content-addressed stdout", first_cid.startswith("sha256:") and first_cid in runtime.blobs)

    denied = runtime.pipe(first_cid, "downstream:B", None)
    failures += check(
        "fail-closed without approval",
        denied is None and runtime.ledger[-1]["event"] == "denied",
    )

    token = approval_token(first_cid, "downstream:B")
    released = runtime.pipe(first_cid, "downstream:B", token)
    failures += check(
        "approved release is reproducible",
        released == b"capability pipe payload\n" and cid(released) == first_cid,
    )

    second_cid = runtime.produce(command)
    failures += check("identical input is a cache hit", second_cid == first_cid and runtime.runs == 1)

    if failures:
        return 1
    print("pipe_contract witness: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
