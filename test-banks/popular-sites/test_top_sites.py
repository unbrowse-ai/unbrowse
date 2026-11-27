"""Offline tests of the top-1,000 bank (UNB-260): its inventory, its cases, its shards, its report, and the page read
run_bank.py makes of a site with no search. No network: every page and every node is a table here."""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import hard_sites
import run_bank
import top_sites

HERE = Path(__file__).resolve().parent


def record(domain, rank=1, **over):
    base = {"rank": rank, "domain": domain, "tried": [{"url": f"https://{domain}/", "status": 200, "error": None}], "status": 200,
            "final_url": f"https://www.{domain}/", "final_registrable": domain, "content_type": "text/html", "bytes": 40000, "error": None,
            "challenge": False, "title": domain, "words": 900, "scripts": 12, "loads": {}, "links": {}, "values": ["kettles", "teapots", "spoons"]}
    base.update(over)
    return base


class Inventory(unittest.TestCase):
    def test_a_host_belongs_to_its_domain_under_a_two_part_suffix(self):
        self.assertEqual(top_sites.registrable("www.shop.co.uk"), "shop.co.uk")
        self.assertEqual(top_sites.registrable("a.b.shop.com"), "shop.com")
        self.assertEqual(top_sites.registrable("news.example.com.br"), "example.com.br")

    def test_a_domain_nothing_answers_at_is_passed_over(self):
        r = record("cdn.test", status=None, tried=[{"url": "https://cdn.test/", "status": None, "error": "no_address"}, {"url": "https://www.cdn.test/", "status": None, "error": "no_address"}])
        self.assertEqual(top_sites.passed_over(r, {}, 10)[0], "unreachable")

    def test_a_domain_nothing_answers_at_that_front_pages_link_to_stays_in(self):
        # Regression (UNB-260 probe, 22 Nov 2026): the probe's machine resolves no address for one of the list's top
        # search engines, and it was passed over as an API host. Front pages link to it: it is a site, and the node on
        # the same machine meets the same failure, which the run then counts.
        pages = [record(f"s{n}.test", links={"engine.test": 1}) for n in range(2)]
        loaded, count = top_sites.third_party_hosts(pages)
        r = record("engine.test", status=None, tried=[{"url": "https://engine.test/", "status": None, "error": "no_address"}])
        self.assertIsNone(top_sites.passed_over(r, loaded, count))
        self.assertEqual(top_sites.passed_over(r, {}, count)[0], "unreachable")

    def test_a_front_page_that_hands_visitors_to_another_domain_is_redirect_only(self):
        r = record("short.test", final_url="https://www.long.test/", final_registrable="long.test")
        prop, why = top_sites.passed_over(r, {}, 10)
        self.assertEqual(prop, "redirect_only")
        self.assertIn("long.test", why)

    def test_a_host_other_pages_load_and_nobody_links_to_is_not_a_site(self):
        pages = [record(f"s{n}.test", loads={"pixel.test": 3}, links={}) for n in range(40)]
        loaded, count = top_sites.third_party_hosts(pages)
        self.assertEqual(top_sites.passed_over(record("pixel.test", values=[]), loaded, count)[0], "loaded_not_visited")

    def test_a_host_other_pages_load_and_link_to_is_a_site(self):
        # A video site's player is embedded everywhere, and its own pages are linked to as often.
        pages = [record(f"s{n}.test", loads={"video.test": 1}, links={"video.test": 1}) for n in range(40)]
        loaded, count = top_sites.third_party_hosts(pages)
        self.assertIsNone(top_sites.passed_over(record("video.test"), loaded, count))

    def test_a_refusal_that_is_still_a_titled_page_is_a_site_to_face(self):
        # Regression (UNB-260 probe, 22 Nov 2026): a front page answering a script 400 with an HTML "Error" page was
        # passed over as no page, and with it one of the top five sites on the list.
        r = record("social.test", status=400, title="Error", words=23, bytes=1542, scripts=1, values=[])
        self.assertIsNone(top_sites.passed_over(r, {}, 10))

    def test_a_wall_is_a_site_to_face(self):
        self.assertIsNone(top_sites.passed_over(record("walled.test", status=403, challenge=True, title="Just a moment..."), {}, 10))

    def test_nothing_at_the_root_is_no_page(self):
        self.assertEqual(top_sites.passed_over(record("api.test", status=404, title="Not Found"), {}, 10)[0], "no_page")
        self.assertEqual(top_sites.passed_over(record("api2.test", status=403, title=""), {}, 10)[0], "no_page")

    def test_a_titled_check_page_behind_a_401_is_a_site_to_face(self):
        # Regression (UNB-260 probe, 22 Nov 2026): "Checking your browser before accessing ..." came back 401 and was
        # passed over as a password prompt.
        r = record("photos.test", status=401, title="Checking your browser before accessing photos.test")
        self.assertIsNone(top_sites.passed_over(r, {}, 10))

    def test_an_untitled_refusal_other_front_pages_link_to_is_a_site_to_face(self):
        # Regression (UNB-260 probe, 22 Nov 2026): a news site's bare "403" and a design site's empty 403 were passed
        # over as no page, though other front pages link to them.
        pages = [record(f"s{n}.test", links={"design.test": 1}) for n in range(3)]
        loaded, count = top_sites.third_party_hosts(pages)
        r = record("design.test", status=403, title="", content_type="text/html", bytes=453, words=0)
        self.assertIsNone(top_sites.passed_over(r, loaded, count))
        self.assertEqual(top_sites.passed_over(r, {}, count)[0], "no_page")

    def test_what_did_not_answer_or_stopped_at_a_redirect_is_probed_again(self):
        # Regression (UNB-260 probe, 22 Nov 2026): 48 lookups at once got "no address" for a top-ten domain, and a
        # front page that sets a cookie and redirects to itself ended the probe at a 307.
        self.assertTrue(top_sites.again(record("gone.test", status=None)))
        self.assertTrue(top_sites.again(record("loop.test", status=307)))
        self.assertFalse(top_sites.again(record("fine.test")))
        self.assertFalse(top_sites.again(record("walled.test", status=403)))

    def test_a_page_that_is_not_html_is_no_page(self):
        r = record("json.test", content_type="application/json")
        del r["words"]
        self.assertEqual(top_sites.passed_over(r, {}, 10)[0], "no_page")

    def test_a_tiny_page_with_no_script_is_parked(self):
        self.assertEqual(top_sites.passed_over(record("parked.test", bytes=200, scripts=0), {}, 10)[0], "no_page")


