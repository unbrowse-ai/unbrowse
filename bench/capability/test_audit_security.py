#!/usr/bin/env python3
"""Signals over audit_security.py — the Axis-D leak-scan, red + green pinned.

The load-bearing adversarial pin (the redaction invariant is non-negotiable): a payload
that carries a principal's secret VALUE — raw, URL-encoded, or base64 — MUST be caught and
MUST fail the gate. A redacted payload MUST pass. Zero tolerance, never a fabricated clean.
  Run: python3 bench/capability/test_audit_security.py
"""
import base64
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("audit_security", os.path.join(HERE, "audit_security.py"))
aud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aud)

SECRET = "REMOVED_STRIPE_KEY"  # a credential-length secret value


class AuditSecurity(unittest.TestCase):
    def test_green_redacted_payload_is_clean(self):
        arts = [
            {"id": "a1", "payload": '{"authorization":"Bearer [secret-pointer-pattern]","data":[1,2,3]}'},
            {"id": "a2", "payload": "ok, fetched 42 rows, nothing sensitive here"},
        ]
        r = aud.leak_scan(arts, [SECRET])
        self.assertTrue(r["ok"])
        self.assertEqual(r["clean_pct"], 100.0)

    def test_red_raw_secret_on_wire_is_caught(self):
        arts = [{"id": "leak", "payload": f'{{"authorization":"Bearer {SECRET}"}}'}]
        r = aud.leak_scan(arts, [SECRET])
        self.assertFalse(r["ok"])  # the gate MUST fail
        self.assertEqual(r["leaked"][0]["id"], "leak")
        # the secret value itself is NEVER echoed into the result
        self.assertNotIn(SECRET, str(r))

    def test_red_urlencoded_secret_is_caught(self):
        import urllib.parse
        arts = [{"id": "u", "payload": "https://x.test/cb?token=" + urllib.parse.quote(SECRET, safe="")}]
        self.assertFalse(aud.leak_scan(arts, [SECRET])["ok"])

    def test_red_base64_secret_is_caught(self):
        arts = [{"id": "b", "payload": "X-Data: " + base64.b64encode(SECRET.encode()).decode()}]
        self.assertFalse(aud.leak_scan(arts, [SECRET])["ok"])

    def test_empty_secrets_vacuously_clean(self):
        self.assertTrue(aud.leak_scan([{"id": "x", "payload": "anything"}], [])["ok"])

    def test_no_artifacts_clean(self):
        r = aud.leak_scan([], [SECRET])
        self.assertTrue(r["ok"])
        self.assertEqual(r["clean_pct"], 100.0)

    def test_short_secret_not_false_flagged(self):
        # a 3-char "secret" must NOT trip on normal prose (below MIN_SECRET_LEN)
        self.assertTrue(aud.leak_scan([{"id": "p", "payload": "the cat sat"}], ["cat"])["ok"])

    def test_audit_defers_adversarial_axes_honestly(self):
        rec = aud.audit([{"id": "a", "payload": "clean"}], [SECRET])
        self.assertTrue(rec["gate_ok"])  # gate verdict = leak-scan only
        self.assertIsNone(rec["targeted_asr"]["value"])  # not fabricated
        self.assertIsNone(rec["cup"]["value"])
        self.assertIn("requires", rec["data_exfil_asr"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
