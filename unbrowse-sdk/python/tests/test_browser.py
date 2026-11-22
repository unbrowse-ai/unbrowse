"""``Browser``: each method sends the command the node's browser takes for it, with the arguments it was given and the
flags only when they were asked for, and keeps what the node says of the site and the routes it learned. Against a fake
node that answers each command with the words it was sent."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from node_fixture import TOKEN, StubNode  # noqa: E402

from unbrowse import UnbrowseNode  # noqa: E402

ROUTE = {"route_id": "send-message", "what": "send a message", "inputs": ["text"], "write": True}


class BrowserCommands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = StubNode(lambda m, p, q, h, body: (200, {"site": "shop.example", "output": " ".join(body["do"])}))
        cls.browser = UnbrowseNode(token=TOKEN, base_url=cls.stub.base, session="s1").browser(site="shop.example")

    @classmethod
    def tearDownClass(cls):
        cls.stub.close()

    def sent(self, call):
        call(self.browser)
        return self.stub.last()["body"]["do"]

    def test_each_method_sends_the_command_the_nodes_browser_takes_for_it(self):
        b = self.browser
        commands = {
            "click": (lambda b: b.click("@e1"), ["click", "@e1"]),
            "dblclick": (lambda b: b.dblclick("@e2"), ["dblclick", "@e2"]),
            "fill": (lambda b: b.fill("@e3", "me@example.com"), ["fill", "@e3", "me@example.com"]),
            "type": (lambda b: b.type("@e3", "abc"), ["type", "@e3", "abc"]),
            "press": (lambda b: b.press("Control+a"), ["press", "Control+a"]),
            "select": (lambda b: b.select("@e4", "red"), ["select", "@e4", "red"]),
            "check": (lambda b: b.check("@e5"), ["check", "@e5"]),
            "uncheck": (lambda b: b.uncheck("@e5"), ["uncheck", "@e5"]),
            "hover": (lambda b: b.hover("@e6"), ["hover", "@e6"]),
            "focus": (lambda b: b.focus("@e6"), ["focus", "@e6"]),
            "scroll_into_view": (lambda b: b.scroll_into_view("#footer"), ["scrollintoview", "#footer"]),
            "upload": (lambda b: b.upload("@e7", "/tmp/a.png", "/tmp/b.png"), ["upload", "@e7", "/tmp/a.png", "/tmp/b.png"]),
            "attr": (lambda b: b.attr("@e8", "href"), ["get", "attr", "@e8", "href"]),
            "is_": (lambda b: b.is_("visible", "@e9"), ["is", "visible", "@e9"]),
            "back": (lambda b: b.back(), ["back"]),
            "forward": (lambda b: b.forward(), ["forward"]),
            "reload": (lambda b: b.reload(), ["reload"]),
            "run": (lambda b: b.run("get", "title"), ["get", "title"]),
        }
        for name, (call, want) in commands.items():
            with self.subTest(name):
                self.assertEqual(self.sent(call), want)
        self.assertEqual(b.click("@e1").output, "click @e1", "the reply is the node's own")

    def test_get_reads_the_whole_page_or_one_element(self):
        self.assertEqual(self.sent(lambda b: b.get("title")), ["get", "title"])
        self.assertEqual(self.sent(lambda b: b.get("text", "@e1")), ["get", "text", "@e1"])

    def test_snapshot_adds_a_flag_for_each_option_it_is_given(self):
        self.assertEqual(self.sent(lambda b: b.snapshot()), ["snapshot"])
        self.assertEqual(self.sent(lambda b: b.snapshot(interactive=True, compact=True, depth=3, selector="#main")), ["snapshot", "-i", "-c", "-d", "3", "-s", "#main"])
        self.assertEqual(self.sent(lambda b: b.snapshot(depth=0)), ["snapshot", "-d", "0"], "a depth of 0 is a depth")

    def test_scroll_names_the_direction_and_only_the_distance_and_element_it_is_given(self):
        self.assertEqual(self.sent(lambda b: b.scroll("down")), ["scroll", "down"])
        self.assertEqual(self.sent(lambda b: b.scroll("up", 300, "#list")), ["scroll", "up", "300", "--selector", "#list"])
        self.assertEqual(self.sent(lambda b: b.scroll("left", 0)), ["scroll", "left", "0"])

    def test_find_names_how_to_find_what_to_do_and_only_the_options_it_is_given(self):
        self.assertEqual(self.sent(lambda b: b.find("label", "Email", "fill", "me@example.com")), ["find", "label", "Email", "fill", "me@example.com"])
        self.assertEqual(self.sent(lambda b: b.find("role", "button", "click", name="Submit", exact=True)), ["find", "role", "button", "click", "--name", "Submit", "--exact"])
        self.assertEqual(self.sent(lambda b: b.find("first", "li", "text", "")), ["find", "first", "li", "text", ""], "an empty value is a value")

    def test_wait_takes_a_time_an_element_or_any_of_the_conditions(self):
        self.assertEqual(self.sent(lambda b: b.wait(500)), ["wait", "500"])
        self.assertEqual(self.sent(lambda b: b.wait("#results")), ["wait", "#results"])
        self.assertEqual(self.sent(lambda b: b.wait(0)), ["wait", "0"])
        self.assertEqual(
            self.sent(lambda b: b.wait(text="Sent", url="**/done", load="networkidle", fn="window.ready", timeout_ms=5000)),
            ["wait", "--text", "Sent", "--url", "**/done", "--load", "networkidle", "--fn", "window.ready", "--timeout", "5000"],
        )

    def test_screenshot_names_a_path_and_the_flags_only_when_asked_for(self):
        self.assertEqual(self.sent(lambda b: b.screenshot()), ["screenshot"])
        self.assertEqual(self.sent(lambda b: b.screenshot("/tmp/page.png", full=True, annotate=True)), ["screenshot", "/tmp/page.png", "--full", "--annotate"])
        self.assertEqual(self.sent(lambda b: b.screenshot(full=True)), ["screenshot", "--full"])

    def test_the_session_a_step_goes_in_is_the_browsers_own(self):
        self.browser.hover("@e1")
        self.assertEqual(self.stub.last()["body"]["session"], "s1")


class BrowserState(unittest.TestCase):
    def setUp(self):
        self.stub = StubNode(self.reply)
        self.addCleanup(self.stub.close)
        self.browser = UnbrowseNode(token=TOKEN, base_url=self.stub.base, session="s1").browser(goal="send a message")

    def reply(self, m, p, q, h, body):
        verb = body["do"][0]
        out = {"site": "chat.example.com", "output": f"{verb} done"}
        if verb == "click":
            out["learned"] = [ROUTE]
        if verb == "open":
            out["route_for_goal"] = ROUTE
        return 200, out

    def test_what_a_step_learns_is_kept_once_and_the_site_it_names_is_remembered(self):
        self.assertEqual(self.browser.site, "")
        self.browser.click("@e1")
        self.browser.click("@e1")
        self.assertEqual([r.route_id for r in self.browser.learned], ["send-message"])
        self.assertEqual(self.browser.site, "chat.example.com")

    def test_the_route_for_the_goal_is_what_the_latest_open_found_even_when_it_found_none(self):
        self.browser.open("https://chat.example.com")
        self.assertEqual(self.browser.route_for_goal.route_id, "send-message")
        self.browser.click("@e1")
        self.assertEqual(self.browser.route_for_goal.route_id, "send-message", "a step that is not an open leaves it")
        self.stub.reply = lambda m, p, q, h, body: (200, {"site": "chat.example.com", "output": "opened"})
        self.browser.open("https://chat.example.com/other")
        self.assertIsNone(self.browser.route_for_goal)

    def test_opening_a_page_with_a_goal_keeps_the_goal_for_the_steps_after(self):
        self.browser.open("https://chat.example.com", goal="read the inbox")
        self.assertEqual(self.stub.last()["body"]["goal"], "read the inbox")
        self.browser.click("@e1")
        self.assertEqual(self.stub.last()["body"]["goal"], "read the inbox")

    def test_leaving_the_with_block_closes_a_browser_that_has_a_site_and_leaves_one_that_has_none(self):
        with self.browser:
            pass
        self.assertEqual(self.stub.seen, [], "no page was opened: nothing to close")
        with self.browser as b:
            b.click("@e1")
        self.assertEqual(self.stub.last()["body"]["do"], ["close"])

    def test_ask_owner_sends_what_it_needs_and_the_timeout_only_when_one_is_given(self):
        self.browser.ask_owner("a code", timeout_s=120)
        self.assertEqual(self.stub.last()["body"]["do"], ["ask_owner", "a code", "--timeout", "120"])
        self.browser.ask_owner("a code")
        self.assertEqual(self.stub.last()["body"]["do"], ["ask_owner", "a code"])


if __name__ == "__main__":
    unittest.main()