class Cases(unittest.TestCase):
    def test_a_declared_search_with_three_link_words_is_a_search_case(self):
        case = top_sites.case_for(record("shop.test", search={"template": "https://www.shop.test/s?q={q}", "source": "search_action"}), {})
        self.assertEqual(case["kind"], "search")
        self.assertEqual(case["url"], "https://www.shop.test/s?q={q}")
        self.assertEqual(case["values"], ["kettles", "teapots", "spoons"])
        self.assertEqual(case["url_source"], "page:search_action")

    def test_a_site_with_no_search_is_a_page_read(self):
        case = top_sites.case_for(record("news.test"), {})
        self.assertEqual((case["kind"], case["url"], case["values"]), ("read", "https://www.news.test/", []))

    def test_a_search_with_too_few_words_to_ask_is_a_page_read(self):
        case = top_sites.case_for(record("thin.test", values=["one"], search={"template": "https://thin.test/?q={q}", "source": "form"}), {})
        self.assertEqual(case["kind"], "read")
        self.assertIn("1 words", case["why_read"])

    def test_the_banks_own_case_wins_over_one_made_from_the_page(self):
        known = {"shop.test": {"site": "www.shop.test", "goal": "search the shop", "url": "https://www.shop.test/find?k={q}", "values": ["a", "b", "c"], "url_source": "known"}}
        case = top_sites.case_for(record("shop.test", search={"template": "https://www.shop.test/s?q={q}", "source": "form"}), known)
        self.assertEqual(case["url"], "https://www.shop.test/find?k={q}")

    def test_every_hand_checked_case_is_found_by_its_domain(self):
        known = top_sites.known_cases()
        self.assertIn("pypi.org", known)
        self.assertTrue(all("{q}" in c["url"] for c in known.values()))

    def test_a_search_action_is_read_as_a_template(self):
        block = '{"@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https://www.shop.test/s?q={search_term_string}","query-input":"required name=search_term_string"}}'
        self.assertEqual(top_sites.search_action([block]), "https://www.shop.test/s?q={q}")

    def test_an_opensearch_description_drops_its_optional_parameters(self):
        xml = '<OpenSearchDescription><Url type="text/html" template="https://shop.test/search?q={searchTerms}&amp;page={startPage?}"/></OpenSearchDescription>'
        self.assertEqual(top_sites.opensearch_template(xml), "https://shop.test/search?q={q}")

    def test_an_opensearch_url_with_a_required_parameter_makes_no_template(self):
        xml = '<Url type="text/html" template="https://shop.test/search?q={searchTerms}&amp;lang={language}"/>'
        self.assertIsNone(top_sites.opensearch_template(xml))

    def test_a_get_form_with_a_search_box_keeps_its_short_hidden_inputs_and_not_its_token(self):
        form = {"action": "https://shop.test/search", "method": "get", "role": "", "inputs": [
            {"name": "cat", "type": "hidden", "value": "all", "role": "", "aria": ""},
            {"name": "csrf_token", "type": "hidden", "value": "abc", "role": "", "aria": ""},
            {"name": "q", "type": "text", "value": "", "role": "", "aria": "search"}]}
        self.assertEqual(top_sites.form_template(form), "https://shop.test/search?cat=all&q={q}")

    def test_a_post_form_is_no_search_address(self):
        form = {"action": "https://shop.test/login", "method": "post", "role": "", "inputs": [{"name": "q", "type": "search", "value": "", "role": "", "aria": ""}]}
        self.assertIsNone(top_sites.form_template(form))

    def test_link_words_leave_out_the_menu_and_the_sites_own_name(self):
        words = top_sites.link_words(["Home", "Login", "Kettles", "Kettles", "Teapots", "Shopname deals", "Privacy"], "shopname.test")
        self.assertEqual(words[:2], ["kettles", "teapots"])
        self.assertNotIn("home", words)
        self.assertNotIn("shopname", words)

    def test_a_page_that_drips_its_body_is_cut_off_at_the_deadline(self):
        # Regression (UNB-260 probe, 22 Nov 2026): one front page sent its body slowly enough that every read stayed
        # inside its timeout, and the probe of 2,500 pages stood still on it for minutes.
        class Drip:
            def read1(self, n):
                time.sleep(0.01)
                return b"x"
        started = time.monotonic()
        body = top_sites.read_until(Drip(), time.monotonic() + 0.1)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertGreater(len(body), 0)

    def test_a_front_page_is_read_for_its_search_and_words(self):
        doc = ('<html><head><title>Shop</title><link rel="search" type="application/opensearchdescription+xml" href="/os.xml">'
               '<script src="https://cdn.other.test/a.js"></script></head><body><a href="/c/kettles">Kettles</a>'
               '<a href="https://social.test/shop">Follow</a><form action="/s"><input name="q" type="search"></form></body></html>')
        page = top_sites.Page("https://www.shop.test/")
        page.feed(doc)
        self.assertEqual(page.title, "Shop")
        self.assertEqual(page.opensearch, ["https://www.shop.test/os.xml"])
        self.assertEqual(dict(page.loads), {"other.test": 1})
        self.assertEqual(page.links["social.test"], 1)
        self.assertEqual(top_sites.form_template(page.forms[0]), "https://www.shop.test/s?q={q}")


