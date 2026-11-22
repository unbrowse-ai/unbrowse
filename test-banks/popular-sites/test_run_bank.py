import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path

import decision_shim
import run_bank
from run_bank import (
    FINDINGS,
    HERE,
    MAX_NODE_RSS_MB,
    MAX_PROCESSES_LEFT,
    WARM_SHARE_OF_BROWSER,
    browser_seconds,
    calls_in_capture,
    correct_finding,
    data_route_finding,
    default_browser_program,
    fallback_finding,
    findings_table,
    fixed_short_values,
    goal_picks,
    inputs_finding,
    keeps_pick_finding,
    node_tree,
    offered_rows,
    price_marks,
    resources_finding,
    saw_a_door,
    short_values_finding,
    speed_finding,
    sse_finding,
    MALFORMED_LINKS,
    MAX_CALLS_PER_SITE,
    SHORT,
    Files,
    Node,
    bound_input,
    build_report,
    check_links,
    chrome_count,
    compare,
    compare_to_baseline,
    comparison_text,
    door_in,
    beats_browser,
    first_party,
    judge_check,
    judge_site,
    keep_samples,
    looks_like_a_write,
    mentions,
    median,
    no_results_in,
    nonsense_value,
    overlap,
    pick_sample,
    problems,
    read_answer,
    record_title,
    run_site,
    same_page,
    shorten,
    step_that_writes,
    tested_domains,
    as_sent,
    url_for,
)


def page(*lines, title="Search"):
    return {"title": title, "state": None, "text": "\n".join(("Home", "About") + lines + ("Contact", "Copyright"))}


def own_of(value_answers, step):
    answers = {s: (v, read_answer(d)) for s, (v, d) in value_answers.items()}
    return answers[step][1], compare(answers)[step]


class FakeNode:
    """A node that answers from a table, keeping every call the runner makes."""

    def __init__(self, answers, route, routes=()):
        self.answers, self.route, self.existing, self.calls = answers, route, list(routes), []

    def routes(self):
        return self.existing

    def do(self, goal, url):
        self.calls.append(("do", url))
        return self._for(url, how=None)

    def call(self, route_id, inputs):
        self.calls.append(("call", inputs))
        return self._for(json.dumps(inputs), how="call")

    def _for(self, text, how):
        for key, data in self.answers.items():
            if key in text:
                result = {"ok": True, "data": data, "paid_usdc": None}
                if how == "call":
                    return 200, result
                learned = not any(c[0] == "do" for c in self.calls[:-1])
                return 200, {"how": "learned" if learned else "called", "route": self.route, "result": result}
        return 500, {"error": "no table entry"}


CASE = {"site": "shop.test", "goal": "search the shop", "url": "https://shop.test/s?q={q}", "values": ["kettle", "teapot", "garden hose reel"]}
ROUTE = {"id": "r1", "site": "shop.test", "method": "GET", "path": "/s?q={q}", "write": False, "inputs": [{"name": "q", "default": "kettle"}]}


def run(node):
    with tempfile.TemporaryDirectory() as tmp:
        return run_site(node, CASE, "zqnonsense", Files(), samples=None, gap=0)


GOOD = {
    "kettle": page("kettle", "Steel kettle 2L", "Glass kettle", "Travel kettle"),
    "teapot": page("teapot", "Clay teapot", "Teapot with infuser"),
    "garden": page("garden hose reel", "Garden hose reel 30m", "Hose reel cart"),
    "zqnonsense": page("zqnonsense", "No results for your search"),
}


