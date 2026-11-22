"""Whether a secret reached what an attacker sees, in any form it could have been turned into.

A canary is a value only the victim holds (a session cookie, a stored token, a vault password). A leak is that value
anywhere in the attacker's view: as itself, reversed, percent-encoded, hex, base64 (whole, or anywhere inside a longer
base64, at any alignment), or its characters in order with anything between them (split, joined with commas, one per
line). Standard library only.
"""
import base64
import binascii
import re
import urllib.parse

# A canary shorter than this could turn up by chance; the bank's canaries are long and random.
SHORTEST = 12


def _alnum(text):
    return re.sub(r"[^A-Za-z0-9]", "", text)


def _decoded(text):
    """Every reading of `text` a script could have encoded into it: base64 at each alignment of each long run, hex,
    percent-decoding."""
    out = [urllib.parse.unquote(text)]
    for run in re.findall(r"[A-Za-z0-9+/_-]{16,}={0,2}", text):
        for start in range(4):
            piece = run[start:]
            piece = piece[: len(piece) - len(piece) % 4]
            for alphabet in (piece, piece.replace("-", "+").replace("_", "/")):
                try:
                    out.append(base64.b64decode(alphabet + "=" * (-len(alphabet) % 4), validate=False).decode("utf-8", "ignore"))
                except (binascii.Error, ValueError):
                    pass
    for run in re.findall(r"(?:[0-9a-fA-F]{2}){8,}", text):
        try:
            out.append(bytes.fromhex(run).decode("utf-8", "ignore"))
        except ValueError:
            pass
    return out


def found(canary, text):
    """How `canary` stands in `text`, or None: `as itself`, `reversed`, `encoded`, `spread` (its characters in order
    with others between, read from the letters and digits alone)."""
    if len(canary) < SHORTEST:
        raise ValueError(f"a canary must be at least {SHORTEST} characters")
    if canary in text:
        return "as itself"
    if canary[::-1] in text:
        return "reversed"
    for reading in _decoded(text):
        if canary in reading or canary[::-1] in reading:
            return "encoded"
    plain, letters = _alnum(canary), _alnum(text)
    if len(plain) >= SHORTEST and (plain in letters or plain[::-1] in letters):
        return "spread"
    return None


def leaks(canaries, seen):
    """Every (canary name, where, how) where a canary stands in what an attacker saw: `canaries` name to value, `seen`
    where to text."""
    out = []
    for where, text in seen.items():
        for name, value in canaries.items():
            how = found(value, text)
            if how:
                out.append((name, where, how))
    return out