class Build(unittest.TestCase):
    def test_the_first_web_facing_domains_in_rank_order_with_every_other_one_said_why(self):
        rows = [(1, "a.test"), (2, "gone.test"), (3, "b.test"), (4, "jump.test"), (5, "c.test")]
        records = [record("a.test", 1), record("gone.test", 2, status=None), record("b.test", 3),
                   record("jump.test", 4, final_registrable="a.test", final_url="https://a.test/"), record("c.test", 5)]
        kept, dropped = top_sites.build(rows, records, want=3, known={})
        self.assertEqual([c["site"] for c in kept], ["a.test", "b.test", "c.test"])
        self.assertEqual([c["tranco_rank"] for c in kept], [1, 3, 5])
        self.assertEqual([(d["domain"], d["property"]) for d in dropped], [("gone.test", "unreachable"), ("jump.test", "redirect_only")])

    def test_two_domains_that_share_a_hand_checked_case_are_read_once(self):
        known = {"a.test": {"site": "a.test", "goal": "g", "url": "https://a.test/?q={q}", "values": ["x", "y", "z"]},
                 "b.test": {"site": "a.test", "goal": "g", "url": "https://a.test/?q={q}", "values": ["x", "y", "z"]}}
        kept, dropped = top_sites.build([(1, "a.test"), (2, "b.test"), (3, "c.test")], [record("a.test"), record("b.test"), record("c.test")], want=2, known=known)
        self.assertEqual([c["site"] for c in kept], ["a.test", "b.test"])
        self.assertEqual(kept[1]["registrable"], "b.test")

    def test_too_few_probed_domains_stops_the_build(self):
        with self.assertRaises(SystemExit):
            top_sites.build([(1, "a.test")], [record("a.test")], want=2, known={})

    def test_an_unprobed_domain_stops_the_build(self):
        with self.assertRaises(SystemExit):
            top_sites.build([(1, "a.test"), (2, "b.test")], [record("a.test")], want=2, known={})