class EvidenceTests(unittest.TestCase):
    def test_a_line_every_answer_shares_is_not_a_result(self):
        read, own = own_of({"first": ("kettle", page("Kettle deals", "kettle")), "other": ("teapot", page("Kettle deals", "teapot"))}, "first")
        self.assertEqual(own["hits"], 0)

    def test_the_query_said_back_is_not_a_mention(self):
        read, own = own_of({"first": ("kettle", page("Results for kettle", "kettle")), "other": ("teapot", page("Results for teapot", "teapot"))}, "first")
        self.assertEqual(own["hits"], 0)
        self.assertEqual(judge_check("first", "kettle", read, own, True)[0], "ok_but_wrong")

    def test_a_country_gate_is_blocked_though_it_says_the_query(self):
        gate = page("Select your Country", "United States", "kettle", title="Best Buy International: Select your Country")
        read, own = own_of({"first": ("kettle", gate), "other": ("teapot", page("Select your Country", "teapot"))}, "first")
        self.assertEqual(judge_check("first", "kettle", read, own, True), ("blocked", "region_gate"))

    def test_a_country_menu_is_no_gate(self):
        self.assertIsNone(door_in("Search Result - Huawei\nCorporate\nSelect a Country or Region\nAustralia"))
        self.assertEqual(door_in("Best Buy International: Select your Country\nUnited States"), ("blocked", "region_gate"))

    def test_a_challenge_beats_any_mention_of_the_value(self):
        wall = page("Verify you are human", "Steel kettle", "Glass kettle", title="Just a moment...")
        read, own = own_of({"first": ("kettle", wall), "other": ("teapot", page("teapot"))}, "first")
        self.assertEqual(judge_check("first", "kettle", read, own, True), ("blocked", "challenge"))

    def test_a_footer_sign_in_on_a_no_results_page_is_no_login_wall(self):
        short = page("0 projects match", "No results found", "Sign in to your account")
        read, own = own_of({"no_results": ("zqx", short), "first": ("kettle", page("kettle one"))}, "no_results")
        self.assertEqual(judge_check("no_results", "zqx", read, own, True)[0], "pass")

    def test_results_for_a_real_value_pass(self):
        read, own = own_of({"first": ("kettle", GOOD["kettle"]), "other": ("teapot", GOOD["teapot"])}, "first")
        self.assertEqual(judge_check("first", "kettle", read, own, True), ("pass", None))
        self.assertEqual(own["hits"], 3)

    def test_a_route_that_ignores_its_input_answers_the_same_for_every_value(self):
        same = page("Trending kettle", "Trending teapot")
        read, own = own_of({"first": ("kettle", same), "other": ("teapot", same)}, "first")
        self.assertEqual(judge_check("first", "kettle", read, own, True), ("ok_but_wrong", "same_answer_for_every_value"))

    def test_results_for_nonsense_are_wrong_and_no_results_words_pass(self):
        read, own = own_of({"no_results": ("zqx", page("A", "B", "C", "D")), "first": ("kettle", page("kettle one"))}, "no_results")
        self.assertEqual(judge_check("no_results", "zqx", read, own, True), ("ok_but_wrong", "results_for_nonsense"))
        read, own = own_of({"no_results": ("zqx", page("returned no hits", "x", "y", "z")), "first": ("kettle", page("kettle one"))}, "no_results")
        self.assertEqual(judge_check("no_results", "zqx", read, own, True)[0], "pass")

    def test_an_empty_list_for_a_real_value_is_wrong_not_a_pass(self):
        read, own = own_of({"first": ("kettle", []), "other": ("teapot", page("teapot pot"))}, "first")
        self.assertEqual(judge_check("first", "kettle", read, own, True), ("ok_but_wrong", "empty_answer"))

    def test_records_are_read_from_where_they_sit(self):
        read = read_answer({"meta": {"total": 2}, "data": {"items": [{"title": "Steel kettle", "id": 1}, {"title": "Glass kettle", "id": 2}]}})
        self.assertEqual((read["kind"], read["count"]), ("records", 2))
        self.assertEqual(read["lines"], ["Steel kettle", "Glass kettle"])

    def test_a_product_is_named_by_its_title_not_the_brand_beside_it(self):
        product = {"item": {"primary_brand": {"name": "Owala"}, "product_description": {"title": "Owala 24 oz water bottle"}}, "fulfillment": {"product_id": "9"}}
        self.assertEqual(record_title(product), "Owala 24 oz water bottle")

    def test_a_records_own_name_beats_a_title_deeper_in_it(self):
        self.assertEqual(record_title({"name": "Ana Lim", "profile": {"title": "Ms"}}), "Ana Lim")

    def test_of_two_lists_as_long_the_one_that_names_itself_is_the_records(self):
        slots = [{"component_id": f"950463{n}-sponsored-{n}"} for n in range(3)]
        products = [{"item": {"product_description": {"title": f"LEGO set {n}"}}} for n in range(3)]
        for answer in ({"layout": slots, "data": products}, {"data": products, "layout": slots}):
            self.assertEqual(read_answer(answer)["lines"], ["LEGO set 0", "LEGO set 1", "LEGO set 2"])

    def test_a_list_with_text_beats_a_longer_list_known_only_by_ids(self):
        pins = [{"id": f"e1_AfqPShz{n}jKlSE0u0kXU4eGV9N3", "images": {"orig": {"url": f"https://img.test/{n}.jpg"}}} for n in range(25)]
        guides = [{"term": f"kitchen {w}", "image_medium_url": f"https://img.test/{w}.jpg"} for w in ("cabinets", "islands", "tiles")]
        for answer in ({"results": pins, "rankedGuides": guides}, {"rankedGuides": guides, "results": pins}):
            self.assertEqual(read_answer(answer)["lines"], ["kitchen cabinets", "kitchen islands", "kitchen tiles"])

    def test_ids_alone_are_still_read_when_nothing_has_text(self):
        pins = [{"id": f"e1_AfqPShz{n}jKlSE0u0kXU4eGV9N3", "images": {"orig": {"url": f"https://img.test/{n}.jpg"}}} for n in range(25)]
        self.assertEqual(read_answer({"results": pins})["count"], 25)

    def test_of_two_lists_with_text_the_longer_is_the_records(self):
        crumbs = [{"title": w} for w in ("Home", "Lamps", "Brass")]
        items = [{"title": f"Brass lamp {n}"} for n in range(9)]
        self.assertEqual(read_answer({"crumbs": crumbs, "items": items})["count"], 9)

    def test_a_record_with_obfuscated_keys_is_named_by_its_longest_text(self):
        read = read_answer({"A": [{"C": "Blue Film Poster", "A?": "A", "K": {"A?": "A"}}, {"C": "Modern Poster", "A?": "A"}]})
        self.assertEqual(read["lines"], ["Blue Film Poster", "Modern Poster"])

    def test_an_object_that_says_it_found_nothing_is_no_results(self):
        self.assertTrue(no_results_in(["results: []"]))
        self.assertTrue(no_results_in(["numFound: 0"]))
        self.assertFalse(no_results_in(["results: 40 items in stock"]))
        self.assertFalse(no_results_in(["Showing 10 results"]))
        self.assertTrue(no_results_in(["0 projects match"]))

    def test_mentions_fold_case_accents_endings_and_any_word_of_a_phrase(self):
        self.assertTrue(mentions("Blue TOWEL set", "towels"))
        self.assertTrue(mentions("Café au lait", "café"))
        self.assertTrue(mentions("raster tiles", "geospatial raster"))
        self.assertTrue(mentions("全国の天気予報", "天気"))
        self.assertFalse(mentions("Steel teapot", "kettle"))

    def test_no_results_in_other_languages(self):
        for line in ("Keine Ergebnisse gefunden", "Brak wyników", "م", "見つかりませんでした"):
            self.assertEqual(no_results_in([line]), line != "م")

    def test_overlap_of_two_answers(self):
        self.assertEqual(overlap(["a", "b"], ["a", "b", "c"]), 1)
        self.assertEqual(overlap(["a", "b"], ["c", "d"]), 0)

    def test_titles_are_short_and_hold_nothing_private(self):
        text = "write to jo@example.test or call +65 6123 4567 token eyJhbGciOiJIUzI1NiJ9.abcdefgh " + "x" * 200
        kept = shorten(text)
        self.assertLessEqual(len(kept), SHORT)
        self.assertNotIn("jo@example.test", kept)
        self.assertNotIn("6123", kept)
        self.assertNotIn("eyJ", shorten("eyJhbGciOiJIUzI1NiJ9.abcdefgh"))
        self.assertNotIn("203.0.113.9", shorten("client_id 203.0.113.9:sra"))

    def test_a_report_with_an_address_in_a_title_is_refused(self):
        doc = {"sites": [{"site": "a.test", "checks": [{"step": "first", "outcome": "pass", "evidence": {"titles": ["client 203.0.113.9"]}}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None}], "judgments": [], "odd_links": []}
        self.assertTrue(any("address" in p for p in problems(build_report(doc, {}))))

    def test_a_record_nested_under_its_fields_is_read(self):
        read = read_answer({"response": {"body": {"hits": {"hits": [{"fields": {"title": "Jazz at noon"}}, {"fields": {"title": "Jazz age"}}]}}}})
        self.assertEqual((read["kind"], read["lines"]), ("records", ["Jazz at noon", "Jazz age"]))

    def test_a_record_wrapped_in_a_list_of_its_own_is_named_by_what_it_wraps(self):
        games = lambda word: {"searchResults": [{"contents": [{"universeId": 100 + n, "name": f"{word} game {n}"}], "topicId": "Invalid"} for n in range(6)]}
        read = read_answer(games("Tycoon"))
        self.assertEqual((read["count"], read["lines"][:2]), (6, ["Tycoon game 0", "Tycoon game 1"]))
        answers = {"first": ("tycoon", read), "other": ("obby", read_answer(games("Obby")))}
        self.assertEqual(judge_check("first", "tycoon", read, compare(answers)["first"], True), ("pass", None))

    def test_a_list_every_record_holds_one_of_is_its_part_and_the_record_says_it(self):
        tags = lambda *names: [{"name": n, "search_term": n.lower()} for n in names]
        filler = ("Aqua", "Blue", "Calm", "Coast", "Deep", "Flow", "Wide")
        photos = [{"attributes": {"title": f"Waves in motion {n}", "tags": tags(*filler[: 4 + n % 3], "Ocean")}} for n in range(4)]
        read = read_answer({"data": photos})
        self.assertEqual(read["count"], 4, "the photos, not one photo's longer list of tags")
        self.assertTrue(all(mentions(line, "ocean") for line in read["lines"]), "a photo tagged with the value is a photo of it")
        self.assertTrue(read["lines"][0].startswith("Waves in motion 0"), "its own name first")

    def test_a_list_that_holds_most_of_what_its_like_hold_stands_on_its_own(self):
        products = [{"title": f"Steel kettle {n}"} for n in range(20)]
        zones = [{"name": "Results", "items": products}, {"name": "Sponsored", "items": [{"title": "Glass teapot"}]}, {"name": "Related", "items": []}]
        self.assertEqual(read_answer({"zones": zones})["count"], 20)

    def test_a_door_needs_its_words(self):
        self.assertIsNone(door_in("How to fix a kettle"))
        self.assertEqual(door_in("Please log in to see this"), ("requires_account", "login_wall"))


class KeptWalkTests(unittest.TestCase):
    """A run's walks, kept as cases the learner reads again with no site asked."""

    def test_a_walk_is_kept_with_the_page_and_the_goal_it_was_walked_for(self):
        with tempfile.TemporaryDirectory() as tmp:
            walks, corpus = Path(tmp) / "walks", Path(tmp) / "corpus"
            walks.mkdir()
            (walks / "learn_aa11.jsonl").write_text('{"type":"request"}\n')
            (walks / "learn_bb22.jsonl").write_text("")
            log = [
                'eye {"kind":"started","walk":"aa11","url":"https://www.shop.test/search?q=lamps","goal":"search the shop","agent":"bank"}',
                'eye {"kind":"started","walk":"bb22","url":"https://www.shop.test/search?q=kettles","goal":"search the shop","agent":"bank"}',
                'eye {"kind":"started","walk":"cc33","url":"https://gone.test/","goal":"read it","agent":"bank"}',
                'eye {"kind":"picked","walk":"aa11","index":4}',
                "browser proxy: something else",
            ]
            kept = run_bank.keep_walks(log, walks, corpus)
            self.assertEqual(kept, ["shop.test--aa11"], "a walk that recorded nothing, or left no capture, is no case")
            case = json.loads((corpus / "shop.test--aa11" / "case.json").read_text())
            self.assertEqual((case["url"], case["goal"]), ("https://www.shop.test/search?q=lamps", "search the shop"))
            self.assertTrue((corpus / "shop.test--aa11" / "learn_aa11.jsonl").is_file())
            self.assertFalse((walks / "learn_aa11.jsonl").exists(), "moved, not copied: a capture is large")
            self.assertEqual(corpus.stat().st_mode & 0o077, 0, "a capture holds a session: the corpus is its owner's alone")

    def test_a_kept_case_is_its_owners_alone_whatever_was_there(self):
        """A corpus or a case folder already there and open to others is narrowed to its owner, every file kept in it is
        0600 (the case holds the page's whole address, fragment and all), and a corpus that is a link is refused."""
        with tempfile.TemporaryDirectory() as tmp:
            walks, corpus = Path(tmp) / "walks", Path(tmp) / "corpus"
            walks.mkdir()
            corpus.mkdir(mode=0o755)
            os.chmod(corpus, 0o755)
            case_dir = corpus / "shop.test--aa11"
            case_dir.mkdir(mode=0o777)
            os.chmod(case_dir, 0o777)
            (case_dir / "case.json").write_text("{}")
            os.chmod(case_dir / "case.json", 0o644)
            (walks / "learn_aa11.jsonl").write_text('{"type":"request"}\n')
            os.chmod(walks / "learn_aa11.jsonl", 0o644)
            log = ['eye {"kind":"started","walk":"aa11","url":"https://www.shop.test/cb#code=7391","goal":"read it","agent":"bank"}']
            self.assertEqual(run_bank.keep_walks(log, walks, corpus), ["shop.test--aa11"])
            for path, mode in [(corpus, 0o700), (case_dir, 0o700), (case_dir / "case.json", 0o600), (case_dir / "learn_aa11.jsonl", 0o600)]:
                self.assertEqual(path.stat().st_mode & 0o777, mode, path)
            self.assertIn("#code=7391", (case_dir / "case.json").read_text())
            link = Path(tmp) / "linked"
            link.symlink_to(corpus, target_is_directory=True)
            with self.assertRaises(PermissionError):
                run_bank.keep_walks(log, walks, link)


class RunTests(unittest.TestCase):
    def test_all_the_steps_of_a_right_answer_pass(self):
        site = run(FakeNode(GOOD, ROUTE))
        outcomes = {c["step"]: c["outcome"] for c in site["checks"]}
        self.assertEqual(outcomes, {"first": "pass", "replay": "pass", "call_unrelated": "pass", "no_results": "pass", "recheck": "pass"})
        self.assertEqual(judge_site(site["checks"]), "pass")
        self.assertEqual(site["phase"], "fresh")

    def test_the_same_answer_for_any_nonsense_is_the_sites_fallback(self):
        popular = ["Popular kettle stand", "Bestselling mug", "Gift card", "Travel flask", "Tea towel set"]
        answers = dict(GOOD, zqnonsense=page("You searched for zqnonsense", *popular), zqesnesnon=page("You searched for zqesnesnon", *popular))
        site = run(FakeNode(answers, ROUTE))
        check = next(c for c in site["checks"] if c["step"] == "no_results")
        self.assertEqual((check["outcome"], check["why"]), ("pass", "site_fallback_same_for_any_nonsense"), check)
        self.assertEqual(check["evidence"]["second_nonsense"]["value"], "zqesnesnon")
        # Another answer for another nonsense value is a search that matched something: still wrong.
        answers["zqesnesnon"] = page("other", "Hose reel", "Garden gloves", "Rake")
        check = next(c for c in run(FakeNode(answers, ROUTE))["checks"] if c["step"] == "no_results")
        self.assertEqual((check["outcome"], check["why"]), ("ok_but_wrong", "results_for_nonsense"))

    def test_a_door_on_the_second_nonsense_call_stops_the_site(self):
        popular = ["Popular kettle stand", "Bestselling mug", "Gift card", "Travel flask", "Tea towel set"]
        answers = dict(GOOD, zqnonsense=page("You searched for zqnonsense", *popular), zqesnesnon=page("You searched for zqesnesnon", *popular))
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            log.write_text("")

            class Healed(FakeNode):
                def call(self, route_id, inputs):
                    if inputs == {"q": "zqesnesnon"}:
                        log.write_text(log.read_text() + "   [call] failed before any heal: step 1 answered 403: Error Page\n   [heal] route drifted\n")
                    return super().call(route_id, inputs)

            site = run_site(Healed(answers, ROUTE), CASE, "zqnonsense", Files(node_log=log), gap=0, one_ask=True)
            check = next(c for c in site["checks"] if c["step"] == "no_results")
            self.assertEqual((site["stopped"], check["outcome"], check["why"]), ("blocked", "blocked", "the_second_nonsense_met_a_door"))
            self.assertEqual(judge_site(site["checks"]), "blocked")
            self.assertEqual({f["outcome"] for f in site["findings"].values()}, {"blocked"})

        class Refused(FakeNode):
            def call(self, route_id, inputs):
                if inputs == {"q": "zqesnesnon"}:
                    self.calls.append(("call", inputs))
                    return 200, {"ok": False, "data": None, "error": "the site answered 403: Access Denied"}
                return super().call(route_id, inputs)

        site = run(Refused(answers, ROUTE))
        self.assertEqual((site["stopped"], next(c for c in site["checks"] if c["step"] == "no_results")["outcome"]), ("blocked", "blocked"), "a refusal stops it with or without the flag")

    def test_a_wall_answered_as_ok_on_the_second_nonsense_call_stops_the_site(self):
        popular = ["Popular kettle stand", "Bestselling mug", "Gift card", "Travel flask", "Tea towel set"]
        answers = dict(GOOD, zqnonsense=page("You searched for zqnonsense", *popular), zqesnesnon=page("Verify you are human", title="Just a moment..."))
        site = run(FakeNode(answers, ROUTE))
        check = next(c for c in site["checks"] if c["step"] == "no_results")
        self.assertEqual((site["stopped"], check["outcome"], check["why"]), ("blocked", "blocked", "the_second_nonsense_met_a_door"))
        self.assertEqual(check["evidence"]["second_nonsense"]["overlap"], 0.0, "a wall's lines are never read as the site's fallback")

    def test_no_list_for_the_nonsense_where_every_value_had_one_is_nothing_found(self):
        def found(word, *titles):
            return {"cursor": {"resultCount": str(len(titles))}, "results": [{"title": f"{t} {word}", "url": f"https://docs.test/{t}"} for t in titles]}

        nothing = {"cursor": {"currentPageIndex": 0, "moreResultsUrl": "https://find.test/?q=zqnonsense"}, "findMoreOnGoogle": {"url": "https://find.test/search?q=zqnonsense"}, "context": {"title": "docs"}}
        answers = {"kettle": found("kettle", "Steel", "Glass", "Travel"), "teapot": found("teapot", "Clay", "Iron", "Glass"),
                   "garden": found("garden hose reel", "Long", "Short", "Wall"), "zqnonsense": nothing}
        site = run(FakeNode(answers, ROUTE))
        check = next(c for c in site["checks"] if c["step"] == "no_results")
        self.assertEqual((check["outcome"], check["why"]), ("pass", "no_records_where_the_others_had_them"), site["checks"])
        # A nonsense answer that is still a list of records stays wrong: the search found something.
        answers["zqnonsense"] = found("", "Fallback", "Popular", "Trending")
        check = next(c for c in run(FakeNode(answers, ROUTE))["checks"] if c["step"] == "no_results")
        self.assertEqual(check["outcome"], "ok_but_wrong")

    def test_a_site_with_a_route_already_is_preexisting(self):
        self.assertEqual(run(FakeNode(GOOD, ROUTE, routes=[ROUTE]))["phase"], "preexisting")

    def test_a_blank_page_for_every_value_passes_nothing(self):
        blank = {"title": "Reddit", "state": None, "text": "", "links": []}
        site = run(FakeNode({"kettle": blank, "teapot": blank, "garden": blank, "zqnonsense": blank}, ROUTE))
        outcomes = {c["step"]: c["outcome"] for c in site["checks"]}
        self.assertEqual(set(outcomes.values()), {"ok_but_wrong"}, outcomes)
        self.assertEqual(judge_site(site["checks"]), "ok_but_wrong")

    def test_a_404_that_says_the_nonsense_back_is_a_false_failure(self):
        class NotFound(FakeNode):
            def call(self, route_id, inputs):
                if "zqnonsense" in json.dumps(inputs):
                    return 200, {"ok": False, "data": None, "error": "the site answered 404: [zqnonsense] Results from Shop: Skip to content"}
                return super().call(route_id, inputs)

        self.assertEqual(judge_site(run(NotFound(GOOD, ROUTE))["checks"]), "false_failure")

    def test_a_window_the_guard_refused_is_blocked_not_a_node_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "guard.log")
            log.write_text("")

            class Walled(FakeNode):
                def do(self, goal, url):
                    self.calls.append(("do", url))
                    log.write_text(log.read_text() + "15:00:00 REFUSED_HEADED_CHROME\n")
                    return 422, {"error": "Chrome exited before providing DevTools URL"}

            site = run_site(Walled(GOOD, ROUTE), CASE, "zqnonsense", Files(guard_log=log), gap=0)
        check = site["checks"][0]
        self.assertEqual((check["outcome"], check["why"]), ("blocked", "walk_refused_then_wanted_a_window"))
        self.assertEqual(judge_site(site["checks"]), "blocked")

    def test_a_recheck_the_site_refuses_is_blocked(self):
        class Tires(FakeNode):
            def call(self, route_id, inputs):
                if self.calls.count(("call", {"q": "kettle"})) >= 0 and inputs == {"q": "kettle"}:
                    self.calls.append(("call", inputs))
                    return 200, {"ok": False, "data": None, "error": "the site answered 403: Error Page"}
                return super().call(route_id, inputs)

        site = run(Tires(GOOD, ROUTE))
        check = next(c for c in site["checks"] if c["step"] == "recheck")
        self.assertEqual((check["outcome"], check["why"]), ("blocked", "refused"))
        self.assertEqual(judge_site(site["checks"]), "blocked")

    def test_suggestions_are_not_the_search_however_well_they_match(self):
        site = run(FakeNode(GOOD, dict(ROUTE, path="/autocomplete?query={q}")))
        self.assertEqual(next(c for c in site["checks"] if c["step"] == "first")["why"], "suggestions_not_results")
        self.assertEqual(judge_site(site["checks"]), "ok_but_wrong")

    def test_a_write_stops_the_site_at_once(self):
        node = FakeNode(GOOD, dict(ROUTE, write=True, method="POST"))
        site = run(node)
        self.assertEqual(len(node.calls), 1)
        self.assertEqual(site["stopped"], "safety_stop")
        self.assertEqual(judge_site(site["checks"]), "safety_stop")

    def test_a_post_to_a_cart_is_held_though_it_isnt_marked_write(self):
        self.assertTrue(looks_like_a_write({"method": "POST", "path": "/api/cart/add"}))
        self.assertFalse(looks_like_a_write({"method": "POST", "path": "/ds/search/cf/4.0/search/"}))
        self.assertFalse(looks_like_a_write({"method": "GET", "path": "/cart"}))
        node = FakeNode(GOOD, dict(ROUTE, method="POST", path="/api/cart/add"))
        self.assertEqual(run(node)["stopped"], "safety_stop")
        self.assertEqual(len(node.calls), 1)

    def test_a_step_that_reads_as_a_write_stops_the_site_though_the_last_call_is_a_get(self):
        steps = [{"method": "GET", "url": "https://shop.test/s"}, {"method": "POST", "url": "https://shop.test/resource/ActivateExperimentResource/create/"}]
        self.assertEqual(step_that_writes(steps), "POST /resource/ActivateExperimentResource/create/")
        self.assertIsNone(step_that_writes([{"method": "POST", "url": "https://shop.test/_ajax/search/details"}]))
        # What the node says in a route's also_sends reads the same.
        self.assertEqual(step_that_writes([{"method": "POST", "host": "shop.test", "path": "/resource/Visit/create/"}]), "POST /resource/Visit/create/")
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "routes").mkdir()
            Path(tmp, "routes", "r1.json").write_text(json.dumps({"graph": {"steps": steps}}))
            node = FakeNode(GOOD, ROUTE)
            site = run_site(node, CASE, "zqnonsense", Files(node_home=tmp), gap=0)
        self.assertEqual(site["stopped"], "safety_stop")
        self.assertEqual(len(node.calls), 1)

    def test_a_value_the_route_never_took_is_a_failure_not_a_pass(self):
        class Ignores(FakeNode):
            def call(self, route_id, inputs):
                status, reply = super().call(route_id, inputs)
                return status, dict(reply, ignored_inputs=["q"])

        site = run(Ignores(GOOD, ROUTE))
        check = next(c for c in site["checks"] if c["step"] == "call_unrelated")
        self.assertEqual((check["outcome"], check["why"]), ("fail", "input_not_sent"))
        self.assertNotIn(judge_site(site["checks"]), ("pass",))

    def test_a_route_with_no_bound_input_cannot_pass_replay(self):
        site = run(FakeNode(GOOD, dict(ROUTE, inputs=[])))
        self.assertIsNone(site["bound_input"])
        self.assertEqual(next(c for c in site["checks"] if c["step"] == "first")["why"], "no_bound_input")
        self.assertEqual(judge_site(site["checks"]), "fail")

    def test_a_no_results_404_is_a_false_failure_not_a_pass(self):
        class Refuses(FakeNode):
            def call(self, route_id, inputs):
                if "zqnonsense" in json.dumps(inputs):
                    return 200, {"ok": False, "data": None, "error": "the site answered 404: No results for zqnonsense"}
                return super().call(route_id, inputs)

        site = run(Refuses(GOOD, ROUTE))
        self.assertEqual(next(c for c in site["checks"] if c["step"] == "no_results")["outcome"], "false_failure")
        self.assertEqual(judge_site(site["checks"]), "false_failure")

    def test_a_learned_replay_is_not_a_replay(self):
        class Relearns(FakeNode):
            def do(self, goal, url):
                status, reply = super().do(goal, url)
                return status, dict(reply, how="learned")

        site = run(Relearns(GOOD, ROUTE))
        self.assertEqual(next(c for c in site["checks"] if c["step"] == "replay")["why"], "replay_was_not_a_call_of_the_same_route")

    def test_a_timeout_is_retried_once_and_named(self):
        class Slow(FakeNode):
            first = True

            def do(self, goal, url):
                if Slow.first:
                    Slow.first = False
                    self.calls.append(("do", url))
                    return 0, {"error": "timeout or no answer"}
                return super().do(goal, url)

        site = run(Slow(GOOD, ROUTE))
        self.assertTrue(site["retried_timeout"])
        self.assertEqual(judge_site(site["checks"], retried=True), "pass_after_retry")

    def test_a_rate_limit_stops_the_site(self):
        class Limited(FakeNode):
            def do(self, goal, url):
                self.calls.append(("do", url))
                return 429, {"error": "too many requests"}

        node = Limited(GOOD, ROUTE)
        self.assertEqual(run(node)["stopped"], "rate_limited")
        self.assertEqual(len(node.calls), 1)

    def test_a_403_stops_the_site_too(self):
        class Refused(FakeNode):
            def do(self, goal, url):
                self.calls.append(("do", url))
                return 200, {"how": "learned", "route": ROUTE, "result": {"ok": False, "data": None, "error": "step 1 of 39 answered 403"}}

        node = Refused(GOOD, ROUTE)
        site = run(node)
        self.assertEqual((site["stopped"], len(node.calls)), ("blocked", 1))
        self.assertEqual(judge_site(site["checks"]), "blocked")

    def test_a_site_stays_inside_its_call_budget(self):
        node = FakeNode(GOOD, ROUTE)
        run(node)
        self.assertLessEqual(len(node.calls), MAX_CALLS_PER_SITE)

    def test_a_passing_site_after_judging_says_so(self):
        checks = [{"step": s, "outcome": "pass"} for s in ("first", "replay", "call_unrelated", "no_results", "recheck")]
        self.assertEqual(judge_site(checks, judgments=2), "pass_after_judge")
        self.assertEqual(judge_site(checks[:3]), "fail")
        self.assertEqual(judge_site([dict(checks[0], outcome="ok_but_wrong")] + checks[1:]), "ok_but_wrong")

    def test_the_input_is_found_by_its_default(self):
        self.assertEqual(bound_input({"inputs": [{"name": "page", "default": "1"}, {"name": "k", "default": "garden+hose"}]}, "garden hose", "x"), "k")
        self.assertIsNone(bound_input({"inputs": [{"name": "page", "default": "1"}]}, "kettle", "teapot"))

    def test_a_value_in_a_path_is_found_with_what_wraps_it(self):
        self.assertEqual(bound_input({"inputs": [{"name": "part0", "default": "gluten-free-"}]}, "gluten free", "x"), "part0")

    def test_a_call_sends_a_path_value_in_the_site_shape(self):
        self.assertEqual(as_sent({"url": "https://a.test/search/{q}-", "space": "-"}, "gluten free"), "gluten-free-")
        self.assertEqual(as_sent(CASE, "garden hose"), "garden hose")

    def test_lazadas_tag_address_joins_words_with_a_hyphen(self):
        """Lazada answers /tag/rice%20cooker/ with a 404 and /tag/rice-cooker/ with its results (canonical, 2026-11-09)."""
        case = next(c for c in json.loads((HERE / "search-cases.json").read_text())["cases"] if c["site"] == "lazada.sg")
        self.assertEqual(url_for(case, "rice cooker"), "https://www.lazada.sg/tag/rice-cooker/?q=rice-cooker")
        self.assertEqual(url_for(case, "airpods"), "https://www.lazada.sg/tag/airpods/?q=airpods")
        self.assertEqual(as_sent(case, "running shoes"), "running-shoes", "a call sends it as the walk did")

    def test_urls_carry_the_value_in_the_site_shape(self):
        self.assertEqual(url_for(CASE, "garden hose"), "https://shop.test/s?q=garden%20hose")
        self.assertEqual(url_for({"url": "https://a.test/search/{q}-", "space": "-"}, "gluten free"), "https://a.test/search/gluten-free-")

    def test_a_third_party_route_is_named(self):
        self.assertTrue(first_party({"site": "www.shop.test"}, "shop.test"))
        self.assertFalse(first_party({"site": "algolia.net"}, "shop.test"))


