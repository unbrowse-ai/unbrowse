import json
import unittest
from pathlib import Path

from tool_choice import judge, reached_the_node, report, tools_called, verdict


def init(*tools):
    return json.dumps({"type": "system", "subtype": "init", "tools": list(tools)})


def called(*names):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}] + [{"type": "tool_use", "name": n, "input": {}} for n in names]}})


NODE = "mcp__unbrowse__unbrowse_do"
WEB = {"id": "t", "wants": "unbrowse"}
CONTROL = {"id": "c", "wants": "none"}


class ToolChoice(unittest.TestCase):
    def test_the_first_web_tool_is_the_choice(self):
        self.assertTrue(judge(WEB, [called(NODE)])["pass"])
        self.assertTrue(judge(WEB, [called(NODE), called("WebFetch")])["pass"], "it went elsewhere only after the node")
        fetched = judge(WEB, [called("WebFetch"), called(NODE)])
        self.assertFalse(fetched["pass"], "the node as a fallback isn't the node chosen")
        self.assertEqual(fetched["first"], "WebFetch")

    def test_a_tool_that_isnt_the_web_doesnt_count(self):
        self.assertTrue(judge(WEB, [called("TodoWrite", NODE)])["pass"])

    def test_answering_from_memory_is_not_choosing_the_node(self):
        self.assertFalse(judge(WEB, [called()])["pass"])

    def test_a_task_with_no_website_stays_clear_of_the_node(self):
        self.assertTrue(judge(CONTROL, [called()])["pass"])
        self.assertTrue(judge(CONTROL, [called("WebSearch")])["pass"], "only the node is held to this")
        self.assertFalse(judge(CONTROL, [called(NODE)])["pass"])

    def test_a_line_that_isnt_json_is_passed_over(self):
        self.assertEqual(tools_called(["Warning: no stdin data", called(NODE), "[]"]), [NODE])

    def test_a_session_without_the_tools_says_nothing(self):
        self.assertFalse(reached_the_node([init("WebFetch", "WebSearch")]))
        self.assertFalse(reached_the_node([]))
        self.assertTrue(reached_the_node([init("WebFetch", NODE)]))

    def test_calling_the_node_on_everything_cant_pass(self):
        results = [judge(WEB, [called(NODE)]), judge(CONTROL, [called(NODE)])]
        self.assertFalse(verdict(results, 0.8)["pass"])

    def test_the_rate_decides_and_the_report_says_it(self):
        right, wrong = judge(WEB, [called(NODE)]), judge(WEB, [called("WebFetch")])
        self.assertTrue(verdict([right] * 4 + [wrong], 0.8)["pass"])
        result = verdict([right] * 3 + [wrong] * 2, 0.8)
        self.assertFalse(result["pass"])
        self.assertIn("3 of 5", report(result))

    def test_the_prompts_never_name_the_node(self):
        plan = json.loads(Path(__file__).with_name("tool-choice.json").read_text())
        self.assertTrue(any(t["wants"] == "none" for t in plan["tasks"]), "a control is what keeps the check honest")
        for task in plan["tasks"]:
            self.assertNotIn("unbrowse", task["prompt"].lower())
            self.assertIn(task["wants"], ("unbrowse", "none"))


if __name__ == "__main__":
    unittest.main()
