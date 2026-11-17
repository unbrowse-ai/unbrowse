import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from local_chrome import ChromeCDP, report_url, run_auth, scope_allows, secret_ref_valid, read_secret, validate_fixture

HERE = Path(__file__).resolve().parent
INVENTORY = json.loads((HERE / "sites.json").read_text())
DOMAINS = {site["domain"] for site in INVENTORY["sites"]}


class LocalChromeSafetyTests(unittest.TestCase):
    def test_committed_public_fixtures_are_valid(self):
        for name in ("wikipedia", "govuk"):
            fixture = json.loads((HERE / "browser-fixtures" / (name + ".json")).read_text())
            self.assertEqual(validate_fixture(fixture, DOMAINS), [])

    def test_auth_template_valid_with_example_domain(self):
        fixture = json.loads((HERE / "browser-fixtures" / "auth.example.json").read_text())
        self.assertEqual(validate_fixture(fixture, DOMAINS | {"example.test"}), [])

    def test_scope_rejects_host_confusion_and_path_escape(self):
        scopes = ["https://example.com/app"]
        self.assertTrue(scope_allows("https://example.com/app/page", scopes))
        self.assertFalse(scope_allows("https://example.com/application", scopes))
        self.assertFalse(scope_allows("https://example.com.evil.test/app", scopes))
        self.assertFalse(scope_allows("http://example.com/app", scopes))

    def test_fixture_rejects_inline_secret_and_action(self):
        fixture = json.loads((HERE / "browser-fixtures" / "wikipedia.json").read_text())
        fixture["password"] = "forbidden"
        fixture["action"] = {"kind": "message"}
        errors = validate_fixture(fixture, DOMAINS)
        self.assertTrue(any("inline credentials" in error for error in errors))
        self.assertTrue(any("action configuration" in error for error in errors))

    def test_fixture_rejects_out_of_scope_search(self):
        fixture = json.loads((HERE / "browser-fixtures" / "wikipedia.json").read_text())
        fixture["public"]["search_url_template"] = "https://evil.test/?q={query}"
        self.assertTrue(any("search_url_template" in error for error in validate_fixture(fixture, DOMAINS)))

    def test_secret_refs_and_output_redaction(self):
        ref = {"provider": "env", "name": "UNBROWSE_TEST_DUMMY"}
        self.assertTrue(secret_ref_valid(ref))
        self.assertFalse(secret_ref_valid({"provider": "env", "name": "X", "value": "leak"}))
        os.environ["UNBROWSE_TEST_DUMMY"] = "temporary-test-value"
        try:
            self.assertEqual(read_secret(ref), "temporary-test-value")
        finally:
            del os.environ["UNBROWSE_TEST_DUMMY"]
        self.assertEqual(report_url("https://example.com/callback?code=secret#frag"), "https://example.com/callback")

    def test_auth_login_logout_sequence_offline(self):
        fixture = json.loads((HERE / "browser-fixtures" / "auth.example.json").read_text())
        fixture["auth"].pop("mfa")

        class FakeBrowser:
            auth_writes = False
            logged_in = False
            clicks = []

            def navigate(self, url, scenario):
                if url.endswith("/private") and not self.logged_in:
                    final, status = "https://example.test/login", 200
                else:
                    final, status = url, 200
                return {"scenario": scenario, "final_url": final, "status": status}

            def fill(self, selector, value):
                assert value in ("test-user", "test-password")

            def click(self, selector):
                assert self.auth_writes
                self.clicks.append(selector)
                if selector == fixture["auth"]["submit_selector"]:
                    self.logged_in = True
                elif selector == fixture["auth"]["logout_selector"]:
                    self.logged_in = False

            def has_selector(self, selector):
                return self.logged_in and selector == fixture["auth"]["authenticated_marker"]

            def wait_for(self, predicate):
                return predicate()

            def pump(self, seconds):
                pass

        fake = FakeBrowser()
        with patch("local_chrome.read_secret", side_effect=["test-user", "test-password"]):
            results = run_auth(fake, fixture)
        self.assertEqual([r["scenario"] for r in results], ["auth.protected_guest", "auth.login", "auth.logout"])
        self.assertTrue(all(r["assertion_passed"] for r in results))
        self.assertEqual(len(fake.clicks), 2)
        self.assertFalse(fake.auth_writes)

    def test_request_interception_blocks_out_of_scope_documents_and_writes(self):
        class FakeSocket:
            def __init__(self, message):
                self.message = json.dumps(message)
                self.sent = []

            def settimeout(self, value):
                pass

            def recv(self):
                return self.message

            def send(self, value):
                self.sent.append(json.loads(value))

        def intercept(url, verb, resource_type, auth_writes):
            browser = ChromeCDP(Path("/unused/chrome"), ["https://example.test/"], auth_write_scope=["https://example.test/login"])
            browser.auth_writes = auth_writes
            browser.ws = FakeSocket({"method": "Fetch.requestPaused", "params": {"requestId": "1", "request": {"url": url, "method": verb}, "resourceType": resource_type}})
            browser.receive(1)
            return browser.ws.sent[-1]["method"]

        self.assertEqual(intercept("https://evil.test/", "GET", "Document", False), "Fetch.failRequest")
        self.assertEqual(intercept("https://example.test/api", "POST", "XHR", False), "Fetch.failRequest")
        self.assertEqual(intercept("https://example.test/login", "POST", "Document", True), "Fetch.continueRequest")
        self.assertEqual(intercept("https://evil.test/collect", "POST", "XHR", True), "Fetch.failRequest")


if __name__ == "__main__":
    unittest.main()