class RegressionTests(unittest.TestCase):
    STEPS = ["first", "replay", "call_unrelated", "no_results", "recheck"]

    def entry(self, site, **outcomes):
        return {"site": site, "checks": [{"step": s, "outcome": outcomes.get(s, "pass")} for s in self.STEPS], "retried_timeout": False}

    def test_only_a_check_that_passed_and_now_answers_wrong_regressed(self):
        got = compare_to_baseline(
            {"kept.example": self.STEPS, "wrong.example": self.STEPS, "walled.example": self.STEPS, "missed.example": self.STEPS},
            [self.entry("kept.example"), self.entry("wrong.example", replay="ok_but_wrong"), self.entry("walled.example", first="blocked")],
        )
        self.assertEqual([r["site"] for r in got["passed"]], ["kept.example"])
        self.assertEqual(got["regressed"], [{"site": "wrong.example", "outcome": "replay: ok_but_wrong"}])
        self.assertEqual([r["site"] for r in got["cant_tell"]], ["walled.example", "missed.example"])

    def test_a_check_it_never_passed_is_no_regression(self):
        """The run that exposed it: six sites read as regressed, on the same checks the rule had failed them on before a
        person read the answers. A site that returns its fallback for nonsense does that on every run."""
        steps = ["first", "replay", "call_unrelated", "recheck"]
        got = compare_to_baseline({"fallback.example": steps}, [self.entry("fallback.example", no_results="ok_but_wrong")])
        self.assertEqual(got["regressed"], [])
        self.assertEqual(len(got["passed"]), 1)

    def test_a_wall_says_nothing_of_what_follows_it(self):
        """The run that exposed it: a challenge refused the first ask, and the replay that followed read as a regression."""
        steps = ["replay", "call_unrelated", "no_results"]
        got = compare_to_baseline({"walled.example": steps}, [self.entry("walled.example", first="blocked", replay="ok_but_wrong")])
        self.assertEqual(got["regressed"], [])
        self.assertEqual(got["cant_tell"], [{"site": "walled.example", "outcome": "blocked"}])

    def test_a_live_list_moving_on_is_no_regression(self):
        """The run that exposed it: two sites whose results changed between two asks, on the same route, with every other
        check passing. A wrong answer beside it still counts."""
        got = compare_to_baseline({"live.example": self.STEPS}, [self.entry("live.example", recheck="unstable")])
        self.assertEqual((got["regressed"], [r["outcome"] for r in got["cant_tell"]]), ([], ["unstable"]))
        got = compare_to_baseline({"live.example": self.STEPS}, [self.entry("live.example", recheck="unstable", replay="ok_but_wrong")])
        self.assertEqual(got["regressed"], [{"site": "live.example", "outcome": "replay: ok_but_wrong"}])

    def test_the_latest_run_of_a_site_stands(self):
        got = compare_to_baseline({"a.example": self.STEPS}, [self.entry("a.example", first="fail"), self.entry("a.example")])
        self.assertEqual(len(got["passed"]), 1)

    def test_the_baseline_has_a_case_for_every_site(self):
        baseline = json.loads((HERE / "regression.json").read_text())["sites"]
        cases = {c["site"] for c in json.loads((HERE / "search-cases.json").read_text())["cases"]}
        self.assertTrue(baseline)
        self.assertEqual([s for s in baseline if s not in cases], [])
        self.assertTrue(all(baseline.values()), "a site with no check held to it says nothing")

    def test_the_summary_says_how_many_stand(self):
        text = comparison_text(compare_to_baseline({"a.example": self.STEPS, "b.example": self.STEPS}, [self.entry("a.example"), self.entry("b.example", first="fail")]))
        self.assertIn("1 of 2 sites still pass their checks, 1 regressed", text)


class SafetyTests(unittest.TestCase):
    def test_the_owners_node_is_refused(self):
        for base in ("http://127.0.0.1:7788", "http://localhost:7788/", "http://127.0.0.1", "http://example.test:17810"):
            with self.assertRaises(SystemExit):
                Node(base, "t")
        Node("http://127.0.0.1:17810", "t")

    def test_samples_stay_out_of_the_repository(self):
        with self.assertRaises(SystemExit):
            keep_samples(HERE / "mcp-runs" / "samples", "shop.test", "", {}, {})

    def test_a_report_with_an_unknown_outcome_or_money_is_refused(self):
        doc = {"sites": [{"site": "a.test", "checks": [{"step": "first", "outcome": "pass"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None}], "judgments": [], "odd_links": []}
        report = build_report(doc, {"a.test": {"classification": "looks_fine"}})
        self.assertTrue(any("isn't an outcome" in p for p in problems(report)))
        doc["sites"][0]["paid_usdc"] = 0.01
        self.assertTrue(any("paid" in p for p in problems(build_report(doc, {}))))

    def test_only_a_judgment_that_landed_counts(self):
        site = {"site": "a.test", "checks": [{"step": "first", "outcome": "pass"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None}
        doc = {"sites": [site], "odd_links": [], "judgments": [{"site": "a.test", "verdict": "wrong", "status": 404}, {"site": "a.test", "verdict": "wrong", "status": 200}]}
        self.assertEqual(build_report(doc, {})["sites"][0]["judgments"], 1)

    def test_a_read_against_the_rule_needs_its_reason(self):
        doc = {"sites": [{"site": "a.test", "checks": [{"step": "first", "outcome": "ok_but_wrong"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None}], "judgments": [], "odd_links": []}
        self.assertTrue(any("no reason" in p for p in problems(build_report(doc, {"a.test": {"classification": "pass"}}))))
        self.assertEqual(problems(build_report(doc, {"a.test": {"classification": "pass", "note": "semantic matches, read by hand"}})), [])


class CollectTests(unittest.TestCase):
    """A reply that says the node is still working names an ask: the bank collects that ask's answer before it scores."""

    def node(self, replies):
        sent = []

        class Reply:
            def __init__(self, body):
                self.status, self.body = 200, json.dumps(body).encode()

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def opener(request, timeout):
            sent.append(json.loads(request.data))
            return Reply(replies[len(sent) - 1])

        return Node("http://127.0.0.1:17810", "t", opener=opener), sent

    def test_a_working_reply_is_collected_by_its_ask(self):
        answer = {"how": "learned", "result": {"ok": True, "data": {"items": ["kettle"]}}}
        node, sent = self.node([{"how": "working", "ask": "a1", "phase": "walking"}, answer])
        self.assertEqual(node.do("search", "https://shop.test/s?q=kettle"), (200, answer))
        self.assertEqual(sent[1], {"ask": "a1", "wait_ms": run_bank.COLLECT_WAIT_MS})

    def test_collecting_stops_after_its_limit(self):
        working = {"how": "working", "ask": "a1", "phase": "walking"}
        node, sent = self.node([working] * (run_bank.COLLECTS + 2))
        self.assertEqual(node.do("search", "https://shop.test/s?q=kettle")[1]["how"], "working")
        self.assertEqual(len(sent), 1 + run_bank.COLLECTS)

    def test_an_answer_is_not_collected_again(self):
        node, sent = self.node([{"how": "called", "result": {"ok": True, "data": {}}}])
        node.do("search", "https://shop.test/s?q=kettle")
        self.assertEqual(len(sent), 1)


class SampleTests(unittest.TestCase):
    SITES = [{"domain": f"{c}{n}.test", "category": c, "market": "DE" if n == 9 else "GLOBAL", "tranco_rank": n} for c in ("a", "b") for n in range(10)]

    def test_the_same_seed_draws_the_same_sites(self):
        self.assertEqual(pick_sample(self.SITES, set(), set(), "s"), pick_sample(self.SITES, set(), set(), "s"))
        self.assertNotEqual(pick_sample(self.SITES, set(), set(), "s"), pick_sample(self.SITES, set(), set(), "other"))

    def test_every_category_is_drawn_and_a_market_comes_first(self):
        picked = pick_sample(self.SITES, set(), set(), "s")
        self.assertEqual(Counter_of(picked), {"a": 3, "b": 3})
        self.assertIn("a9.test", [s["domain"] for s in picked])

    def test_tested_and_reserved_sites_are_not_drawn(self):
        picked = pick_sample(self.SITES, {"a1.test"}, {"a2.test"}, "s", per_category=8)
        self.assertFalse({"a1.test", "a2.test"} & {s["domain"] for s in picked})

    def test_the_bank_itself_draws_all_fourteen_categories(self):
        sites = json.loads((HERE / "sites.json").read_text())["sites"]
        self.assertEqual(len({s["category"] for s in pick_sample(sites, set(), set(), "s")}), 14)

    def test_past_runs_are_read_for_tested_sites(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "run.json").write_text('{"sites": [{"site": "pypi.org"}]}')
            self.assertEqual(tested_domains(tmp), {"pypi.org"})

    def test_nonsense_is_new_each_run_and_stable_within_one(self):
        self.assertEqual(nonsense_value("a"), nonsense_value("a"))
        self.assertNotEqual(nonsense_value("a"), nonsense_value("b"))
        self.assertTrue(nonsense_value("a").startswith("zq"))


def Counter_of(picked):
    out = {}
    for site in picked:
        out[site["category"]] = out.get(site["category"], 0) + 1
    return out


class LinkTests(unittest.TestCase):
    class Opens:
        def __init__(self, refuses=True):
            self.refuses = refuses

        def open_link(self, link):
            clean = link.lower() in ("unbrowse://shop.test", "unbrowse://shop.test/")
            if clean or not self.refuses:
                return 200, {"link": "unbrowse://shop.test", "site": "shop.test", "routes": [], "next": "Nothing was called or paid."}
            return 400, {"error": "no"}

    def test_a_link_that_refuses_what_it_should_passes(self):
        check = check_links(self.Opens(), "shop.test", Files(), wait=0)
        self.assertEqual(check["outcome"], "pass")
        self.assertEqual(check["malformed_tried"], len(MALFORMED_LINKS))

    def test_a_site_the_node_wont_name_fails_and_says_why(self):
        class NoSite(self.Opens):
            def open_link(self, link):
                return 400, {"error": "that link names no site"}

        check = check_links(NoSite(), "service.gov.uk", Files(), wait=0)
        self.assertEqual((check["outcome"], check["refused_why"]), ("fail", "that link names no site"))

    def test_a_malformed_link_accepted_fails_and_is_named(self):
        check = check_links(self.Opens(refuses=False), "shop.test", Files(), wait=0)
        self.assertEqual(check["outcome"], "fail")
        self.assertTrue(any(n.startswith("port") for n in check["malformed_not_refused"]))

    def test_a_link_that_left_a_call_behind_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            log.write_text("")

            class Calls(self.Opens):
                def open_link(self, link):
                    log.write_text(log.read_text() + 'call {"id":1}\n')
                    return super().open_link(link)

            self.assertEqual(check_links(Calls(), "shop.test", Files(node_log=log), wait=0)["outcome"], "fail")


class WarmCallTests(unittest.TestCase):
    """The Eden report's first finding: a learned route must be faster than a browser, or learning it bought nothing."""

    def test_every_ask_records_how_long_it_took(self):
        site = run(FakeNode(GOOD, ROUTE))
        for check in site["checks"]:
            self.assertIsInstance(check.get("ms"), int)
        self.assertTrue(site["warm_ms"], "the warm calls are timed")
        self.assertEqual(site["warm_median_ms"], median(site["warm_ms"]))
        self.assertTrue(all(m >= 0 for m in site["warm_ms"]))

    def test_only_calls_of_the_stored_route_count_as_warm(self):
        site = run(FakeNode(GOOD, ROUTE))
        # The first ask learns (a walk, seconds), so its time must not sit among the warm calls it made possible.
        self.assertNotIn("first", site["warm_steps"])
        self.assertIn("call_unrelated", site["warm_steps"])

    def test_a_warm_call_that_beats_the_browser_says_so(self):
        self.assertTrue(beats_browser([400, 600], 3000))
        self.assertFalse(beats_browser([4000, 6000], 3000))
        self.assertEqual(median([4000, 6000, 14900]), 6000)

    def test_no_browser_time_says_nothing_rather_than_a_pass(self):
        self.assertIsNone(beats_browser([400], None))
        self.assertIsNone(beats_browser([], 3000))
        self.assertIsNone(median([]))

    def test_a_run_without_a_browser_program_records_no_comparison(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = run_site(FakeNode(GOOD, ROUTE), CASE, "zqnonsense", Files(), gap=0, browser_program=None)
        self.assertIsNone(site["browser_ms"])
        self.assertIsNone(site["faster_than_browser"])

    def test_a_report_cannot_claim_to_beat_a_browser_it_never_timed(self):
        site = {"site": "a.test", "checks": [{"step": "first", "outcome": "pass"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None, "faster_than_browser": True}
        report = build_report({"sites": [site], "judgments": [], "odd_links": []}, {})
        self.assertTrue(any("no browser time" in p for p in problems(report)))

    def test_the_report_counts_speed_across_sites(self):
        def site(name, faster):
            return {"site": name, "checks": [{"step": "first", "outcome": "pass"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None,
                    "faster_than_browser": faster, "browser_ms": 100 if faster is not None else None}
        report = build_report({"sites": [site("a.test", True), site("b.test", False), site("c.test", None)], "judgments": [], "odd_links": []}, {})
        self.assertEqual(report["speed"], {"measured": 2, "faster": 1, "slower": 1})


class RouteShapeTests(unittest.TestCase):
    """The report's diagnosis of the slowness: 8 of 9 stored routes were the results page itself."""

    def test_the_walked_page_with_a_typed_value_is_the_page(self):
        self.assertTrue(same_page("/s?q={q}", "https://shop.test/s?q=kettle", "kettle"))
        self.assertTrue(same_page("/search/{q}/", "https://shop.test/search/kettle/", "kettle"))

    def test_a_data_call_path_is_not_the_page(self):
        self.assertFalse(same_page("/aps/cf/1.0/certified-search/", "https://shop.test/s?q=kettle", "kettle"))
        self.assertFalse(same_page("/restapi/soa2/27015/FlightListSearchSSE", "https://trip.test/flights", "flights"))

    def test_a_data_call_that_kept_the_pages_path_is_not_the_page_when_it_adds_a_key(self):
        # Lazada's search API answers the same path as the page with `ajax` the page never sent.
        self.assertFalse(same_page("/tag/{q}/?q={q}&ajax=true", "https://shop.test/tag/kettle/?q=kettle", "kettle"))
        # Google Maps' tbm=map call adds `pb`; the report called it the one route that was not the page.
        self.assertFalse(same_page("/search?tbm=map&q={q}&pb={pb}", "https://shop.test/search?tbm=map&q=kettle", "kettle"))
        # The page's own keys, and none the page didn't carry, is the page.
        self.assertTrue(same_page("/s?q={q}&lang=en", "https://shop.test/s?q=kettle&lang=en", "kettle"))

    def test_no_route_is_no_answer(self):
        self.assertIsNone(same_page(None, "https://shop.test/s?q=kettle", "kettle"))

    def test_a_run_records_whether_the_route_is_the_page(self):
        page = run(FakeNode(GOOD, dict(ROUTE, path="/s?q={q}")))
        self.assertTrue(page["route_is_page"])
        data = run(FakeNode(GOOD, dict(ROUTE, path="/api/search?q={q}")))
        self.assertFalse(data["route_is_page"])
        data["site"] = "api.shop.test"  # the report holds one record per site
        report = build_report({"sites": [page, data], "judgments": [], "odd_links": []}, {})
        self.assertEqual((report["page_routes"], report["routes_stored"]), (1, 2))


class VaryTests(unittest.TestCase):
    """The report's finding 4: a one-character query value stored as a constant forces a relearn. A case's `vary`
    changes that parameter on the replay ask; if the route held it as a constant, the replay relearns and fails."""

    def test_url_for_swaps_the_varied_parameter_only(self):
        case = {"url": "https://shop.test/s?q={q}&group_adults=2", "vary": {"group_adults": "1"}}
        self.assertEqual(url_for(case, "kettle", case["vary"]), "https://shop.test/s?q=kettle&group_adults=1")
        self.assertEqual(url_for(case, "kettle"), "https://shop.test/s?q=kettle&group_adults=2")

    def test_url_for_adds_a_varied_parameter_the_url_lacks(self):
        self.assertEqual(url_for(CASE, "kettle", {"page": "2"}), "https://shop.test/s?q=kettle&page=2")

    def test_the_replay_ask_carries_the_vary_value(self):
        node = FakeNode(GOOD, ROUTE)
        case = dict(CASE, vary={"group_adults": "1"}, url="https://shop.test/s?q={q}&group_adults=2")
        with tempfile.TemporaryDirectory() as tmp:
            run_site(node, case, "zqnonsense", Files(), gap=0)
        dos = [url for how, url in node.calls if how == "do"]
        self.assertEqual(len(dos), 2)
        self.assertIn("group_adults=2", dos[0], "the first ask uses the URL as written")
        self.assertIn("group_adults=1", dos[1], "the replay ask varies it")
        self.assertIn("q=teapot", dos[1], "and still varies the query")

    def test_a_route_that_held_the_parameter_as_a_constant_relearns_and_fails(self):
        class Constant(FakeNode):
            def do(self, goal, url):
                self.calls.append(("do", url))
                if "group_adults=1" in url:  # the stored route matches only its own constant
                    return 200, {"how": "learned", "route": dict(ROUTE, id="r2"), "result": {"ok": True, "data": GOOD["teapot"]}}
                return self._for(url, how=None)

        case = dict(CASE, vary={"group_adults": "1"}, url="https://shop.test/s?q={q}&group_adults=2")
        with tempfile.TemporaryDirectory() as tmp:
            site = run_site(Constant(GOOD, ROUTE), case, "zqnonsense", Files(), gap=0)
        replay = next(c for c in site["checks"] if c["step"] == "replay")
        self.assertEqual((replay["outcome"], replay["why"]), ("ok_but_wrong", "replay_was_not_a_call_of_the_same_route"))
        self.assertEqual(judge_site(site["checks"]), "ok_but_wrong")

    def test_a_case_that_varies_a_parameter_it_does_not_carry_is_refused(self):
        """A vary value the URL never holds would be appended and change the page: that is a case bug, caught here."""
        for case in json.loads((HERE / "search-cases.json").read_text())["cases"]:
            for param in (case.get("vary") or {}):
                self.assertIn(f"{param}=", case["url"], f"{case['site']}: vary names {param}, its URL lacks it")


class LeftoverBrowserTests(unittest.TestCase):
    """The report's resource finding: 88 processes at the end, browsers from failed learns never closed."""

    def test_chrome_count_counts_only_this_runs_profiles(self):
        ps = "\n".join([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/run1/agent-browser-profile-aa --headless",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/run1/agent-browser-profile-bb --headless",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google",
            "python3 run_bank.py run --node-home /tmp/run1/home/node",
        ])
        self.assertEqual(chrome_count(ps, "/tmp/run1"), 2)
        self.assertEqual(chrome_count(ps, ["/tmp/run1", "/tmp/other"]), 2)

    def test_a_line_without_a_profile_is_not_a_browser(self):
        ps = "chrome --type=renderer --user-data-dir=/tmp/run1\nsh -c 'echo /tmp/run1'"
        self.assertEqual(chrome_count(ps, "/tmp/run1"), 1)

    def test_no_run_folder_says_nothing(self):
        self.assertIsNone(chrome_count("chrome --user-data-dir=/tmp/run1", None))
        self.assertIsNone(Files().chrome_left())

    def test_a_run_counts_the_browsers_it_has_left(self):
        ps = "chrome --user-data-dir=/tmp/run1/agent-browser-profile-aa\n" * 3
        self.assertEqual(chrome_count(ps, "/tmp/run1"), 3)

    def test_the_report_totals_browsers_left_behind(self):
        def site(name, before, after):
            return {"site": name, "checks": [{"step": "first", "outcome": "pass"}], "calls": 1, "paid_usdc": 0, "retried_timeout": False, "links": None,
                    "chrome_before": before, "chrome_after": after}
        report = build_report({"sites": [site("a.test", 1, 4), site("b.test", 2, 2), site("c.test", None, None)], "judgments": [], "odd_links": []}, {})
        self.assertEqual(report["browsers_left"], 3)


def model_entry(rows, choice, probability=0.9, confidence=0.8):
    """A line of the stand-in's log: the node asked for a goal's call among `rows`, and was answered `choice`."""
    question = {"type": "choice", "instructions": "Which exchange is the goal request?", "criteria": {str(r["index"]): "x" for r in rows}}
    answer = {"type": "choice", "choice": str(choice), "probabilities": {str(choice): probability}, "confidence": confidence}
    return {"t": 0, "request": {"model": "placeholder", "state": {"exchanges": rows}, "questions": {"goal": question}}, "answers": {"goal": answer}, "ms": 900}


LAZADA_ROWS = [
    {"index": 3, "method": "GET", "host": "shop.test", "path": "/tag/airpods/?q", "mime": "text/html", "resource_type": "Document", "status": 200, "carries": ["q"], "answers": []},
    {"index": 140, "method": "GET", "host": "shop.test", "path": "/tag/airpods/?ajax&catalog_redirect_tag&isFirstRequest&page&q", "mime": "application/json", "resource_type": "XHR", "status": 200, "carries": ["ajax", "q"], "answers": ["templates", "mods", "mainInfo"], "bytes": 90000, "records": 40},
]
LAZADA_STORED = {"id": "r1", "site": "shop.test", "method": "GET", "path": "/tag/{path[1]}/?q={q}&catalog_redirect_tag=true", "inputs": [{"name": "q", "default": "airpods"}, {"name": "part1", "default": "airpods"}]}


class WarmThresholdTests(unittest.TestCase):
    """Finding 1: warm calls are timed already; this makes the time a verdict, at half a browser for the same URL."""

    def test_the_threshold_is_half_a_browser_and_what_eden_measured_fails(self):
        self.assertEqual(WARM_SHARE_OF_BROWSER, 0.5)
        self.assertEqual(speed_finding([5700, 8200], 4500)["outcome"], "fail", "Eden's Amazon: slower than the browser")
        self.assertEqual(speed_finding([3000, 3000], 4500)["outcome"], "fail", "faster, but not meaningfully: a page route's saving")
        self.assertEqual(speed_finding([2000, 2500], 4500)["outcome"], "pass", "exactly half passes")
        self.assertEqual(speed_finding([300, 500], 4500)["share"], 0.09)

    def test_fast_counts_only_for_right_answers_and_slow_is_slow_whatever_it_said(self):
        self.assertEqual(speed_finding([450, 460], 10000, right=False)["why"], "fast_but_wrong")
        self.assertEqual(speed_finding([450, 460], 10000, right=False)["outcome"], "not_run")
        self.assertEqual(speed_finding([8400, 8100], 6200, right=False)["outcome"], "fail")

    def test_too_few_calls_or_no_browser_time_is_not_a_verdict(self):
        self.assertEqual(speed_finding([300], 4500)["why"], "fewer_than_two_answered_warm_calls")
        self.assertEqual(speed_finding([300, 400], None)["why"], "no_browser_time")

    def fake_browser(self, folder, snapshot="button Search"):
        program = Path(folder, "browser")
        program.write_text(f'#!/bin/sh\necho "$HOME|$*" >> "{folder}/calls"\n[ "$3" = snapshot ] && echo "{snapshot}"\nexit 0\n')
        program.chmod(program.stat().st_mode | stat.S_IEXEC)
        return str(program)

    def test_the_baseline_runs_in_the_runs_folders_in_a_session_of_its_own_and_closes(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsInstance(browser_seconds(self.fake_browser(tmp), "https://shop.test/s?q=a", tmp), int)
            calls = Path(tmp, "calls").read_text().splitlines()
        self.assertTrue(all(c.startswith(f"{tmp}/home|--session bank_baseline ") for c in calls), calls)
        self.assertEqual([c.split(" ")[2] for c in calls], ["open", "snapshot", "close"])

    def test_a_wall_in_the_browser_is_no_browser_time_and_no_run_folder_is_no_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(browser_seconds(self.fake_browser(tmp, "Verify you are human"), "https://shop.test/", tmp))
            self.assertIn("close", Path(tmp, "calls").read_text(), "and its browser still closes")
            self.assertIsNone(browser_seconds(self.fake_browser(tmp), "https://shop.test/", None), "never the caller's default session")

    def test_a_refusal_or_a_nothing_found_is_not_counted_as_a_fast_answer(self):
        class Refuses(FakeNode):
            def call(self, route_id, inputs):
                if inputs == {"q": "garden hose reel"}:
                    self.calls.append(("call", inputs))
                    return 200, {"ok": False, "data": None, "error": "the site answered 500"}
                return super().call(route_id, inputs)

        site = run(Refuses(GOOD, ROUTE))
        self.assertEqual(len(site["warm_ms"]), 4, "replay, the refusal, the nothing-found, the recheck")
        self.assertEqual(len(site["warm_answered_ms"]), 2, "replay and recheck")

    def test_a_run_reaches_the_verdict_on_a_browser_it_timed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp, "home", "node")
            home.mkdir(parents=True)

            class Slow(FakeNode):
                def call(self, route_id, inputs):
                    time.sleep(0.08)
                    return super().call(route_id, inputs)

            node = Slow(GOOD, dict(ROUTE, how="called"))
            # The first ask's reply says it learned; the replay's says called, so three warm calls answered.
            site = run_site(node, CASE, "zqnonsense", Files(node_home=home), gap=0, browser_program=self.fake_browser(tmp))
        self.assertLess(site["browser_ms"], 2000)
        self.assertIn(site["findings"]["warm_speed"]["outcome"], ("pass", "fail"))
        self.assertEqual(site["findings"]["warm_speed"]["browser_ms"], site["browser_ms"])


class DataRouteTests(unittest.TestCase):
    """Finding 2: `route_is_page` was recorded and judged nothing. A page stored where a data call existed now fails."""

    def test_a_page_stored_where_the_model_was_shown_a_data_call_fails(self):
        found = data_route_finding(LAZADA_STORED, True, LAZADA_ROWS, [])
        self.assertEqual((found["outcome"], found["why"]), ("fail", "page_stored_where_a_data_call_existed"))
        self.assertIn("ajax", found["data_calls"][0])

    def test_a_pages_config_or_device_check_is_no_data_call(self):
        # What a live Carousell walk offered beside the page: JSON, and nothing to do with the search.
        junk = [{"index": 133, "method": "GET", "path": "/websiteconfig?bt_env", "mime": "application/json", "resource_type": "XHR", "records": 1, "answers": ["tagData"]},
                {"index": 134, "method": "GET", "path": "/device?orgid", "mime": "application/json", "resource_type": "XHR", "records": 1, "answers": ["device"]}]
        self.assertEqual(data_route_finding(ROUTE, True, junk, [{"method": "GET", "path": "/s", "mime": "text/html", "resource_type": "Document"}])["why"], "page_stored_and_no_data_call_seen")
        self.assertEqual(data_route_finding(ROUTE, True, junk, [])["why"], "page_stored_and_nothing_known_of_the_walk", "what the model was shown can't clear a page: the filter chose it")
        said_back = [dict(junk[0], says_back=True)]
        self.assertEqual(data_route_finding(ROUTE, True, said_back, [])["outcome"], "fail")

    def test_a_data_call_seen_only_in_the_walk_counts(self):
        walked = [{"method": "POST", "path": "/restapi/FlightListSearchSSE", "mime": "text/event-stream", "resource_type": "Fetch", "json_events": True}]
        self.assertEqual(data_route_finding(ROUTE, True, [], walked)["outcome"], "fail")

    def test_a_page_with_no_data_call_is_all_a_site_could_store(self):
        document = {"method": "GET", "path": "/s", "mime": "text/html", "resource_type": "Document"}
        self.assertEqual(data_route_finding(ROUTE, True, LAZADA_ROWS[:1], [document])["outcome"], "pass")
        self.assertEqual(data_route_finding(ROUTE, True, LAZADA_ROWS[:1], [])["outcome"], "not_run")

    def test_nothing_known_of_the_walk_is_no_verdict(self):
        self.assertEqual(data_route_finding(ROUTE, True, [], [])["outcome"], "not_run")
        self.assertEqual(data_route_finding(None, False, [], [])["outcome"], "not_run")

    def test_a_data_route_passes(self):
        self.assertEqual(data_route_finding(dict(ROUTE, path="/api/search?q={q}"), False, LAZADA_ROWS, [])["outcome"], "pass")

    def test_a_route_that_answers_as_a_page_is_the_page_though_a_redirect_added_a_key(self):
        # same_page reads Eden's Lazada route as a data call, for the key the redirect added; its answers say otherwise.
        self.assertFalse(same_page("/tag/{path[1]}/?q={q}&catalog_redirect_tag=true", "https://shop.test/tag/airpods/?q=airpods", "airpods"))
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "shim.jsonl")

            class Asks(FakeNode):
                def do(self, goal, url):
                    log.write_text(json.dumps(model_entry(LAZADA_ROWS, 140)) + "\n")  # the walk asks the model as it runs
                    return super().do(goal, url)

            case = dict(CASE, url="https://shop.test/tag/{q}/?q={q}")
            site = run_site(Asks(GOOD, dict(ROUTE, path="/tag/{path[1]}/?q={q}&catalog_redirect_tag=true")), case, "zqnonsense", Files(model_log=log), gap=0)
        self.assertFalse(site["route_is_page"])
        self.assertEqual(site["findings"]["data_route"]["outcome"], "fail")



class BrowserlessFindingTests(unittest.TestCase):
    """A warm call that needed the node's browser fails the site's `browserless` finding, whatever it answered."""

    def test_a_search_reads_on_when_its_next_page_lists_other_things(self):
        from run_bank import reads_on_finding
        first = [f"lamp {i}" for i in range(20)]
        other = [f"lamp {i}" for i in range(20, 40)]
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, first, other)["outcome"], "pass")
        # The first page over again is the repeated-page loop.
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, first, first)["why"], "the_next_page_is_the_first_again")
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, first, [])["why"], "the_next_page_lists_nothing")
        self.assertEqual(reads_on_finding({"page": "2"}, True, False, first, [])["why"], "the_call_for_the_next_page_failed")
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, first, other, browser=True)["why"], "the_browser_ran_the_next_page")
        # A results page carries its frame on every page: 800 lines of filters shared, 100 packages of its own.
        frame = [f"filter {i}" for i in range(800)]
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, frame + first, frame + other)["outcome"], "pass")
        self.assertEqual(reads_on_finding({"page": "2"}, True, True, frame + first, frame + first + ["updated a moment ago"])["why"], "the_next_page_is_the_first_again")
        # A route that offers no way on is not judged: a search may fit on one page.
        self.assertEqual(reads_on_finding(None, False, None, first, [])["outcome"], "not_run")
        self.assertEqual(reads_on_finding({"page": "2"}, False, None, first, [])["why"], "the_site_stopped_before_it_was_asked")

    def test_one_link_of_the_sites_own_is_followed(self):
        from run_bank import link_to_follow, follows_a_link_finding
        answer = {"title": "Search", "links": [
            {"text": "logo", "url": "https://static.shop.example/logo.png"},
            {"text": "this search", "url": "https://www.shop.example/search?q=chair"},
            {"text": "elsewhere", "url": "https://ads.example/click?x=1"},
            {"text": "Brass lamp", "url": "https://www.shop.example/p/brass-lamp-17"},
        ]}
        asked = "https://www.shop.example/search?q=lamp"
        self.assertEqual(link_to_follow(answer, "shop.example", asked), "https://www.shop.example/p/brass-lamp-17")
        self.assertIsNone(link_to_follow({"items": [{"name": "lamp", "price": "9"}]}, "shop.example", asked))
        self.assertEqual(link_to_follow({"results": [{"pageUrl": "https://docs.shop.example/guide/lamps"}]}, "www.shop.example", asked), "https://docs.shop.example/guide/lamps")
        link = "https://www.shop.example/p/brass-lamp-17"
        self.assertEqual(follows_a_link_finding(link, True, 200, True, ["Brass lamp", "$40"], "www.shop.example", "shop.example")["outcome"], "pass")
        self.assertEqual(follows_a_link_finding(link, True, 200, True, ["x"], "www.other.example", "shop.example")["why"], "the_link_left_the_site")
        self.assertEqual(follows_a_link_finding(link, True, 200, True, [], "www.shop.example", "shop.example")["why"], "the_link_led_to_nothing_readable")
        self.assertEqual(follows_a_link_finding(link, True, 502, False, [], None, "shop.example", "the site answered 404")["why"], "the_link_did_not_resolve")
        self.assertEqual(follows_a_link_finding(link, True, 200, False, [], None, "shop.example", "the site answered with a page that asks for a person")["outcome"], "blocked")
        self.assertEqual(follows_a_link_finding(None, False, None, None, [], None, "shop.example")["outcome"], "not_run")

    def test_a_warm_call_the_browser_ran_is_not_browserless(self):
        from run_bank import browserless_finding
        plain = {"step": "replay", "result_ok": True, "browser": False}
        through = {"step": "call_unrelated", "result_ok": True, "browser": True}
        self.assertEqual(browserless_finding([plain])["outcome"], "pass")
        found = browserless_finding([plain, through])
        self.assertEqual(found["outcome"], "fail")
        self.assertIn("call_unrelated", found["why"])
        # A failed call, or a node that never says, measures nothing.
        self.assertEqual(browserless_finding([{"step": "replay", "result_ok": False, "browser": True}])["outcome"], "not_run")
        self.assertEqual(browserless_finding([{"step": "replay", "result_ok": True}])["outcome"], "not_run")

