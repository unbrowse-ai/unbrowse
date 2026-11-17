import unittest
from unittest.mock import patch

from urllib.request import Request

from probe_all_public import BlockedRedirect, RedirectRecorder, classify, observed_link, probe_site, public_redirect_host, summarize


class PublicBatchTests(unittest.TestCase):
    def test_observed_link_skips_actions_queries_and_off_host(self):
        html = '''<a href="/logout">Sign out</a><a href="/checkout">Pay</a>
        <a href="https://elsewhere.test/about">External</a><a href="/search?q=term">Search</a>
        <a href="/about">About</a>'''
        self.assertEqual(observed_link(html, "https://example.test/"), "https://example.test/about")

    def test_challenge_and_content_classification(self):
        self.assertEqual(classify(403, "text/html", ""), "challenge_or_denial")
        self.assertEqual(classify(200, "text/html", "<title>Just a moment</title>"), "possible_challenge")
        self.assertEqual(classify(200, "text/html", "<h1>Welcome</h1>"), "public_html")
        self.assertEqual(classify(202, "text/html", "<h1>Welcome</h1>"), "nonstandard_2xx")

    def test_private_and_special_redirect_hosts_are_rejected(self):
        for target in ("https://127.0.0.1/private", "https://10.0.0.1/", "https://localhost/", "https://intranet.local/"):
            self.assertFalse(public_redirect_host(target))
            recorder = RedirectRecorder()
            with self.assertRaises(BlockedRedirect):
                recorder.redirect_request(Request("https://example.test/"), None, 302, "Found", {}, target)
        with patch("probe_all_public.socket.getaddrinfo", return_value=[(None, None, None, None, ("192.168.1.5", 443))]):
            self.assertFalse(public_redirect_host("https://example.com/"))

    def test_one_observed_route_only(self):
        site = {"domain": "example.test", "tranco_rank": 1, "entrypoint": "https://example.test/"}
        home = {"classification": "public_html", "final_url": "https://example.test/", "redirect_chain": [], "status": 200}
        route = {"classification": "public_html", "final_url": "https://example.test/about", "redirect_chain": [], "status": 200}
        with patch("probe_all_public.fetch", side_effect=[(home, '<a href="/about">About</a><a href="/news">News</a>'), (route, "<h1>About</h1>")]) as mocked:
            result = probe_site(site, 2)
        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(mocked.call_args_list[1].args[0], "https://example.test/about")
        self.assertEqual(result["route"]["classification"], "public_html")
        self.assertEqual(summarize([result])["route_observed_and_attempted"], 1)

    def test_home_failure_yields_outcome_without_route(self):
        site = {"domain": "example.test", "tranco_rank": 1, "entrypoint": "https://example.test/"}
        home = {"classification": "network_error", "final_url": None, "redirect_chain": [], "status": None}
        with patch("probe_all_public.fetch", return_value=(home, None)) as mocked:
            result = probe_site(site, 2)
        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(result["route_skip_reason"], "homepage_network_error")


if __name__ == "__main__":
    unittest.main()