class InventoryFile(unittest.TestCase):
    """top-1000.json as committed."""

    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads((HERE / "top-1000.json").read_text())

    def test_it_holds_a_thousand_sites_in_rank_order_from_the_recorded_list(self):
        cases = self.doc["cases"]
        self.assertEqual(len(cases), 1000)
        ranks = [c["tranco_rank"] for c in cases]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(self.doc["source"]["sha256_full_csv"], json.loads((HERE / "sites.json").read_text())["source"]["sha256_full_csv"])

    def test_every_site_is_named_once_and_every_case_can_be_judged(self):
        names = [c["site"] for c in self.doc["cases"]]
        self.assertEqual(len(names), len(set(names)))
        for case in self.doc["cases"]:
            if case.get("kind") == "read":
                self.assertTrue(case["url"].startswith(("https://", "http://")), case)  # a front page may land on plain http (google.cn)
                self.assertNotIn("{q}", case["url"])
            else:
                self.assertIn("{q}", case["url"], case)
                self.assertGreaterEqual(len(case["values"]), 3, case)

    def test_every_domain_passed_over_says_which_property_and_why(self):
        for entry in self.doc["passed_over"]:
            self.assertIn(entry["property"], ("unreachable", "redirect_only", "loaded_not_visited", "no_page", "same_site"))
            self.assertTrue(entry["why"])
        self.assertEqual(self.doc["counts"]["passed_over"], len(self.doc["passed_over"]))
        listed = {c["tranco_rank"] for c in self.doc["cases"]} | {d["rank"] for d in self.doc["passed_over"]}
        self.assertEqual(listed, set(range(1, self.doc["ranks_read"] + 1)))

    def test_its_shards_cover_every_site_once(self):
        names = [c["site"] for c in self.doc["cases"]]
        got = [s for n in range(50) for s in hard_sites.shard(names, n, 50)]
        self.assertEqual(sorted(got), sorted(names))

    def test_a_pilot_reads_the_first_sites_only(self):
        listed = top_sites.listed_cases(HERE / "top-1000.json", 20)
        got = [s for n in range(5) for s in hard_sites.shard([c["site"] for c in listed], n, 5)]
        self.assertEqual(sorted(got), sorted(c["site"] for c in self.doc["cases"][:20]))


def page(*lines, title="Front"):
    return {"title": title, "state": None, "text": "\n".join(lines)}


FRONT = page("Top stories today", "Markets rally on rate news", "Storm moves up the coast", "New phone reviewed", "Local team wins final", "Weather for the week")
ROUTE = {"id": "r1", "site": "news.test", "method": "GET", "path": "/", "write": False, "inputs": []}