class CorrectAnswerTests(unittest.TestCase):
    """Finding 3: what came back for each site in the report, read against its query."""

    def judged(self, value, data, other, step="first", **case):
        answers = {step: (value, read_answer(data)), "other": ("zz other", read_answer(other))}
        return judge_check(step, value, answers[step][1], compare(answers)[step], True)

    def test_ratings_and_listing_ids_are_no_stays(self):
        listing = lambda n, r: {"listingId": str(70000000 + n), "avgRating": r}
        got = self.judged("bangkok", {"results": [listing(n, f"4.{n}") for n in range(9)]}, {"results": [listing(n + 50, f"3.{n}") for n in range(9)]})
        self.assertEqual(got, ("ok_but_wrong", "records_known_only_by_ids"))

    def test_places_in_nested_arrays_are_read_by_what_they_say(self):
        # Google Maps' `/search?tbm=map` answers in arrays of arrays, the ask said back first (UNB-165, 16 Nov 2026).
        place = lambda fid, name, kind, area: [None, [fid, name, [None, None, 25.03, 121.56], None, [kind]], area, None]
        shops = [["bookstore taipei", [[None, "UOz6", ["bookstore taipei", 0]]]], [place("0x1:0x2", "Eslite Spectrum Taipei Station Store", "Book store", "Taipei City, Taiwan 100"), place("0x3:0x4", "TSUTAYA BOOKSTORE Xinyi Store", "Book store", "Taipei City, Taiwan 110")]]
        trails = [["hiking trail", [[None, "Vez6", ["hiking trail", 0]]]], [place("0x5:0x6", "Clementi Nature Trail", "Hiking area", "Singapore 596470"), place("0x7:0x8", "MacRitchie Nature Trail", "Hiking area", "Singapore 298735")]]
        read = read_answer(shops)
        self.assertIn("Eslite Spectrum Taipei Station Store", read["lines"])
        self.assertEqual(self.judged("bookstore taipei", shops, trails), ("pass", None))
        self.assertEqual(self.judged("hiking trail", trails, shops), ("pass", None))

    def test_ids_that_mention_the_query_are_still_no_stays(self):
        listing = lambda n: {"id": f"bangkok{n}"}
        self.assertEqual(self.judged("bangkok", {"results": [listing(n) for n in range(9)]}, {"results": [{"id": f"x{n}"} for n in range(9)]})[1], "records_known_only_by_ids")

    def test_a_tracking_envelope_is_no_flights_though_its_address_holds_the_query(self):
        one = {"rootMessageId": "921-0a01", "appId": "10320", "fullUrl": "https://shop.test/flights?dcity=bjs&acity=sin", "query": "bjs"}
        other = {"rootMessageId": "921-0a02", "appId": "10320", "fullUrl": "https://shop.test/flights?dcity=sha&acity=sin", "query": "sha"}
        self.assertEqual(read_answer(one)["kind"], "object")
        self.assertEqual(self.judged("bjs", one, other)[0], "ok_but_wrong")

    def test_a_long_pages_frame_is_no_products_though_its_title_says_the_query(self):
        frame = [f"Footer link {n}" for n in range(40)]
        one = {"title": "x", "state": None, "text": "\n".join(["airpods deals today", "Buy airpods online"] + frame)}
        other = {"title": "x", "state": None, "text": "\n".join(["cooker deals today", "Buy cooker online"] + frame)}
        self.assertEqual(self.judged("airpods", one, other), ("ok_but_wrong", "only_the_page_frame"))
        self.assertEqual(self.judged("airpods", one, one), ("ok_but_wrong", "same_answer_for_every_value"), "nothing changed says that, not a frame")

    def test_a_short_page_with_two_results_still_passes(self):
        self.assertEqual(self.judged("teapot", page("Clay teapot", "Teapot with infuser"), page("x", "y"))[0], "pass")

    def test_real_listings_pass(self):
        one = {"items": [{"title": f"Canon Autoboy {n}", "price": {"value": "149.98"}} for n in range(5)]}
        other = {"items": [{"title": f"Contax T{n}", "price": {"value": "2600.00"}} for n in range(5)]}
        self.assertEqual(self.judged("canon autoboy", one, other), ("pass", None))

    def test_prices_are_read_wherever_they_sit(self):
        self.assertEqual(price_marks({"text": "Canon $149.98 and Contax SGD 2,600 and Leica 3,000 USD"}), 3)
        self.assertEqual(price_marks([{"salePrice": "12.50"}, {"price": 9}, {"fare_amount": "33"}]), 3)
        self.assertEqual(price_marks({"text": "Free delivery. Listing 70000000, rated 4.8"}), 0)
        self.assertEqual(price_marks(None), 0)
        self.assertEqual(price_marks({"text": "2 hr 35 min\nSGD 215\nThu\nSGD 270\nSGD 300"}), 3, "from a live Google Flights answer: each on its own line")

    def case_run(self, answers, **case):
        return run_site(FakeNode(answers, ROUTE), dict(CASE, **case), "zqnonsense", Files(), gap=0)

    def test_a_case_that_expects_prices_fails_an_answer_without_them(self):
        site = self.case_run(GOOD, expect=["price"])
        self.assertEqual(next(c for c in site["checks"] if c["step"] == "first")["why"], "no_prices_in_the_answer")
        self.assertEqual(judge_site(site["checks"]), "ok_but_wrong")
        self.assertEqual(site["findings"]["correct"]["outcome"], "fail")

    def test_a_case_that_expects_prices_passes_an_answer_with_them(self):
        priced = {k: {"items": [{"title": f"{k} model {n}", "price": 10 + n} for n in range(4)]} for k in ("kettle", "teapot", "garden")}
        priced["zqnonsense"] = {"items": []}
        site = self.case_run(priced, expect=["price"])
        self.assertEqual(site["findings"]["correct"]["outcome"], "pass", site["checks"])

    def test_a_value_the_list_has_no_reason_to_say_is_read_by_the_list(self):
        flights = lambda tag: {"flights": [{"name": f"{tag} Air flight {n}", "price": 200 + n} for n in range(5)]}
        answers = {"kettle": flights("Alpha"), "teapot": flights("Beta"), "garden": flights("Gamma"), "zqnonsense": {"flights": []}}
        self.assertEqual(self.case_run(answers)["findings"]["correct"]["outcome"], "fail", "without the flag, nothing says the value")
        self.assertEqual(self.case_run(answers, value_not_shown=True, expect=["price"])["findings"]["correct"]["outcome"], "pass")

    def test_correct_is_about_the_answers_not_the_routes_reuse(self):
        checks = [{"step": "first", "outcome": "pass"}, {"step": "replay", "outcome": "ok_but_wrong", "why": "replay_was_not_a_call_of_the_same_route"}, {"step": "call_unrelated", "outcome": "pass"}]
        self.assertEqual(correct_finding(checks)["outcome"], "pass")
        checks[2] = {"step": "call_unrelated", "outcome": "ok_but_wrong", "why": "only_the_page_frame"}
        self.assertEqual(correct_finding(checks)["why"], {"call_unrelated": "only_the_page_frame"})
        self.assertEqual(correct_finding([])["outcome"], "not_run")
        self.assertEqual(correct_finding([{"step": "first", "outcome": "blocked", "why": "challenge"}])["outcome"], "blocked")


