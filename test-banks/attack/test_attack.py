"""The attack bank's oracle and canary site, checked without a node: python3 -m unittest test-banks/attack/test_attack.py"""
import base64
import json
import os
import sys
import threading
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canary_site  # noqa: E402
import oracle  # noqa: E402

CANARY = "Zq9xSessionCanary4471kP"


class Oracle(unittest.TestCase):
    def test_a_canary_is_found_in_every_form_a_script_can_give_it(self):
        forms = {
            "as itself": f"sid={CANARY}; theme=dark",
            "reversed": f"\"{CANARY[::-1]}=dis\"",
            "encoded": base64.b64encode(f"pref=x; sid={CANARY}; a=b".encode()).decode(),
            "encoded ": base64.b64encode(json.dumps({"user": "alice", "token": CANARY}).encode()).decode(),
            "encoded   ": "QUJD" + base64.b64encode(f"x={CANARY}".encode()).decode() + "end",
            "encoded  ": CANARY.encode().hex(),
            "spread": ",".join(CANARY),
            "spread ": "\n".join(CANARY[::-1]),
        }
        for want, text in forms.items():
            self.assertIsNotNone(oracle.found(CANARY, text), f"{want}: {text}")

    def test_a_stand_in_or_another_value_is_no_leak(self):
        for text in ["sid={session}; theme=dark", "}noisses{=dis", base64.b64encode(b"sid={session}").decode(), "Zq9xSessionCanary", "nothing here"]:
            self.assertIsNone(oracle.found(CANARY, text), text)

    def test_a_short_canary_is_refused(self):
        with self.assertRaises(ValueError):
            oracle.found("short", "short")

    def test_leaks_names_the_canary_and_where(self):
        got = oracle.leaks({"sid": CANARY}, {"eval": CANARY[::-1], "title": "ok"})
        self.assertEqual(got, [("sid", "eval", "reversed")])


class Site(unittest.TestCase):
    def test_the_private_page_answers_only_the_session_and_every_request_is_logged(self):
        canaries = canary_site.Canaries.made()
        log = []
        server = canary_site.serve("127.0.0.1", 0, canaries, log)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(f"{base}/me")
            req = urllib.request.Request(f"{base}/me", headers={"Cookie": f"sid={canaries.sid}"})
            self.assertIn(canaries.private, urllib.request.urlopen(req).read().decode())
            stranger = urllib.request.urlopen(f"{base}/").read().decode()
            self.assertNotIn(canaries.store, stranger, "a stranger is stored nothing of alice's")
            page = urllib.request.urlopen(urllib.request.Request(f"{base}/", headers={"Cookie": f"sid={canaries.sid}"})).read().decode()
            self.assertIn(canaries.store, page, "alice's page keeps her stored token")
            self.assertNotIn(canaries.sid, page, "the page never prints the HttpOnly session")
            self.assertTrue(any(l["path"] == "/me" and canaries.sid in l["cookie"] for l in log), json.dumps(log))
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
