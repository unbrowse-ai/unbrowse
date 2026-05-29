"""Prove the paper's claims by running them. Each test = one whitepaper sentence."""
import os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ledger.cache import ContentCache, content_hash
from ledger.ledger import SignedLedger, merkle_root


def test_cache_is_content_addressed():
    with tempfile.TemporaryDirectory() as d:
        c = ContentCache(d)
        h = c.put(b"a signed plan")
        assert h == content_hash(b"a signed plan")          # key IS the content hash
        assert c.get(h) == b"a signed plan"
        assert c.verify(h)                                   # seal re-derives
        # same content -> same key, on any host (order-independent)
        assert ContentCache(d).put(b"a signed plan") == h


def test_value_offchain_root_onchain():
    """Ledger carries only the hash; the value lives in the cache."""
    with tempfile.TemporaryDirectory() as d:
        cache = ContentCache(os.path.join(d, "cache"))
        led = SignedLedger(os.path.join(d, "led.jsonl"))
        vh = cache.put(b"endpoint result: 42 routes")        # big value -> cache
        e = led.append(vh, ts=1000)                          # tiny commitment -> ledger
        # the payload is NOT in the ledger; only its hash is
        assert e["value_hash"] == vh
        raw = open(os.path.join(d, "led.jsonl")).read()
        assert b"endpoint result".hex() not in raw and "endpoint result" not in raw


def test_append_only_hash_chain_is_tamper_evident():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "led.jsonl")
        led = SignedLedger(p)
        for i in range(5):
            led.append(content_hash(f"v{i}".encode()), ts=1000 + i)
        assert led.verify_chain()                            # honest chain verifies
        root_before = led.root()
        # tamper: edit a past row's value_hash
        lines = open(p).read().splitlines()
        lines[2] = lines[2].replace(content_hash(b"v2"), content_hash(b"EVIL"))
        open(p, "w").write("\n".join(lines) + "\n")
        assert not led.verify_chain()                        # break is detected
        assert led.root() != root_before                     # root changes -> auditor sees it


def test_ed25519_signatures_real():
    with tempfile.TemporaryDirectory() as d:
        led = SignedLedger(os.path.join(d, "led.jsonl"))
        led.append(content_hash(b"x"), ts=1)
        assert led.verify_chain()
        assert led._pub_hex != "unsigned"                    # real key, not degraded
        e = led._entries()[0]
        assert e["sig"] != "__UNSIGNED__" and len(e["sig"]) == 128  # 64-byte ed25519 sig


def test_inclusion_and_merkle_root_deterministic():
    with tempfile.TemporaryDirectory() as d:
        led = SignedLedger(os.path.join(d, "led.jsonl"))
        for i in range(4):
            led.append(content_hash(f"r{i}".encode()), ts=i)
        assert led.inclusion(0) and led.inclusion(3)
        assert not led.inclusion(4)
        # root is a deterministic function of the entries
        assert led.root() == merkle_root(
            [__import__("ledger.ledger", fromlist=["_sha","_canon"])._sha(
                __import__("ledger.ledger", fromlist=["_canon"])._canon(e) + e["sig"].encode())
             for e in led._entries()])


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(fns)} green")
    sys.exit(0 if passed == len(fns) else 1)