class WallTests(unittest.TestCase):
    """The bank's limit: a site that shows a wall is recorded and left. It used to go on asking when the wall came back as a
    good answer, or as a walk handed over."""

    def test_a_wall_answered_as_ok_gets_no_second_ask(self):
        wall = page("Verify you are human", "kettle", title="Just a moment...")
        node = FakeNode(dict(GOOD, kettle=wall), ROUTE)
        site = run(node)
        self.assertEqual((site["stopped"], len(node.calls)), ("blocked", 1))
        self.assertEqual(judge_site(site["checks"]), "blocked")
        self.assertEqual({f["outcome"] for f in site["findings"].values()}, {"blocked"})
        self.assertEqual(sorted(site["findings"]), sorted(FINDINGS))

    def test_a_walk_handed_over_at_a_wall_gets_no_second_ask(self):
        class Handed(FakeNode):
            def do(self, goal, url):
                self.calls.append(("do", url))
                return 200, {"how": "browse", "page": "x", "why": "mint unresolved (challenge); the browser is closed: only a window could ask again, and the owner keeps windows off"}

        node = Handed(GOOD, ROUTE)
        site = run(node)
        self.assertEqual((site["stopped"], len(node.calls)), ("blocked", 1))
        self.assertEqual(judge_site(site["checks"]), "blocked")

    def test_a_door_only_the_log_saw_ends_the_site_when_the_run_says_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            log.write_text("")

            class Cleared(FakeNode):
                def do(self, goal, url):
                    log.write_text('eye {"kind":"seen","walk":"a","n":1,"method":"GET","host":"shop.test","path":"/s","status":403,"bytes":9,"sort":"gate"}\n')
                    return super().do(goal, url)

            node = Cleared(GOOD, ROUTE)
            site = run_site(node, CASE, "zqnonsense", Files(node_log=log), gap=0, one_ask=True)
            self.assertEqual((site["stopped"], len(node.calls), judge_site(site["checks"])), ("blocked", 1, "blocked"))
            log.write_text("")
            self.assertEqual(judge_site(run_site(Cleared(GOOD, ROUTE), CASE, "zqnonsense", Files(node_log=log), gap=0)["checks"]), "pass", "the nightly's reads stay as they were")

    def test_a_clean_browser_the_guard_held_is_a_door_under_one_ask(self):
        with tempfile.TemporaryDirectory() as tmp:
            guard = Path(tmp, "guard.log")
            guard.write_text("chrome_headless_launch --headless\n")

            class Refused(FakeNode):
                def do(self, goal, url):
                    guard.write_text(guard.read_text() + "HELD_CLEAN\n")  # the node asked again in a clean browser
                    return super().do(goal, url)

            node = Refused(GOOD, ROUTE)
            site = run_site(node, CASE, "zqnonsense", Files(guard_log=guard), gap=0, one_ask=True)
            self.assertEqual((site["stopped"], len(node.calls), site["checks"][0]["why"]), ("blocked", 1, "the_walk_met_a_door"))
            guard.write_text("HELD_CLEAN\n")  # one before the ask is another site's
            site = run_site(FakeNode(GOOD, ROUTE), CASE, "zqnonsense", Files(guard_log=guard), gap=0, one_ask=True)
            self.assertIsNone(site["stopped"])

            class CallRefused(FakeNode):
                def call(self, route_id, inputs):
                    guard.write_text(guard.read_text() + "HELD_CLEAN\n")
                    return super().call(route_id, inputs)

            site = run_site(CallRefused(GOOD, ROUTE), CASE, "zqnonsense", Files(guard_log=guard), gap=0, one_ask=True)
            self.assertEqual((site["stopped"], site["checks"][-1]["why"]), ("blocked", "the_call_met_a_door"))

    def test_a_walk_that_failed_at_a_door_is_read_from_the_log(self):
        self.assertTrue(saw_a_door(['eye {"kind":"failed","walk":"a","error":"the walk failed: running the browser: mint unresolved (challenge); the browser is closed"}']))
        self.assertTrue(saw_a_door(['eye {"kind":"failed","walk":"a","error":"the walk failed: running the browser: the site kept challenging the browser"}']))
        self.assertFalse(saw_a_door(['eye {"kind":"seen","sort":"data"}', 'judge: "sort":"gate" said by something else']))

    def seen(self, **fields):
        return "eye " + json.dumps(dict(kind="seen", walk="a", n=1, method="GET", host="shop.test", path="/s", status=200, bytes=9, sort="page", **fields) if not fields.keys() & {"path", "status", "sort"} else {**dict(kind="seen", walk="a", n=1, method="GET", host="shop.test", path="/s", status=200, bytes=9, sort="page"), **fields})

    def test_a_script_challenge_that_clears_by_itself_is_still_a_door(self):
        # From a live walk of 2026-11-07: a 202, the challenge's own files and a verify POST, then the results.
        self.assertTrue(saw_a_door([self.seen(status=202)]))
        self.assertTrue(saw_a_door([self.seen(path="/__challenge_h78IRK/d8c1/a18a/mp_verify", sort="data")]))

    def test_a_challenge_that_did_something_is_a_door_and_a_script_the_page_loads_is_not(self):
        # Booking, live 2026-11-07: a 202, the challenge's own script (an asset), its inputs and a verify POST (data).
        booking = [self.seen(status=202), self.seen(path="/__challenge_h78IRK/d8c1/a18a/challenge.js", sort="asset"),
                   self.seen(path="/__challenge_h78IRK/d8c1/a18a/inputs", sort="data"), self.seen(method="POST", path="/__challenge_h78IRK/d8c1/a18a/mp_verify", sort="data")]
        self.assertTrue(saw_a_door(booking))
        self.assertTrue(saw_a_door(booking[2:]), "its data calls alone, without the 202")
        # eBay, live 2026-11-07: a route's call sent to the splash page.
        self.assertTrue(saw_a_door(["   [call] failed before any heal: the site answered 200, but not with an answer: the site sent it to another page (/splashui/challenge) that names this one to come back to: a sign-in or a wall"]))
        # Lazada, live 2026-11-09: a results page that loads a captcha vendor's script and its two frames, and nothing else.
        lazada = [self.seen(host="www.lazada.sg", path="/tag/airpods/"), self.seen(host="www.google.com", path="/recaptcha/enterprise.js", sort="asset"),
                  self.seen(host="www.gstatic.com", path="/recaptcha/releases/eiVW/recaptcha__en.js", sort="asset"),
                  self.seen(host="www.google.com", path="/recaptcha/enterprise/anchor", sort="page"), self.seen(host="www.google.com", path="/recaptcha/enterprise/bframe", sort="page"),
                  self.seen(host="www.lazada.sg", path="/tag/airpods/", sort="data")]
        self.assertFalse(saw_a_door(lazada))
        self.assertFalse(saw_a_door(lazada[:2]), "the script alone")
        self.assertTrue(saw_a_door([self.seen(method="POST", path="/recaptcha/enterprise/reload", sort="page")]), "a frame's POST sent something")
        self.assertTrue(saw_a_door([self.seen(path="/recaptcha/api2/userverify", sort="data")]), "the same vendor's call that answered is a door")

    def test_an_on_site_wall_shown_only_by_its_address_is_a_door(self):
        # eBay's splash and an on-site challenge page, each a 200 page on the host the walk landed on.
        landed = self.seen(host="www.ebay.com", path="/sch/i.html")
        self.assertTrue(saw_a_door([landed, self.seen(host="www.ebay.com", path="/splashui/challenge")]))
        self.assertTrue(saw_a_door([self.seen(host="shop.test", path="/s"), self.seen(host="shop.test", path="/__challenge/d8c1/index.html")]))
        # The same address on another host is a frame the page embeds, and a walk is keyed by its own field.
        self.assertFalse(saw_a_door([landed, self.seen(host="www.google.com", path="/recaptcha/enterprise/anchor")]))
        self.assertFalse(saw_a_door([landed, self.seen(walk="b", host="frames.test", path="/y"), self.seen(walk="b", host="www.google.com", path="/recaptcha/enterprise/bframe")]), "walk b landed on frames.test")
        self.assertTrue(saw_a_door([self.seen(walk="b", host="www.google.com", path="/y"), self.seen(walk="b", host="www.google.com", path="/recaptcha/enterprise/bframe")]), "on the host walk b landed on, it is that site's wall")

    def test_the_door_that_stopped_a_site_is_kept_short_on_its_check(self):
        line = self.seen(host="shop.test", path="/splashui/challenge")
        self.assertEqual(saw_a_door([self.seen(), line]), line, "the line that matched")
        self.assertIsNone(saw_a_door([self.seen()]))
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            log.write_text("")

            class Walled(FakeNode):
                def do(self, goal, url):
                    log.write_text(self_seen + "\n" + line + "\n")
                    return super().do(goal, url)

            self_seen = self.seen()
            site = run_site(Walled(GOOD, ROUTE), CASE, "zqnonsense", Files(node_log=log), gap=0, one_ask=True)
        self.assertEqual(site["checks"][0]["door"], "GET shop.test/splashui/challenge 200 page")
        self.assertLessEqual(len(site["checks"][0]["door"]), 160)

    def test_known_limit_a_wall_served_as_a_200_picture_is_not_seen(self):
        """A known limit, recorded: a wall that answers 200 with a page whose only content is a picture (a captcha image,
        a block notice drawn as one) has no refused status, no 202, no challenge address and no words a door shows, so the
        log can't tell it from a page. Its answer still fails the reads (`correct`), but the site is not stopped at it."""
        picture_wall = [self.seen(host="shop.test", path="/s", sort="page"), self.seen(host="shop.test", path="/static/blocked.png", sort="asset")]
        self.assertFalse(saw_a_door(picture_wall))
        self.assertIsNone(door_in("Shop\n"), "and its words, a title and nothing else, show no door either")

    def test_a_redirect_to_another_of_the_sites_hosts_is_no_wall(self):
        # From the same run: .com to .sg marks a gate at 200, and the site was only saying where it thinks you are.
        self.assertFalse(saw_a_door([self.seen(host="www.airbnb.com.sg", sort="gate")]))
        self.assertTrue(saw_a_door([self.seen(sort="gate", status=403)]))
        self.assertFalse(saw_a_door([self.seen(sort="asset", status=403)]), "an ad's 403 is the ad's")

    def test_a_call_refused_or_sent_to_a_wall_is_a_door_though_a_heal_gets_through(self):
        self.assertTrue(saw_a_door(["   [call] failed before any heal: step 1 (https://shop.test/s?q=a) answered 403: Error Page"]))
        self.assertTrue(saw_a_door(["   [call] failed before any heal: the site sent it to another page (/splashui/x) that names this one to come back to: a sign-in or a wall"]))
        self.assertFalse(saw_a_door(["   [call] failed before any heal: step 1 answered 500"]))

    def test_a_healed_call_stops_the_site_and_is_not_a_warm_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            log.write_text("")

            class Healed(FakeNode):
                def call(self, route_id, inputs):
                    log.write_text(log.read_text() + "   [call] failed before any heal: step 1 answered 403: Error Page\n   [heal] route drifted\n")
                    return super().call(route_id, inputs)

            node = Healed(GOOD, ROUTE)
            site = run_site(node, CASE, "zqnonsense", Files(node_log=log), gap=0, one_ask=True)
            self.assertEqual((site["stopped"], judge_site(site["checks"])), ("blocked", "blocked"))
            self.assertEqual(site["checks"][-1]["why"], "the_call_met_a_door")
            log.write_text("")
            site = run_site(Healed(GOOD, ROUTE), CASE, "zqnonsense", Files(node_log=log), gap=0)
            self.assertEqual(len(site["warm_answered_ms"]), 1, "only the replay: the rest walked again")

    def test_a_wall_on_a_later_call_stops_there(self):
        class Later(FakeNode):
            def call(self, route_id, inputs):
                if inputs == {"q": "garden hose reel"}:
                    self.calls.append(("call", inputs))
                    return 200, {"ok": True, "data": page("Verify you are human", title="Just a moment...")}
                return super().call(route_id, inputs)

        node = Later(GOOD, ROUTE)
        site = run(node)
        self.assertEqual(site["stopped"], "blocked")
        self.assertEqual(node.calls[-1], ("call", {"q": "garden hose reel"}))


class KeepsPickTests(unittest.TestCase):
    """Finding 4: the route stored is the call the model picked. The pick is read from the stand-in model's log."""

    def test_the_pick_is_read_from_the_log(self):
        self.assertEqual(goal_picks([model_entry(LAZADA_ROWS, 140)])[0]["row"]["index"], 140)
        self.assertEqual(goal_picks([{"request": {"questions": {"p1": {"type": "noul"}}}, "answers": {"p1": {"type": "noul", "noul": 0.5}}}]), [])
        self.assertEqual(goal_picks([dict(model_entry(LAZADA_ROWS, 140), answers=None)]), [], "a request the model failed picks nothing")

    def test_a_route_that_lost_the_picks_query_keys_fails_and_names_them(self):
        pick = goal_picks([model_entry(LAZADA_ROWS, 140)])[-1]
        found = keeps_pick_finding(LAZADA_STORED, "the decision model", pick, [], ["airpods"])
        self.assertEqual((found["outcome"], found["why"]), ("fail", "lost_query_keys"))
        self.assertEqual(found["lost"], ["ajax", "isFirstRequest", "page"])

    def test_a_route_that_kept_them_passes(self):
        pick = goal_picks([model_entry(LAZADA_ROWS, 140)])[-1]
        kept = dict(LAZADA_STORED, path="/tag/{path[1]}/?ajax=true&catalog_redirect_tag=true&isFirstRequest=true&page=1&q={q}")
        self.assertEqual(keeps_pick_finding(kept, "the decision model", pick, [], ["airpods"])["outcome"], "pass")

    def test_a_search_term_fixed_in_a_post_body_fails(self):
        rows = [{"index": 203, "method": "POST", "host": "shop.test", "path": "/aps/cf/1.0/certified-search/", "mime": "application/json", "resource_type": "XHR", "answers": ["results"], "records": 30}]
        route = {"id": "r2", "method": "POST", "path": "/aps/cf/1.0/{path[3]}/", "inputs": [{"name": "part0", "default": "search"}, {"name": "part1", "default": "iphone 15"}]}
        pick = goal_picks([model_entry(rows, 203)])[-1]
        steps = [{"method": "GET", "url": "https://shop.test/search"}, {"method": "POST", "url": "https://shop.test/aps/", "body": {"json": {"filters": {"query": "iPhone 15"}}}}]
        found = keeps_pick_finding(route, "the decision model", pick, steps, ["iphone 15"])
        self.assertEqual((found["outcome"], found["why"], found["fixed"]), ("fail", "value_fixed_in_the_body", ["iphone 15"]))
        self.assertEqual(keeps_pick_finding(route, "the decision model", pick, [{"body": {"json": {"filters": {"query": ""}}}}], ["iphone 15"])["outcome"], "pass")

    def test_a_different_call_fails(self):
        rows = LAZADA_ROWS[1:]
        pick = goal_picks([model_entry(rows, 140)])[-1]
        self.assertEqual(keeps_pick_finding(dict(LAZADA_STORED, path="/other/{path[1]}/"), "the decision model", pick, [], [])["why"], "stored_a_different_call")
        self.assertEqual(keeps_pick_finding(dict(LAZADA_STORED, method="POST"), "the decision model", pick, [], [])["why"], "stored_a_different_call")

    def test_a_pick_the_node_didnt_use_isnt_held_against_the_route(self):
        pick = goal_picks([model_entry(LAZADA_ROWS, 140)])[-1]
        self.assertEqual(keeps_pick_finding(LAZADA_STORED, "the rule", pick, [], [])["why"], "picked_by: the rule")
        self.assertEqual(keeps_pick_finding(None, None, None, [], [])["outcome"], "not_run")