class ReadNode:
    """A node that answers a page read from a list of replies, one per ask, keeping each ask."""

    def __init__(self, dos, calls=None, route=ROUTE):
        self.dos, self.calls_left, self.route, self.asked = list(dos), list(calls or []), route, []

    def routes(self):
        return []

    def do(self, goal, url):
        self.asked.append(("do", url))
        how, data = self.dos.pop(0)
        return 200, {"how": how, "route": self.route, "result": {"ok": True, "data": data, "browser": False}}

    def call(self, route_id, inputs):
        self.asked.append(("call", inputs))
        return 200, {"ok": True, "data": self.calls_left.pop(0) if self.calls_left else FRONT, "browser": False}


class Files:
    def __init__(self):
        pass

    def counts(self):
        return {"refused": None}

    def node_log_lines(self):
        return []

    def guard_lines(self):
        return []

    def model_lines(self):
        return []

    def chrome_left(self):
        return None

    def steps(self, route_id):
        return []

    def walked_calls(self, since):
        return []


CASE = {"site": "news.test", "kind": "read", "goal": "read the main content of news.test's front page", "url": "https://www.news.test/", "values": []}


class PageRead(unittest.TestCase):
    def test_a_page_read_learned_then_called_twice_with_the_same_words_is_right(self):
        node = ReadNode([("learned", FRONT), ("called", FRONT)])
        site = run_bank.run_site(node, CASE, "zqnonsense", Files(), gap=0)
        self.assertEqual([c["step"] for c in site["checks"]], ["first", "replay", "recheck"])
        self.assertEqual([c["outcome"] for c in site["checks"]], ["pass", "pass", "pass"])
        self.assertEqual(run_bank.judge_site(site["checks"]), "pass")
        self.assertEqual(hard_sites.label(site)[0], "right")
        self.assertEqual(node.asked[-1], ("call", {}))

    def test_a_page_with_too_few_words_is_wrong(self):
        thin = page("Loading")
        site = run_bank.run_site(ReadNode([("learned", thin), ("called", thin)], [thin]), CASE, "zq", Files(), gap=0)
        self.assertEqual(site["checks"][0]["why"], "too_little_to_read")
        self.assertEqual(hard_sites.label(site)[0], "wrong")

    def test_a_second_ask_that_learns_again_is_no_reuse(self):
        site = run_bank.run_site(ReadNode([("learned", FRONT), ("learned", FRONT)]), CASE, "zq", Files(), gap=0)
        self.assertEqual(site["checks"][1]["why"], "replay_was_not_a_call_of_the_same_route")
        self.assertEqual(hard_sites.label(site)[0], "wrong")

    def test_a_call_that_answers_another_page_is_unstable(self):
        other = page("Sign up for our newsletter", "Privacy choices", "Cookie settings", "Your account", "Help centre", "Contact us")
        site = run_bank.run_site(ReadNode([("learned", FRONT), ("called", FRONT)], [other]), CASE, "zq", Files(), gap=0)
        self.assertEqual((site["checks"][2]["outcome"], site["checks"][2]["why"]), ("unstable", "reads_differently_now"))

    def test_a_wall_on_the_first_ask_stops_the_read_and_is_walled(self):
        wall = page("Just a moment...", "Verify you are human", "Checking your browser", "Ray ID", "Performance by Cloudflare", "Privacy")
        node = ReadNode([("learned", wall)])
        site = run_bank.run_site(node, CASE, "zq", Files(), gap=0)
        self.assertEqual(len(site["checks"]), 1)
        self.assertEqual(site["stopped"], "blocked")
        self.assertEqual(hard_sites.label(site)[0], "walled")
        self.assertEqual(len(node.asked), 1)

    def test_a_read_that_used_the_browser_on_a_warm_call_needs_a_browser(self):
        class Browsing(ReadNode):
            def call(self, route_id, inputs):
                return 200, {"ok": True, "data": FRONT, "browser": True}
        site = run_bank.run_site(Browsing([("learned", FRONT), ("called", FRONT)]), CASE, "zq", Files(), gap=0)
        self.assertEqual(hard_sites.label(site)[0], "needs a browser")

    def test_a_read_route_is_not_taken_for_the_page_by_an_empty_value(self):
        # The page read has no value; an empty one stood in for every path segment and called any route the page.
        self.assertFalse(run_bank.same_page("/api/feed", "https://www.news.test/", "\x00"))
        self.assertTrue(run_bank.same_page("/", "https://www.news.test/", "\x00"))

    def test_a_search_sites_checks_still_need_all_five_steps(self):
        checks = [{"step": s, "outcome": "pass"} for s in ("first", "replay", "recheck")]
        self.assertEqual(run_bank.judge_site(checks), "fail")


