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



class Tunnels(unittest.TestCase):
    """The quick tunnel service refuses a second tunnel asked too soon from one address, with no tunnel at all
    ("failed to parse quick Tunnel ID: invalid UUID length: 0", PR check 45350260674): the program ends at once. That
    is asked again after a wait, not waited on for minutes and called "no public address"."""

    def fake(self, d, refusals):
        count = os.path.join(d, "count")
        program = os.path.join(d, "cloudflared")
        with open(program, "w") as f:
            f.write(f"""#!/bin/sh
n=$(cat {count} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > {count}
echo "INF Requesting new quick Tunnel on trycloudflare.com..."
if [ $n -le {refusals} ]; then echo "failed to parse quick Tunnel ID: invalid UUID length: 0"; exit 1; fi
echo "INF |  https://quiet-river-{refusals}.trycloudflare.com  |"
echo "INF Registered tunnel connection connIndex=0"
sleep 30
""")
        os.chmod(program, 0o755)
        return program

    def tunnels(self, program, d):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".github", "qa"))
        import run_attack
        from pathlib import Path
        t = run_attack.Tunnels(program, Path(d))
        t.published_wait, t.poll, t.again_after = 0, 0.05, 0.1
        return t

    def test_a_refused_quick_tunnel_is_asked_again(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            t = self.tunnels(self.fake(d, 2), d)
            try:
                self.assertEqual(t("http://127.0.0.1:1"), "https://quiet-river-2.trycloudflare.com")
            finally:
                t.close()

    def test_a_service_that_keeps_refusing_still_says_so(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            t = self.tunnels(self.fake(d, 99), d)
            try:
                with self.assertRaisesRegex(RuntimeError, "no public address"):
                    t("http://127.0.0.1:1")
            finally:
                t.close()

if __name__ == "__main__":
    unittest.main()