class SseTests(unittest.TestCase):
    """Finding 5: a stream the walk saw reaches the model as a candidate."""

    CAPTURE = "\n".join([
        json.dumps({"type": "mint", "url": "https://shop.test/flights"}),
        json.dumps({"type": "request", "requestId": "1", "method": "GET", "url": "https://shop.test/flights?dcity=bjs", "resourceType": "Document"}),
        json.dumps({"type": "response", "requestId": "1", "url": "https://shop.test/flights?dcity=bjs", "status": 200, "mimeType": "text/html", "body": "x"}),
        json.dumps({"type": "request", "requestId": "2", "method": "POST", "url": "https://shop.test/restapi/FlightListSearchSSE", "resourceType": "Fetch"}),
        json.dumps({"type": "response", "requestId": "2", "url": "https://shop.test/restapi/FlightListSearchSSE", "status": 200, "mimeType": "text/event-stream", "body": 'data: {"flights": []}'}),
        json.dumps({"type": "request", "requestId": "3", "method": "GET", "url": "https://shop.test/live/chatter", "resourceType": "EventSource"}),
        json.dumps({"type": "response", "requestId": "3", "url": "https://shop.test/live/chatter", "status": 200, "mimeType": "text/event-stream", "body": "event: ping\ndata: 1"}),
        "not json",
    ])

    def test_a_capture_is_read_for_names_and_kinds_only(self):
        calls = calls_in_capture(self.CAPTURE)
        self.assertEqual([c["mime"] for c in calls], ["text/html", "text/event-stream", "text/event-stream"])
        self.assertEqual(calls[0]["path"], "/flights?dcity", "a query's names, never its values")

    def test_a_stream_the_model_was_never_shown_fails(self):
        found = sse_finding(calls_in_capture(self.CAPTURE), LAZADA_ROWS[:1], True)
        self.assertEqual((found["outcome"], found["why"]), ("fail", "stream_never_a_candidate"))

    def test_a_stream_it_was_shown_passes(self):
        rows = [{"method": "POST", "path": "/restapi/FlightListSearchSSE", "mime": "text/event-stream"}]
        self.assertEqual(sse_finding(calls_in_capture(self.CAPTURE), rows, True)["outcome"], "pass")

    def test_a_stream_of_no_data_is_no_candidate_owed(self):
        rows = [{"method": "POST", "path": "/restapi/FlightListSearchSSE", "mime": "text/event-stream"}]
        self.assertEqual(sse_finding(calls_in_capture(self.CAPTURE), rows, True)["streams"], ["/restapi/FlightListSearchSSE"], "pings aren't data")

    def test_no_stream_or_no_model_is_no_verdict(self):
        self.assertEqual(sse_finding([], LAZADA_ROWS, True)["why"], "no_event_stream_in_the_walk")
        self.assertEqual(sse_finding(calls_in_capture(self.CAPTURE), [], False)["why"], "the_model_was_not_asked")

    def test_a_run_reads_the_captures_of_its_own_walks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp, "home", "node")
            home.mkdir(parents=True)
            walks = Path(tmp, "tmp", "unbrowse-node-walks")
            walks.mkdir(parents=True)
            Path(walks, "learn_old.jsonl").write_text(self.CAPTURE)
            os.utime(walks / "learn_old.jsonl", (1000, 1000))
            self.assertEqual(Files(node_home=home).walked_calls(5000), [], "an older walk's is another site's")
            Path(walks, "learn_new.jsonl").write_text(self.CAPTURE)
            self.assertEqual(len(Files(node_home=home).walked_calls(5000)), 3)
            self.assertEqual(Files().walked_calls(0), [])


class ShortValueTests(unittest.TestCase):
    """Finding 6: `vary` shows a relearn. This reads the constant off the stored route, whatever the replay did."""

    def test_a_one_character_value_written_in_is_named(self):
        self.assertEqual(fixed_short_values("/s/{path[1]}/homes?adults=2", "https://shop.test/s/bangkok/homes?adults=2"), ["adults"])
        self.assertEqual(fixed_short_values("/s/{path[1]}/homes?adults={adults}", "https://shop.test/s/bangkok/homes?adults=2"), [])

    def test_a_longer_constant_is_not_this_finding(self):
        self.assertEqual(fixed_short_values("/s?lang=en&q={q}", "https://shop.test/s?lang=en&q=a"), [], "`q=a` is bound, `lang` isn't one character")

    def test_verdicts(self):
        self.assertEqual(short_values_finding({"path": "/s?adults=2&q={q}"}, "https://shop.test/s?adults=2&q=kettle")["fixed"], ["adults"])
        self.assertEqual(short_values_finding({"path": "/s?adults={adults}&q={q}"}, "https://shop.test/s?adults=2&q=kettle")["outcome"], "pass")
        self.assertEqual(short_values_finding({"path": "/s?q={q}"}, "https://shop.test/s?q=kettle")["outcome"], "not_run")
        self.assertEqual(short_values_finding(None, "https://shop.test/s?a=1")["outcome"], "not_run")


class InputsTests(unittest.TestCase):
    """Finding 7: `inputs: []` already fails the replay; this adds the copies that pile up."""

    MAPS = {"method": "GET", "path": "/search?tbm=map&q={q}&pb={pb}", "inputs": []}

    def test_no_inputs_fails(self):
        self.assertEqual(inputs_finding(self.MAPS, None, [self.MAPS])["why"], "stored_with_no_inputs")

    def test_copies_of_one_call_fail_whatever_their_values(self):
        route = dict(self.MAPS, inputs=[{"name": "q"}])
        copies = [dict(route, id=str(n), path=f"/search?tbm=map&q={{q}}&pb={n}") for n in range(3)]
        found = inputs_finding(route, "q", copies)
        self.assertEqual((found["why"], found["copies"]), ("copies_piled_up", 3))

    def test_a_second_route_for_a_second_guest_count_fails(self):
        route = {"method": "GET", "path": "/s/{path[1]}/homes?adults=1", "inputs": [{"name": "part1"}]}
        self.assertEqual(inputs_finding(route, "part1", [route, dict(route, path="/s/{path[1]}/homes?adults=2&tab=x")])["why"], "copies_piled_up")

    def test_one_route_with_its_input_passes(self):
        route = dict(self.MAPS, inputs=[{"name": "q"}])
        self.assertEqual(inputs_finding(route, "q", [route])["outcome"], "pass")
        self.assertEqual(inputs_finding(route, None, [route])["why"], "no_input_carries_the_query")
        self.assertEqual(inputs_finding(None, None, [])["outcome"], "not_run")

    def test_a_run_counts_the_routes_it_added_not_those_before_it(self):
        class Grows(FakeNode):
            def routes(self):
                return [ROUTE, dict(ROUTE, id="r2")] if self.calls else [dict(ROUTE, id="old")]

        site = run(Grows(GOOD, ROUTE))
        self.assertEqual(site["findings"]["inputs"]["routes_added"], 2)
        self.assertEqual(site["findings"]["inputs"]["why"], "copies_piled_up")


class StubModel:
    """The offline decision model of finding 8: answers every request with a fixed body and counts them. It is apart from
    decision_shim.py on purpose: the shim is a stand-in that always sends `type`, and this exists to leave it out."""

    TYPELESS = {"answers": {"goal": {"choice": "1", "probabilities": {"1": 0.9}, "confidence": 0.9}}}

    def __init__(self, reply=None):
        self.requests = []
        stub = self
        body = json.dumps(reply or self.TYPELESS).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                stub.requests.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0))))
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FallbackTests(unittest.TestCase):
    """Finding 8: a reply with no `type` falls back to the rule. The fallback is fine; silence isn't."""

    SAID = "judge: the decision model's answer was no answer, so the rule decides: missing field `type`"

    def test_a_fallback_the_log_says_passes(self):
        self.assertEqual(fallback_finding(1, ["walk", self.SAID], "the rule")["outcome"], "pass")

    def test_a_silent_fallback_fails(self):
        self.assertEqual(fallback_finding(1, ["walk"], "the rule")["why"], "silent_fallback")

    def test_crediting_the_model_for_it_fails(self):
        self.assertEqual(fallback_finding(1, [self.SAID], "the decision model")["why"], "credits_a_model_that_gave_no_answer")

    def test_a_model_never_asked_says_nothing(self):
        self.assertEqual(fallback_finding(0, [], "the rule")["outcome"], "not_run")

    def test_the_stub_really_leaves_the_type_out(self):
        stub = StubModel()
        self.addCleanup(stub.close)
        request = urllib.request.Request(stub.base + "/v1/systemone", data=b'{"questions": {}}', method="POST")
        with urllib.request.urlopen(request) as reply:
            self.assertNotIn("type", json.load(reply)["answers"]["goal"])
        self.assertEqual(len(stub.requests), 1)


class ResourceTests(unittest.TestCase):
    """Finding 9: `browsers_left` counted; this measures the node itself and holds it to a threshold."""

    PS = "\n".join([
        "100 1 900000 /scratch/target/debug/unbrowse-node",
        "101 100 50000 /Applications/Chrome --headless --user-data-dir=/scratch/tmp/x",
        "102 101 40000 /Applications/Chrome Helper --type=renderer",
        "103 1 30000 /Applications/Chrome --user-data-dir=/scratch/home/node/profile",
        "104 1 25000 /Applications/Chrome --user-data-dir=/Users/me/Library/Chrome",
        "105 1 1000 python3 run_bank.py --node-home /scratch/home/node",
    ])

    def test_the_tree_counts_the_nodes_own_and_browsers_under_its_folders(self):
        tree = node_tree(self.PS, 100, ["/scratch/home/node", "/scratch/tmp"])
        self.assertEqual(tree, {"node_rss_mb": 878, "processes_left": 3, "left_rss_mb": 117})

    def test_what_eden_saw_fails_both_ways(self):
        found = resources_finding({"node_rss_mb": 800, "processes_left": 88, "left_rss_mb": 900})
        self.assertEqual((found["outcome"], found["why"]), ("fail", ["rss", "processes"]))

    def test_the_thresholds_hold_at_their_edge(self):
        self.assertEqual(resources_finding({"node_rss_mb": MAX_NODE_RSS_MB, "processes_left": MAX_PROCESSES_LEFT, "left_rss_mb": 0})["outcome"], "pass")
        self.assertEqual(resources_finding({"node_rss_mb": MAX_NODE_RSS_MB + 1, "processes_left": 0, "left_rss_mb": 0})["why"], ["rss"])
        self.assertEqual(resources_finding({"node_rss_mb": 10, "processes_left": MAX_PROCESSES_LEFT + 1, "left_rss_mb": 0})["why"], ["processes"])

    def test_no_node_to_measure_is_no_verdict(self):
        self.assertEqual(resources_finding(None)["outcome"], "not_run")
        self.assertEqual(resources_finding(node_tree(self.PS, 999, []))["outcome"], "not_run")
        self.assertIsNone(Files().tree())


class ReportTests(unittest.TestCase):
    def test_the_report_counts_findings_and_says_who_decided(self):
        site = run(FakeNode(GOOD, ROUTE))
        report = build_report({"sites": [site], "judgments": [], "odd_links": [], "resources": {"outcome": "pass"}}, {})
        self.assertEqual(report["findings"]["correct"], {"pass": 1})
        self.assertEqual(report["resources"], {"outcome": "pass"})
        self.assertIn("| shop.test | pass | not_run |", findings_table(report))
        self.assertEqual(problems(report), [])

    def test_an_unknown_finding_or_a_speed_verdict_without_a_browser_is_refused(self):
        site = dict(run(FakeNode(GOOD, ROUTE)), findings={"warm_speed": {"outcome": "pass"}, "correct": {"outcome": "looks_fine"}})
        found = problems(build_report({"sites": [site], "judgments": [], "odd_links": []}, {}))
        self.assertTrue(any("speed verdict" in p for p in found))
        self.assertTrue(any("looks_fine" in p for p in found))

    def test_every_case_declares_only_what_the_run_reads(self):
        for case in json.loads((HERE / "search-cases.json").read_text())["cases"]:
            self.assertLessEqual(set(case.get("expect", ())), {"price"}, case["site"])

    def test_the_reports_ten_sites_all_have_a_case(self):
        cases = {c["site"]: c for c in json.loads((HERE / "search-cases.json").read_text())["cases"]}
        for site in ("www.google.com", "ebay.com", "airbnb.com", "carousell.sg", "lazada.com", "lazada.sg", "amazon.com", "booking.com", "google.com", "opentable.com", "trip.com"):
            self.assertIn(site, cases)
            self.assertTrue(cases[site]["url"].startswith("https://"))
        self.assertTrue(first_party({"site": "www.google.com"}, "www.google.com"), "the second Google case is its own site in the report")


class ShimTests(unittest.TestCase):
    """decision_shim.py, with a fake in place of the CLI: its wire format is what keeps the node from falling back."""

    GOAL = {"goal": {"type": "choice", "instructions": "Which?", "criteria": {"140": "x", "3": "y"}}}
    NOUL = {"p0": {"type": "noul", "instructions": "Is it?"}, "p1": {"type": "noul", "instructions": "Is it?"}}

    def shim(self, reply):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        asked = []

        def asker(prompt):
            asked.append(prompt)
            if isinstance(reply, Exception):
                raise reply
            return reply, "claude-test"

        return decision_shim.Shim("sonnet", Path(folder, "log.jsonl"), asker), asked

    def test_every_answer_carries_its_questions_type(self):
        shim, _ = self.shim('{"goal": {"choice": 140, "probabilities": {"140": 0.9}, "confidence": 0.8}}')
        status, reply = shim.answer({"state": {}, "questions": self.GOAL})
        self.assertEqual(status, 200)
        self.assertEqual(reply["answers"]["goal"], {"type": "choice", "choice": "140", "probabilities": {"140": 0.9}, "confidence": 0.8})
        shim, _ = self.shim('```json\n{"p0": {"noul": 0.2, "confidence": 0.9}, "p1": {"noul": 0.8}}\n```')
        answers = shim.answer({"state": {}, "questions": self.NOUL})[1]["answers"]
        self.assertEqual((answers["p0"]["type"], answers["p1"]["noul"]), ("noul", 0.8))

    def test_a_choice_outside_the_criteria_and_an_unasked_answer_are_dropped(self):
        shim, _ = self.shim('{"goal": {"choice": "9", "confidence": 0.9}, "other": {"noul": 1}}')
        self.assertEqual(shim.answer({"questions": self.GOAL})[1]["answers"], {})

    def test_a_failed_cli_invents_nothing_and_is_logged(self):
        for reply in (RuntimeError("not logged in"), "no json here", subprocess.TimeoutExpired("claude", 28)):
            shim, _ = self.shim(reply)
            status, said = shim.answer({"questions": self.GOAL})
            self.assertEqual(status, 503)
            self.assertNotIn("answers", said)
            self.assertIn("error", json.loads(shim.log.read_text()))

    def test_no_questions_costs_no_call(self):
        shim, asked = self.shim("{}")
        self.assertEqual(shim.answer({"questions": {}}), (200, {"answers": {}}))
        self.assertEqual(asked, [])

    def test_every_request_and_answer_is_logged_and_says_it_is_a_stand_in(self):
        shim, _ = self.shim('{"goal": {"choice": "3", "confidence": 0.8}}')
        shim.answer({"state": {"goal": "search"}, "questions": self.GOAL})
        entry = json.loads(shim.log.read_text())
        self.assertEqual(entry["request"]["state"], {"goal": "search"})
        self.assertEqual(entry["answers"]["goal"]["choice"], "3")
        self.assertIn("not Clef", entry["source"])
        self.assertEqual(entry["used"], "claude-test")

    def test_its_log_is_what_the_run_reads(self):
        shim, _ = self.shim('{"goal": {"choice": "140", "probabilities": {"140": 0.9}, "confidence": 0.8}}')
        shim.answer({"state": {"exchanges": LAZADA_ROWS}, "questions": self.GOAL})
        lines = Files(model_log=shim.log).model_lines()
        self.assertEqual(goal_picks(lines)[0]["row"]["index"], 140)
        self.assertEqual(len(offered_rows(lines)), 2)

    def test_it_binds_to_this_machine_only_and_answers_over_http(self):
        shim, _ = self.shim('{"goal": {"choice": "3", "confidence": 0.8}}')
        server = decision_shim.server(shim)
        self.addCleanup(server.server_close)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        threading.Thread(target=server.handle_request, daemon=True).start()
        request = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/v1/systemone", data=json.dumps({"questions": self.GOAL}).encode(), method="POST")
        with urllib.request.urlopen(request) as reply:
            self.assertEqual(json.load(reply)["answers"]["goal"]["type"], "choice")