class Report(unittest.TestCase):
    def test_a_case_with_no_hard_entry_is_reported(self):
        # Regression (UNB-260): hard_sites.report read case["hard"]["gate"], which only the 30 hardest sites carry.
        result = hard_sites.report([CASE], {}, {}, {})
        self.assertEqual(result["rows"][0]["gate"], "read")
        self.assertEqual(result["counts"]["unknown"], 1)

    def test_the_report_counts_labels_hours_and_reasons(self):
        right = run_bank.run_site(ReadNode([("learned", FRONT), ("called", FRONT)]), CASE, "zq", Files(), gap=0)
        thin = page("Loading")
        other_case = dict(CASE, site="thin.test", url="https://thin.test/")
        wrong = run_bank.run_site(ReadNode([("learned", thin), ("called", thin)], [thin]), other_case, "zq", Files(), gap=0)
        third = dict(CASE, site="never.test", url="https://never.test/")
        result = top_sites.top_report([CASE, other_case, third], {"news.test": right, "thin.test": wrong}, {}, {"news.test": 3000, "thin.test": 600},
                                      memory={"0": {"shard": "0", "peak_mb": 2100}})
        self.assertEqual(result["counts"], {"right": 1, "wrong": 1, "needs a browser": 0, "walled": 0, "unknown": 1})
        self.assertEqual(result["seconds"]["hours"], 1.0)
        reasons = dict(result["reasons"])
        self.assertEqual(reasons["wrong: first ok_but_wrong (too_little_to_read)"], 1)
        self.assertEqual(reasons["unknown: no record"], 1)
        text = top_sites.top_markdown(result)
        self.assertIn("1 right, 1 wrong, 0 need a browser, 0 walled, 1 unknown, of 3", text)
        self.assertIn("2100 MB", text)

    def test_the_report_reads_the_files_a_run_leaves(self):
        right = run_bank.run_site(ReadNode([("learned", FRONT), ("called", FRONT)]), CASE, "zq", Files(), gap=0)
        with tempfile.TemporaryDirectory() as tmp:
            shard = Path(tmp) / "top-sites-0"
            shard.mkdir()
            (shard / "reads-0.json").write_text(json.dumps({"sites": [right]}))
            (shard / "times-0.jsonl").write_text(json.dumps({"site": "news.test", "seconds": 42, "capped": False}) + "\n")
            (shard / "memory-0.json").write_text(json.dumps({"shard": "0", "peak_mb": 1800}))
            listed = Path(tmp) / "list.json"
            listed.write_text(json.dumps({"cases": [CASE]}))
            out = Path(tmp) / "r.json"
            self.assertEqual(top_sites.main(["report", "--list", str(listed), "--reads", tmp, "--json", str(out)]), 0)
            got = json.loads(out.read_text())
        self.assertEqual(got["counts"]["right"], 1)
        self.assertEqual(got["seconds"]["total"], 42)
        self.assertEqual(got["memory"]["0"]["peak_mb"], 1800)


# A stand-in for a debug node with no browser, as on a runner with no Chrome installed: it answers health, says an agent
# key, and fetches a browser only once asked to (`download_browser`), as a node does since the browser became an
# add-on. It answers compact JSON, as the node (serde) does. MODE is "fetch" (the fetch ends with a browser at CHROME) or "fail" (it ends with the node's error).
NO_BROWSER_NODE = r"""#!/bin/sh
if [ "$1 $2" = "agent new" ]; then echo 'made agent 1: its key is `unbrowse-node agent token 1`'; exit 0; fi
if [ "$1 $2 $3" = "agent token 1" ]; then echo "unb_fake_token_for_tests"; exit 0; fi
if [ "$1" = agent ]; then exit 1; fi
echo stand-in-owner > "$UNBROWSE_HOME/owner.token"
exec /usr/bin/python3 -c '
import http.server, json, os
port = json.load(open(os.environ["UNBROWSE_HOME"] + "/settings.json"))["api_port"]
asked = []
class Node(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.reply(b"")
    def do_POST(self):
        cmd = self.path.rsplit("/", 1)[-1]
        open("ASKED", "a").write(cmd + "\n")
        if cmd == "download_browser":
            asked.append(cmd)
        fetching = len(asked) > 0 and cmd == "download_browser"
        done = len(asked) > 0 and not fetching
        using = "CHROME" if done and "MODE" == "fetch" else None
        error = "downloading Chrome for Testing: no route to the download host" if done and "MODE" == "fail" else None
        self.reply(json.dumps({"using": using, "chosen": None, "found": [], "downloading": fetching, "download_error": error,
                               "program": "/x/guard-browser", "state": "present" if using else "missing", "fetch": True}, separators=(",", ":")).encode())
    def reply(self, body):
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass
http.server.HTTPServer(("127.0.0.1", port), Node).serve_forever()
'
"""


