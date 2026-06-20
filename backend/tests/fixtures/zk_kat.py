#!/usr/bin/env python3
"""Known-answer harness for the declare-zk TS port cross-verification.

Drives the PROVEN reference `paper/reference/zk/binding.py` so the TS port
(`backend/src/services/declare-zk.ts`) can be checked against it both ways:

  py-prove   : given credential + wallet (raw ed25519 priv hex) + ctx [+ k],
               emit {y, root, sig, t, s, ctx} for TS verifyBinding.
  py-verify  : given a full {y, root, sig} binding + {t, s, ctx} proof,
               print "true"/"false" from reference verify_binding.
  scalar     : given credential, print credential_scalar (decimal) + y (hex)
               so the TS modpow / hash port is checked at the scalar level.

Wallet bytes flow as raw 32-byte ed25519 private-key hex so the SAME key signs
in both languages — letting TS-sign↔py-verify and py-sign↔TS-verify cross.

Usage (stdin = JSON args, stdout = JSON result):
  python3 zk_kat.py py-prove   <<< '{"credential_hex":"..","priv_hex":"..","ctx_hex":"..","k":<int optional>}'
  python3 zk_kat.py py-verify  <<< '{"binding":{...},"proof":{...}}'
  python3 zk_kat.py scalar     <<< '{"credential_hex":".."}'
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(__file__)
REF = os.path.abspath(os.path.join(HERE, "..", "..", "..", "paper", "reference"))
sys.path.insert(0, REF)
sys.path.insert(0, os.path.join(REF, "zk"))

import binding as bnd  # noqa: E402
from ed import verify as ed_verify  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402


def _wallet_from_priv(priv_hex: str):
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(priv_hex))
    pub_hex = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    ).hex()
    return priv, pub_hex


def cmd_scalar(args):
    cred = bytes.fromhex(args["credential_hex"])
    x = bnd.credential_scalar(cred)
    y = pow(bnd.G, x, bnd.P)
    return {"x": str(x), "y": hex(y)}


def cmd_py_prove(args):
    cred = bytes.fromhex(args["credential_hex"])
    priv, pub_hex = _wallet_from_priv(args["priv_hex"])
    ctx = bytes.fromhex(args.get("ctx_hex", ""))

    x = bnd.credential_scalar(cred)
    y = pow(bnd.G, x, bnd.P)
    y_hex = hex(y)
    sig = priv.sign(y_hex.encode()).hex()

    # Proof — optionally with a fixed k for a deterministic vector.
    if "k" in args and args["k"] is not None:
        k = int(args["k"])
    else:
        import secrets
        k = secrets.randbelow(bnd.Q - 1) + 1
    t = pow(bnd.G, k, bnd.P)
    e = bnd._int(b"%d|%d|%d|" % (bnd.G, y, t) + ctx) % bnd.Q
    s = (k + e * x) % bnd.Q

    return {
        "binding": {"y": y_hex, "root": pub_hex, "sig": sig},
        "proof": {"t": hex(t), "s": hex(s), "ctx": ctx.hex()},
    }


def cmd_py_verify(args):
    ok = bnd.verify_binding(args["binding"], args["proof"])
    return {"ok": bool(ok)}


def main():
    cmd = sys.argv[1]
    args = json.loads(sys.stdin.read() or "{}")
    out = {
        "scalar": cmd_scalar,
        "py-prove": cmd_py_prove,
        "py-verify": cmd_py_verify,
    }[cmd](args)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