class BlueFindingTests(unittest.TestCase):
    """What the review of 2026-11-07 found the bank claiming and not doing."""

    def test_a_timeout_is_not_retried_when_a_door_might_be_behind_it(self):
        class Slow(FakeNode):
            def do(self, goal, url):
                self.calls.append(("do", url))
                return 0, {"error": "timeout or no answer"}

        node = Slow(GOOD, ROUTE)
        site = run_site(node, CASE, "zqnonsense", Files(), gap=0, one_ask=True)
        self.assertFalse(site["retried_timeout"])
        self.assertEqual(site["stopped"], "timeout")
        self.assertEqual([c["step"] for c in site["checks"]], ["first"])
        self.assertEqual(len(node.calls), 1, "one ask, then nothing more of the site")
        node = Slow(GOOD, ROUTE)
        self.assertTrue(run_site(node, CASE, "zqnonsense", Files(), gap=0)["retried_timeout"], "a run without the flag retries as it did")
        self.assertEqual(len(node.calls), 4)

    def test_a_timeout_on_a_later_ask_or_call_ends_the_site(self):
        class SlowReplay(FakeNode):
            def do(self, goal, url):
                return (0, {"error": "timeout or no answer"}) if "teapot" in url else FakeNode.do(self, goal, url)

        node = SlowReplay(GOOD, ROUTE)
        site = run_site(node, CASE, "zqnonsense", Files(), gap=0, one_ask=True)
        self.assertEqual((site["stopped"], [c["step"] for c in site["checks"]]), ("timeout", ["first", "replay"]))

        class SlowCall(FakeNode):
            def call(self, route_id, inputs):
                self.calls.append(("call", inputs))
                return 0, {"error": "timeout or no answer"}

        node = SlowCall(GOOD, ROUTE)
        site = run_site(node, CASE, "zqnonsense", Files(), gap=0, one_ask=True)
        self.assertEqual((site["stopped"], [c["step"] for c in site["checks"]]), ("timeout", ["first", "replay", "call_unrelated"]))
        self.assertEqual(sum(1 for how, _ in node.calls if how == "call"), 1, "the call that timed out is the last")
        node = SlowCall(GOOD, ROUTE)
        self.assertIsNone(run_site(node, CASE, "zqnonsense", Files(), gap=0)["stopped"], "a run without the flag goes on as it did")

    def guard(self, folder, one_ask):
        Path(folder, "guard.log").write_text("")
        Path(folder, "guard-browser").write_text(f'#!/bin/sh\nif [ "{"1" if one_ask else ""}" = 1 ]; then\n  exit 1\nfi\n')
        return str(Path(folder, "guard.log"))

    def test_one_ask_refuses_a_run_that_cant_honour_it(self):
        self.assertIn("--node-log", run_bank.one_ask_refusal(None, "/x/guard.log"))
        self.assertIn("--guard-log", run_bank.one_ask_refusal("/x/node.log", None))
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "node.log")
            self.assertIn("doesn't exist", run_bank.one_ask_refusal(str(log), self.guard(tmp, one_ask=True)), "a mistyped log would see no wall, ever")
            log.write_text("")
            Path(tmp, "guard-browser").unlink()
            self.assertIn("ONE_ASK=1", run_bank.one_ask_refusal(str(log), str(Path(tmp, "guard.log"))), "no guard file at all")
            self.assertIn("ONE_ASK=1", run_bank.one_ask_refusal(str(log), self.guard(tmp, one_ask=False)))
            self.assertIsNone(run_bank.one_ask_refusal(str(log), self.guard(tmp, one_ask=True)))

    def test_the_guards_on_switch_is_what_the_check_reads(self):
        self.assertIn('if [ "${ONE_ASK:-}" = 1 ]; then', (HERE / "scratch-node.sh").read_text())

    def run_args(self, tmp, *more):
        Path(tmp, "token").write_text("t")
        settings = Path(tmp, "home", "node", "settings.json")
        if not settings.exists():
            settings.parent.mkdir(parents=True, exist_ok=True)
            settings.write_text('{"private_network": false}')
        cases = Path(tmp, "cases.json")
        if not cases.exists():
            cases.write_text(json.dumps({"cases": [dict(CASE, site="a.test", registrable="a.test"), dict(CASE, site="www.a.test"), dict(CASE, site="b.test")]}))
        return ["run", "--token-file", str(Path(tmp, "token")), "--cases", str(cases), "--seed", "s", "--out", str(Path(tmp, "out.json")), "--gap", "0", "--site-gap", "0", "--browser-program", "none", *more]

    def test_a_runtime_that_cant_hold_a_page_stops_the_run_before_the_node_is_asked(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(run_bank, "Node") as node, mock.patch.dict(os.environ, {"SIGNING_PROGRAM": runtime(tmp, False)}):
            with self.assertRaises(SystemExit) as stopped:
                run_bank.main(self.run_args(tmp, "--sites", "a.test"))
            self.assertIn("Node 25", str(stopped.exception))
            node.assert_not_called()

    def test_one_ask_without_logs_stops_before_the_node_is_asked(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(run_bank, "Node") as node:
            with self.assertRaises(SystemExit) as stopped:
                run_bank.main(self.run_args(tmp, "--sites", "a.test", "--one-ask"))
            self.assertIn("--node-log", str(stopped.exception))
            node.assert_not_called()

    def batch(self, tmp, sites, outcome="blocked"):
        ran = []

        def fake_run(node, case, *rest):
            ran.append(case["site"])
            return {"site": case["site"], "checks": [{"step": "first", "outcome": outcome}], "calls": 1, "stopped": "blocked" if outcome == "blocked" else None, "retried_timeout": False, "paid_usdc": 0}

        with mock.patch.object(run_bank, "Node"), mock.patch.object(run_bank, "run_site", fake_run), mock.patch.object(run_bank, "check_links", return_value={}), mock.patch.object(run_bank, "check_odd_links", return_value=[]), mock.patch.object(run_bank, "digest"):
            run_bank.main(self.run_args(tmp, "--sites", sites))
        return ran

    def test_a_wall_stops_its_sibling_in_the_batch_and_in_the_next(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.batch(tmp, "a.test,www.a.test,b.test"), ["a.test", "b.test"])
            doc = json.loads(Path(tmp, "out.json").read_text())
            self.assertEqual(doc["sites"][0]["registrable"], "a.test")
            self.assertEqual(doc["skipped"][0]["site"], "www.a.test")
            self.assertEqual(self.batch(tmp, "www.a.test"), [], "another batch on the same --out holds to it")
            self.assertEqual(len(json.loads(Path(tmp, "out.json").read_text())["sites"]), 2)

    def test_a_site_with_no_wall_stops_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.batch(tmp, "a.test,www.a.test", outcome="pass"), ["a.test", "www.a.test"])

    def test_the_second_google_case_shares_the_firsts_domain(self):
        cases = {c["site"]: c for c in json.loads((HERE / "search-cases.json").read_text())["cases"]}
        self.assertEqual(run_bank.registrable(cases["www.google.com"]), run_bank.registrable(cases["google.com"]))
        self.assertEqual(walled_of([{"site": "www.old.test", "stopped": "blocked", "checks": []}]), {"old.test"}, "a file written before the field")

    def test_a_private_node_refuses_live_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp, "home", "node")
            home.mkdir(parents=True)
            live, stub = dict(CASE, site="shop.test"), dict(CASE, site="stub", url="http://127.0.0.1:9/s?q={q}")
            home.joinpath("settings.json").write_text('{"private_network": true}')
            self.assertIn("shop.test", run_bank.private_node_refusal([live, stub], str(home), str(Path(tmp, "token"))))
            self.assertIsNone(run_bank.private_node_refusal([stub], str(home), str(Path(tmp, "token"))))
            self.assertIn("shop.test", run_bank.private_node_refusal([live], None, str(Path(tmp, "token"))), "found beside the token too")
            home.joinpath("settings.json").write_text('{"private_network": false}')
            self.assertIsNone(run_bank.private_node_refusal([live], str(home), str(Path(tmp, "token"))))
            with mock.patch.object(run_bank, "Node") as node, self.assertRaises(SystemExit):
                home.joinpath("settings.json").write_text('{"private_network": true}')
                Path(tmp, "cases.json").write_text(json.dumps({"cases": [dict(live, site="a.test")]}))
                run_bank.main(self.run_args(tmp, "--sites", "a.test"))
            node.assert_not_called()

    def test_a_node_whose_settings_cant_be_found_gets_no_live_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            token = str(Path(tmp, "token"))
            live, stub = dict(CASE, site="shop.test"), dict(CASE, site="stub", url="http://127.0.0.1:9/s?q={q}")
            self.assertIn("--node-home", run_bank.private_node_refusal([live, stub], None, token))
            self.assertIn("--node-home", run_bank.private_node_refusal([live], str(Path(tmp, "nowhere")), token))
            self.assertIsNone(run_bank.private_node_refusal([stub], None, token), "a stub site needs no clearing")
            Path(tmp, "cases.json").write_text(json.dumps({"cases": [dict(live, site="a.test")]}))
            Path(tmp, "token").write_text("t")
            args = ["run", "--token-file", token, "--cases", str(Path(tmp, "cases.json")), "--seed", "s", "--out", str(Path(tmp, "out.json")), "--sites", "a.test"]
            with mock.patch.object(run_bank, "Node") as node, self.assertRaises(SystemExit) as stopped:
                run_bank.main(args)
            self.assertIn("--node-home", str(stopped.exception))
            node.assert_not_called()

    def test_a_json_call_nothing_could_read_clears_no_page(self):
        walked = [{"method": "GET", "path": "/s", "mime": "text/html", "resource_type": "Document"}, {"method": "POST", "path": "/api/search", "mime": "application/json", "resource_type": "XHR"}]
        self.assertEqual(data_route_finding(ROUTE, True, [], walked)["why"], "a_data_call_nothing_could_read")
        for mime in ("text/plain", "text/event-stream", "application/vnd.api+json"):
            self.assertEqual(data_route_finding(ROUTE, True, [], [dict(walked[1], mime=mime)])["why"], "a_data_call_nothing_could_read", mime)
        self.assertEqual(data_route_finding(ROUTE, True, [], [dict(walked[0], mime="text/plain")])["outcome"], "pass", "a Document isn't a call")
        self.assertEqual(data_route_finding(ROUTE, True, [], walked[:1])["outcome"], "pass", "a walk with no JSON call has nothing else to store")
        self.assertEqual(data_route_finding(dict(ROUTE, path="/api?q={q}"), False, [], walked)["outcome"], "pass", "a data route is judged by itself")

    def test_a_post_with_no_route_file_says_nothing_of_its_body(self):
        rows = [{"index": 2, "method": "POST", "host": "shop.test", "path": "/api/search", "mime": "application/json"}]
        route = {"method": "POST", "path": "/api/search", "inputs": [{"name": "q"}]}
        pick = goal_picks([model_entry(rows, 2)])[-1]
        self.assertEqual(keeps_pick_finding(route, "the decision model", pick, [], ["kettle"])["why"], "no_route_file_to_read_its_body")
        self.assertEqual(keeps_pick_finding(route, "the decision model", pick, [{"body": {"q": ""}}], ["kettle"])["outcome"], "pass")
        self.assertEqual(keeps_pick_finding(LAZADA_STORED | {"path": "/tag/{path[1]}/?ajax=1&catalog_redirect_tag=1&isFirstRequest=1&page=1&q={q}"}, "the decision model", goal_picks([model_entry(LAZADA_ROWS, 140)])[-1], [], [])["outcome"], "pass", "a GET has no body to read")

    def test_a_short_value_passes_only_on_its_placeholder(self):
        walked = "https://shop.test/s?adults=2&q=kettle"
        found = short_values_finding({"path": "/api/search?q={q}"}, walked)
        self.assertEqual((found["outcome"], found["absent"]), ("not_run", ["adults"]))
        self.assertEqual(short_values_finding({"path": "/s?adults={adults}&q={q}"}, walked)["outcome"], "pass")
        self.assertEqual(short_values_finding({"path": "/s?adults=2&q={q}"}, walked)["outcome"], "fail")

    def test_a_half_written_last_line_of_the_model_log_is_left_for_next_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp, "shim.jsonl")
            log.write_text('{"a": 1}\n{"b":')
            self.assertEqual(Files(model_log=log).model_lines(), [{"a": 1}])
            log.write_text('{"a": 1}\n{"b": 2}\n')
            self.assertEqual(len(Files(model_log=log).model_lines()), 2)
            log.write_bytes(b'{"a": 1}\n{"b": "\xe2')  # cut inside a character
            self.assertEqual(Files(model_log=log).model_lines(), [{"a": 1}])
            log.write_text('{"a"\n{"b": 2}\n')
            with self.assertRaises(ValueError):
                Files(model_log=log).model_lines()


def walled_of(sites):
    return run_bank.walled_domains({"sites": sites})


def runtime(folder, holds):
    """A stand-in for the runtime a node signs a page's calls in: one that takes the permission flag and passes the probe,
    or one that refuses the flag as a Node before the permission model does."""
    path = Path(folder, "holds" if holds else "old")
    path.write_text("#!/bin/sh\nexit 0\n" if holds else '#!/bin/sh\necho "bad option: $1" >&2\nexit 9\n')
    path.chmod(0o755)
    return str(path)


class RuntimeRefusalTests(unittest.TestCase):
    """The bank runs only where the runtime the node signs in can hold a page's code: no child process, no network."""

    def test_a_runtime_that_holds_is_let_through_and_one_that_cant_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(run_bank.runtime_refusal(runtime(tmp, True)))
            self.assertIn("Node 25", run_bank.runtime_refusal(runtime(tmp, False)))
            self.assertIn("Node 25", run_bank.runtime_refusal(str(Path(tmp, "nowhere"))))

    def test_scratch_node_refuses_it_before_it_writes_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp, "run")
            # A node that isn't there: were the refusal ever lost, nothing would start.
            env = {"PATH": os.environ["PATH"], "PORT": "17899", "NODE": str(Path(tmp, "debug", "unbrowse-node")), "SIGNING_PROGRAM": runtime(tmp, False)}
            done = subprocess.run(["sh", str(HERE / "scratch-node.sh"), str(folder)], env=env, capture_output=True, text=True, timeout=30)
            self.assertFalse(folder.exists(), "nothing written")
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("Node 25", done.stderr)


class ScratchScriptRefusalTests(unittest.TestCase):
    """scratch-node.sh refuses what would reach the owner, before it writes anything."""

    def refused(self, **env):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp, "run")
            done = subprocess.run(["sh", str(HERE / "scratch-node.sh"), str(folder)], env={"PATH": os.environ["PATH"], "PORT": "17899", **env}, capture_output=True, text=True, timeout=30)
            self.assertFalse(folder.exists(), "nothing written")
        self.assertEqual(done.returncode, 1, done.stderr)
        return done.stderr

    def test_a_node_that_isnt_a_debug_build(self):
        self.assertIn("debug build", self.refused(NODE="/x/target/release/unbrowse-node"))

    def test_a_port_that_isnt_a_plain_number(self):
        for port in ("abc", "17810;x", "0", "07788", "17 810", "-1"):
            self.assertIn("PORT must be", self.refused(PORT=port), port)

    def test_a_window_allowed_on_a_run_that_takes_a_wall_as_a_fail(self):
        self.assertIn("can't both hold", self.refused(ALLOW_HEADED="1", ONE_ASK="1"))

    def test_the_owners_port(self):
        self.assertIn("owner's port", self.refused(PORT="7788"))

    def test_a_port_a_node_already_answers_on(self):
        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Health)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.handle_request, daemon=True).start()
        self.assertIn("already answers", self.refused(PORT=str(server.server_address[1])))

    def test_a_private_network_that_isnt_a_boolean(self):
        self.assertIn("true or false", self.refused(PRIVATE_NETWORK='true,"x":1'))

    def test_a_model_off_this_machine_or_dressed_as_on_it(self):
        for base in ("https://api.example.test", "http://example.test:80", "http://127.0.0.1:1@example.test", "http://127.0.0.1:1/x", "http://127.0.0.1:", "http://localhost:1"):
            self.assertIn("MODEL_BASE", self.refused(MODEL_BASE=base), base)


FAKE_NODE = r"""#!/bin/sh
# A stand-in for a debug node: names the agent's number to `agent new` as the node does, says a key to `agent token <n>`,
# writes the environment it was started with, answers health.
if [ "$1 $2" = "agent new" ]; then echo 'export UNBROWSE_AGENT_TOKEN="$(/x/debug/unbrowse-node agent token 1)"'; exit 0; fi
if [ "$1 $2 $3" = "agent token 1" ]; then echo "unb_fake_token_for_tests"; exit 0; fi
if [ "$1" = agent ]; then exit 1; fi
env > "$UNBROWSE_HOME/node.env"
exec /usr/bin/python3 -c '
import http.server, json, os
port = json.load(open(os.environ["UNBROWSE_HOME"] + "/settings.json"))["api_port"]
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()
    def log_message(self, *_):
        pass
http.server.HTTPServer(("127.0.0.1", port), Health).serve_forever()
'
"""