@unittest.skipUnless(Path("/usr/bin/python3").exists(), "the stand-in node runs under /usr/bin/python3")
@unittest.skipIf(Path("/Applications/Google Chrome.app").exists(), "scratch-node.sh takes the Chrome installed here")
class ScratchNodeWithNoChrome(unittest.TestCase):
    """scratch-node.sh on a machine with no Chrome, as Lewis's runners are: the node is asked to fetch one."""

    def start(self, mode):
        folder = Path(tempfile.mkdtemp(prefix="snc"))
        self.addCleanup(shutil.rmtree, folder, True)
        chrome = folder / "fetched-chrome"
        chrome.write_text("#!/bin/sh\n")
        chrome.chmod(0o755)
        node = folder / "target" / "debug" / "unbrowse-node"
        node.parent.mkdir(parents=True)
        node.write_text(NO_BROWSER_NODE.replace("ASKED", str(folder / "asked")).replace("CHROME", str(chrome)).replace("MODE", mode))
        node.chmod(0o755)
        signing = folder / "signing"
        signing.write_text("#!/bin/sh\nexit 0\n")
        signing.chmod(0o755)
        # The caller's path holds the tools the script uses and no Chrome, whatever this machine has installed.
        bin_dir = folder / "bin"
        bin_dir.mkdir()
        for tool in ("sh", "env", "curl", "sed", "cat", "mkdir", "chmod", "dirname", "sleep", "kill", "head", "grep", "nohup", "tail", "printf", "rm"):
            found = shutil.which(tool)
            if found:
                (bin_dir / tool).symlink_to(found)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        run = folder / "run"
        done = subprocess.run([str(bin_dir / "sh"), str(HERE / "scratch-node.sh"), str(run)], capture_output=True, text=True, timeout=120,
                              env={"PATH": str(bin_dir), "PORT": str(port), "NODE": str(node), "BROWSER_PROGRAM": str(signing), "SIGNING_PROGRAM": str(signing)})
        pid = run / "node.pid"
        self.addCleanup(lambda: pid.exists() and subprocess.run(["kill", pid.read_text().strip()], check=False))
        asked = (folder / "asked").read_text().split() if (folder / "asked").exists() else []
        return done, run, chrome, asked

    def test_a_node_with_no_browser_is_asked_to_fetch_one_and_browses_through_it(self):
        # Regression (UNB-260 local pilot, 22 Nov 2026): the node fetches nothing when it starts, and the script only
        # read the node's browser view, so every worker waited ten minutes and stopped with "the scratch node has no browser".
        done, run, chrome, asked = self.start("fetch")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"browsing through {chrome}", done.stdout)
        self.assertEqual(asked.count("download_browser"), 1, asked)
        self.assertEqual(json.loads((run / "home" / "node" / "browser.json").read_text())["path"], str(run / "guard-chrome"))
        self.assertIn(f'exec "{chrome}"', (run / "guard-chrome").read_text(), "the fetched Chrome runs behind the guard")

    def test_a_fetch_that_fails_says_why_at_once(self):
        started = time.monotonic()
        done, _, _, _ = self.start("fail")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("no route to the download host", done.stderr)
        self.assertLess(time.monotonic() - started, 60, "the node's own error ends the wait, not the ten-minute limit")


if __name__ == "__main__":
    unittest.main()