@unittest.skipUnless(Path("/usr/bin/python3").exists(), "the stand-in node runs under /usr/bin/python3")
class ScratchScriptGuardTests(unittest.TestCase):
    """What scratch-node.sh really writes and starts, on a stand-in node: the guards a wall run leans on, and the decision
    model a node gets when nobody names one."""

    def start(self, **env):
        folder = Path(tempfile.mkdtemp(prefix="bkg"))
        self.addCleanup(shutil.rmtree, folder, True)
        node = folder / "target" / "debug" / "unbrowse-node"
        node.parent.mkdir(parents=True)
        node.write_text(FAKE_NODE)
        node.chmod(0o755)
        for name in ("program", "chrome"):
            fake = folder / name
            fake.write_text(f'#!/bin/sh\necho "{name.upper()}_RAN $*" >> "{folder}/ran"\n')
            fake.chmod(0o755)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        run = folder / "run"
        done = subprocess.run(["sh", str(HERE / "scratch-node.sh"), str(run)], capture_output=True, text=True, timeout=60,
                              env={"PATH": os.environ["PATH"], "PORT": str(port), "NODE": str(node), "BROWSER_PROGRAM": str(folder / "program"), "CHROME": str(folder / "chrome"), **env})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.addCleanup(lambda: subprocess.run(["kill", (run / "node.pid").read_text().strip()], check=False))
        return folder, run

    def ran(self, folder):
        file = folder / "ran"
        return file.read_text() if file.exists() else ""

    def node_env(self, run):
        for _ in range(50):
            file = run / "home" / "node" / "node.env"
            if file.exists() and "UNBROWSE_HOME" in file.read_text():
                return dict(line.split("=", 1) for line in file.read_text().splitlines() if "=" in line)
            time.sleep(0.1)
        self.fail("the node never wrote its environment")

    def test_under_one_ask_no_browser_takes_over_after_a_held_clean_browser(self):
        folder, run = self.start(ONE_ASK="1")
        clean = subprocess.run([str(run / "guard-chrome"), "--headless", "--user-data-dir=/x/profiles/1b4e28ba-2fa1-11d2-883f-0016d3cca427"])
        self.assertEqual(clean.returncode, 1)
        # What the node does next: its walk falls back to the program, and a failed walk hands the page over.
        for args in (["--session", "learn_a1", "open", "https://shop.test/"], ["--session", "browse_shop_test", "open", "https://shop.test/"],
                     ["--session", "browse_shop_test", "snapshot", "-i"], ["--session", "call_r1", "open", "https://shop.test/"]):
            self.assertEqual(subprocess.run([str(run / "guard-browser"), *args], capture_output=True).returncode, 1, args)
        self.assertEqual(self.ran(folder), "", "neither Chrome nor the program ran after the held clean browser")
        guard = (run / "guard.log").read_text()
        self.assertTrue(guard.startswith("HELD_CLEAN"), guard)
        self.assertEqual(guard.count("HELD_PROGRAM"), 4)
        self.assertEqual(subprocess.run([str(run / "guard-browser"), "--session", "learn_a1", "close"]).returncode, 0)
        self.assertIn("PROGRAM_RAN --session learn_a1 close", self.ran(folder), "a browser may always be closed")

    def test_without_one_ask_the_program_and_chrome_run_as_before(self):
        folder, run = self.start()
        subprocess.run([str(run / "guard-browser"), "--session", "browse_shop_test", "open", "https://shop.test/"])
        subprocess.run([str(run / "guard-chrome"), "--headless", "--user-data-dir=/x/profiles/1b4e28ba-2fa1-11d2-883f-0016d3cca427"])
        self.assertIn("PROGRAM_RAN --session browse_shop_test open", self.ran(folder))
        self.assertIn("CHROME_RAN --headless", self.ran(folder))

    def test_the_script_leaves_no_copy_of_itself_behind_the_node(self):
        # The node it started runs on; the script that started it does not. A copy left waiting per node started was the
        # `scratch-node.sh` shells a day of restarts left behind.
        _, run = self.start()
        self.node_env(run)
        left = subprocess.run(["ps", "-A", "-o", "command="], capture_output=True, text=True).stdout
        self.assertEqual([l for l in left.splitlines() if "scratch-node.sh" in l and str(run) in l], [])
        node = (run / "node.pid").read_text().strip()
        parent = subprocess.run(["ps", "-o", "command=", "-p", subprocess.run(["ps", "-o", "ppid=", "-p", node], capture_output=True, text=True).stdout.strip()], capture_output=True, text=True).stdout
        self.assertNotIn("scratch-node.sh", parent, "the node's parent is no copy of the script")

    def test_a_node_nobody_named_a_model_for_gets_no_clef_key(self):
        _, run = self.start()
        env = self.node_env(run)
        self.assertEqual((env.get("TYPESAFE_API_BASE"), env.get("TYPESAFE_API_KEY")), ("http://127.0.0.1:9", "placeholder"), "a key in the environment is one the Keychain is never asked for")

    def test_a_named_model_or_an_opt_in_is_what_the_node_gets(self):
        _, run = self.start(MODEL_BASE="http://127.0.0.1:18790")
        self.assertEqual(self.node_env(run).get("TYPESAFE_API_BASE"), "http://127.0.0.1:18790")
        _, run = self.start(CLEF_OPT_IN="1")
        env = self.node_env(run)
        self.assertNotIn("TYPESAFE_API_KEY", env, "opted in: the node looks for the owner's key, as an owner's node does")
        self.assertNotIn("TYPESAFE_API_BASE", env)


class ShimRefusalTests(unittest.TestCase):
    """decision_shim.py at its one trust boundary: whatever on this machine can reach its port."""

    def serve(self, asker=None):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        self.asked = []

        def ask(prompt):
            self.asked.append(prompt)
            return (asker or (lambda: '{"goal": {"choice": "3", "confidence": 0.8}}'))(), "fake"

        server = decision_shim.server(decision_shim.Shim("sonnet", Path(folder, "log.jsonl"), ask))
        self.addCleanup(server.server_close)
        threading.Thread(target=server.handle_request, daemon=True).start()
        return f"http://127.0.0.1:{server.server_address[1]}/v1/systemone", server

    def post(self, url, data, **headers):
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                return reply.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_a_request_from_a_web_page_is_refused_and_costs_no_call(self):
        url, _ = self.serve()
        self.assertEqual(self.post(url, json.dumps({"questions": ShimTests.GOAL}).encode(), Origin="https://evil.test"), 403)
        self.assertEqual(self.asked, [])

    def test_a_body_that_isnt_an_object_is_refused(self):
        for body in (b"[1, 2]", b"3", b"null"):
            url, _ = self.serve()
            self.assertEqual(self.post(url, body), 400, body)

    def test_questions_of_the_wrong_shape_are_an_error_not_a_crash(self):
        shim = decision_shim.Shim("sonnet", Path(tempfile.mkdtemp(), "log.jsonl"), lambda prompt: ('{"goal": {"choice": "3"}}', "fake"))
        self.addCleanup(shutil.rmtree, shim.log.parent)
        for questions in ({"goal": "not an object"}, {"goal": {"type": "choice", "criteria": 3}}):
            status, reply = shim.answer({"questions": questions})
            self.assertEqual(status, 503, reply)
            self.assertIn("error", reply)

    def test_a_client_that_stops_sending_is_let_go(self):
        _, server = self.serve()
        self.assertEqual(server.RequestHandlerClass.timeout, 30)


class StubSite:
    """A site on this machine with the shapes the Eden report met: a data call with an `ajax` key, a term in a POST's body, a
    list that only streams, a guest count of one digit, and a wall. Every request is kept, so a test can say how often the
    node asked a wall."""

    ITEMS = lambda q: {"items": [{"title": f"{q} model {n}", "price": f"${10 + n}.99"} for n in range(6)], "total": 6}
    SHELL = "<!doctype html><title>Search {q}</title><h1>Shop</h1><div id=r></div><script>{js}</script>"

    def __init__(self):
        self.hits = hits = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def send(self, status, kind, text):
                data = text.encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                parts = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(parts.query))
                hits.append(("GET", parts.path))
                segments = [urllib.parse.unquote(p) for p in parts.path.split("/") if p]
                q = query.get("q", "")
                render = "r.innerText=JSON.stringify(j.items.map(i=>i.title))"
                if parts.path == "/shop/search":
                    js = f"const r=document.getElementById('r');fetch('/api/items?ajax=1&q='+encodeURIComponent({json.dumps(q)})).then(a=>a.json()).then(j=>{{{render}}})"
                    return self.send(200, "text/html", StubSite.SHELL.format(q=q, js=js))
                if parts.path == "/api/items" and "ajax" in query:
                    return self.send(200, "application/json", json.dumps(StubSite.ITEMS(q)))
                if parts.path == "/api/items":
                    return self.send(200, "text/html", "<!doctype html><title>Shop</title><p>Home</p><p>About</p><p>Contact</p>")
                if len(segments) == 3 and segments[:2] == ["market", "search"]:
                    js = f"const r=document.getElementById('r');fetch('/aps/certified-search/',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{filters:{{query:{json.dumps(segments[2])}}}}})}}).then(a=>a.json()).then(j=>{{{render}}})"
                    return self.send(200, "text/html", StubSite.SHELL.format(q=segments[2], js=js))
                if parts.path == "/flights":
                    js = "const r=document.getElementById('r');fetch('/restapi/FlightListSSE',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dcity:" + json.dumps(query.get("dcity", "")) + "})}).then(a=>a.text()).then(t=>{r.innerText=t})"
                    return self.send(200, "text/html", StubSite.SHELL.format(q=query.get("dcity", ""), js=js))
                if parts.path == "/stays":
                    rows = "".join(f"<li>{query.get('city')} stay {n}, {query.get('adults')} guests, $1{n}0 a night</li>" for n in range(6))
                    return self.send(200, "text/html", f"<!doctype html><title>Stays</title><ul>{rows}</ul>")
                if parts.path == "/gone":
                    return self.send(404, "text/html", "<!doctype html><title>Not found</title><h1>This page doesn't exist</h1><p>Home</p><p>About</p>")
                if parts.path == "/wall":
                    return self.send(403, "text/html", "<!doctype html><title>Just a moment...</title><h1>Verify you are human</h1><input type=checkbox aria-label='Verify you are human'><div class=cf-turnstile></div>")
                return self.send(404, "text/plain", "nothing here")

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                hits.append(("POST", self.path))
                said = json.loads(body or b"{}")
                if self.path == "/aps/certified-search/":
                    return self.send(200, "application/json", json.dumps(StubSite.ITEMS(said["filters"]["query"])))
                if self.path == "/restapi/FlightListSSE":
                    events = "".join(f"data: {json.dumps({'flights': [{'name': f'Air {said.get('dcity')} {n}', 'price': 200 + n}]})}\n\n" for n in range(6))
                    return self.send(200, "text/event-stream", events)
                return self.send(404, "text/plain", "nothing here")

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def stub_picker(prompt):
    """In the shim's place of the CLI: picks the first call that answers with data, sure of itself, and says yes to a
    piece of an address only where it follows `search` or the page is flights."""
    body = json.loads(prompt)
    rows = {str(r.get("index")): r for r in (body["state"] or {}).get("exchanges") or []}
    out = {}
    for qid, question in body["questions"].items():
        if question["type"] == "choice":
            keys = list(question["criteria"])
            data = [k for k in keys if "json" in rows.get(k, {}).get("mime", "") or "event-stream" in rows.get(k, {}).get("mime", "")]
            key = (data or keys)[0]
            out[qid] = {"choice": key, "probabilities": {key: 0.95}, "confidence": 0.9}
        else:
            index = qid.removeprefix("p")
            row = rows.get(index)
            out[qid] = {"noul": 0.9 if row is None or "html" not in row.get("mime", "") else 0.1, "confidence": 0.9}
    return json.dumps(out), "stub-picker"


E2E = os.environ.get("BANK_E2E")
E2E_WHY = "BANK_E2E=1 runs these against the built node and Chrome, on stub servers, with no network"


class ScratchNode:
    """scratch-node.sh's node on a stub model and, for these tests alone, a private network."""

    def __init__(self, model_base, port):
        self.dir = tempfile.mkdtemp(prefix="bk")
        env = dict(os.environ, PORT=str(port), MODEL_BASE=model_base, PRIVATE_NETWORK="true", ONE_ASK="1")
        subprocess.run(["sh", str(HERE / "scratch-node.sh"), self.dir], env=env, check=True, capture_output=True, timeout=200)
        self.node = Node(f"http://127.0.0.1:{port}", Path(self.dir, "token").read_text().strip())
        self.home = Path(self.dir, "home", "node")

    def files(self, model_log=None):
        return Files(self.home, Path(self.dir, "node.log"), Path(self.dir, "guard.log"), model_log)

    def close(self):
        subprocess.run(["kill", Path(self.dir, "node.pid").read_text().strip()], check=False)
        time.sleep(2)
        shutil.rmtree(self.dir, ignore_errors=True)


@unittest.skipUnless(E2E, E2E_WHY)
class FallbackOnANodeTests(unittest.TestCase):
    """Finding 8 end to end: the offline stub leaves out `type`, a real node reads it."""

    def test_a_reply_with_no_type_is_said_in_the_nodes_log(self):
        site, model = StubSite(), StubModel()
        self.addCleanup(site.close)
        self.addCleanup(model.close)
        scratch = ScratchNode(model.base, 17830)
        self.addCleanup(scratch.close)
        files = scratch.files()
        before = len(files.node_log_lines())
        status, reply = scratch.node.do("search the shop", f"{site.base}/shop/search?q=kettle")
        found = fallback_finding(len(model.requests), files.node_log_lines()[before:], reply.get("picked_by"))
        self.assertEqual(found["outcome"], "pass", (status, str(reply)[:400], found))


@unittest.skipUnless(E2E, E2E_WHY)
class ResourcesOnANodeTests(unittest.TestCase):
    """Finding 9 end to end, the one gap neither the node's ledger (docs/GENERALITY.md names close-on-error #482 with no
    test) nor the bank's offline tests covered: a learn that fails, at a missing page or at a wall, leaves no browser up,
    and the node stays inside the run's thresholds. Its own node, so nothing another test kept warm is counted. The
    hand-over browser a failed walk opens on a live site (`browse_<site>`) can't be reached here: the node refuses to
    browse this machine's own addresses, so that leak is checked only by a live run's `resources`."""

    def test_a_failed_learn_leaves_no_browser_running(self):
        site, model = StubSite(), StubModel()
        self.addCleanup(site.close)
        self.addCleanup(model.close)
        scratch = ScratchNode(model.base, 17836)
        self.addCleanup(scratch.close)
        files = scratch.files()
        for path in ("/gone?q=kettle", "/wall?q=teapot", "/gone?q=garden"):
            status, reply = scratch.node.do("search the stub", site.base + path)
            self.assertIsNone(reply.get("route"), (path, status, str(reply)[:300]))
        left = files.chrome_left()
        for _ in range(20):  # a walk's browser closes as its walk ends; give a closing one a moment
            if not left:
                break
            time.sleep(1)
            left = files.chrome_left()
        found = resources_finding(files.tree())
        print(f"\nafter three failed learns: chrome_left={left} resources={found}")
        self.assertEqual(left, 0, "a failed learn left its browser running")
        self.assertEqual(found["outcome"], "pass", found)


@unittest.skipUnless(E2E, E2E_WHY)
class FindingsOnANodeTests(unittest.TestCase):
    """The bank's findings reach a verdict on a real node, on the shapes of the report. They say what the node does: a
    `fail` here is the check working, so these assert a verdict and not a pass, and print each."""

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp(prefix="bkm")
        cls.log = Path(cls.folder, "model.jsonl")
        cls.site = StubSite()
        cls.shim = decision_shim.server(decision_shim.Shim("stub", cls.log, stub_picker))
        threading.Thread(target=cls.shim.serve_forever, daemon=True).start()
        cls.scratch = ScratchNode(f"http://127.0.0.1:{cls.shim.server_address[1]}", 17832)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.close()
        cls.shim.shutdown()
        cls.shim.server_close()
        cls.site.close()
        shutil.rmtree(cls.folder, ignore_errors=True)

    def run_case(self, path, values, goal, **case):
        built = dict(site="127.0.0.1", goal=goal, url=self.site.base + path, values=values, **case)
        result = run_site(self.scratch.node, built, "zqnonsense", self.scratch.files(self.log), gap=0.2, browser_program=default_browser_program(), one_ask=True)
        print(f"\n{path}: how={[c['how'] for c in result['checks']]} picked_by={result['model']['picked_by']} route={[c['path'] for c in result['checks']][:2]}")
        for name, finding in result["findings"].items():
            print(f"  {name:<13} {finding}")
        return result

    def verdict(self, result, name):
        self.assertIn(result["findings"][name]["outcome"], ("pass", "fail"), result["findings"][name])

    def test_a_data_call_with_a_key_the_page_never_sent(self):
        result = self.run_case("/shop/search?q={q}", ["kettle", "teapot", "garden hose"], "search shop items", expect=["price"])
        for name in ("warm_speed", "data_route", "correct", "keeps_pick", "inputs"):
            self.verdict(result, name)

    def test_a_search_term_in_a_post_body(self):
        result = self.run_case("/market/search/{q}/", ["iphone 15", "macbook air", "road bike"], "search market listings", expect=["price"])
        for name in ("data_route", "correct", "keeps_pick", "inputs"):
            self.verdict(result, name)

    def test_a_list_that_only_streams(self):
        result = self.run_case("/flights?dcity={q}", ["bjs", "sha", "can"], "search flights from a city", expect=["price"])
        for name in ("sse", "data_route", "correct"):
            self.verdict(result, name)

    def test_a_guest_count_of_one_digit(self):
        result = self.run_case("/stays?city={q}&adults=2", ["bangkok", "lisbon", "seoul"], "search stays", vary={"adults": "1"}, expect=["price"])
        for name in ("short_values", "inputs", "correct"):
            self.verdict(result, name)

    def test_a_wall_is_recorded_and_left_and_no_click_reaches_it(self):
        self.site.hits.clear()
        result = self.run_case("/wall?q={q}", ["kettle", "teapot", "garden hose"], "search the wall")
        hits = [h for h in self.site.hits if h[1] == "/wall"]
        guard = Path(self.scratch.dir, "guard.log").read_text()
        print(f"\nwall: asked {len(hits)} times; guard log: {sorted(set(l.split(' ')[0] for l in guard.splitlines()))}; how={[c['how'] for c in result['checks']]} {[c.get('why') for c in result['checks']]}")
        self.assertEqual(judge_site(result["checks"]), "blocked")
        self.assertEqual(result["stopped"], "blocked")
        self.assertNotIn("REFUSED_", guard, "with windows off nothing asks for one, and nothing reaches for a click")
        self.assertEqual(len(result["checks"]), 1, "one ask, then it moves on")
        self.assertLessEqual(len(hits), 2, "a plain request and one walk: no clean browser and no hand-over browser asked again")
        after_clean = guard.split("HELD_CLEAN", 1)[1] if "HELD_CLEAN" in guard else ""
        self.assertNotIn("chrome_headless_launch", after_clean, "no Chrome launch follows the held clean browser")

    def test_a_node_started_with_one_ask_satisfies_the_runs_check(self):
        self.assertIsNone(run_bank.one_ask_refusal(str(Path(self.scratch.dir, "node.log")), str(Path(self.scratch.dir, "guard.log"))))
        self.assertTrue(json.loads(Path(self.scratch.home, "settings.json").read_text())["private_network"])
        self.assertIn("shop.test", run_bank.private_node_refusal([dict(CASE, site="shop.test")], str(self.scratch.home), "unused/token"))


if __name__ == "__main__":
    unittest.main()
